// The auth-failure breaker at its seams: GraphQL 401s through the real Apollo chain, the
// real auth client against the mock /get-session, the real user store, the real scheduler
// and the real install-boundary latch. Only Sentry (an edge) and the clock are faked.
//
// A recheck is the one GET /api/auth/get-session that carries `disableCookieCache=true`
// (getJwtToken's own getSession does not), so counting those counts re-checks.
import * as Sentry from '@sentry/react-native';
import Constants from 'expo-constants';
import {
  _getBreakerState,
  _resetForTests,
  onAppForeground,
  onNetworkReconnect,
  recordAuthFailure,
  recordAuthSuccess,
  recheckSession,
  withTaskAuthScope,
} from '@/lib/auth-failure-breaker';
import { AppVersionService } from '@/lib/app-version-service';
import { getJwtToken } from '@/lib/auth-client';
import { AppScheduler } from '@/lib/scheduler/AppScheduler';
import { __resetAuthReadQuarantineForTests } from '@/lib/security/install-boundary-latch';
import { secureStore } from '@/lib/utils/secure-store-adapter';
import { useUserStore } from '@/lib/stores/user-store';
import { appVersionInfo } from '@/test/mock-backend/fixtures/graphql/appConfig';
import {
  HttpResponse,
  failSecureStore,
  secureStoreDump,
  http,
  mockGql,
  mockGqlError,
  server,
  setAppState,
  signInFixtureAccount,
  useFakeClock,
} from '@/test/helpers';

const captureMessage = Sentry.captureMessage as jest.Mock;
const COOKIE_KEY = `${Constants.expoConfig?.slug || 'app'}_cookie`;
const DAY_MS = 86_400_000;

// What GET /get-session answers to a recheck. 'alive' falls through to the mock backend's
// own handler, which answers for the signed-in fixture account.
type Reply = 'alive' | 'dead' | '401' | '500' | 'offline';
type Scripted = Reply | (() => Promise<Reply>);

const tick = () => new Promise<void>((r) => setImmediate(r));

/** The script the one installed recheck handler (see beforeEach) answers from. */
let script: { replies: Scripted[]; seen: { hits: number; urls: string[] } };

/** Scripts the rechecks in order (the last reply repeats). Returns the recheck count. */
function scriptRecheck(...replies: Scripted[]) {
  script = { replies, seen: { hits: 0, urls: [] } };
  return script.seen;
}

const recheckHandler = http.get('*/api/auth/get-session', async ({ request }) => {
  if (!new URL(request.url).searchParams.has('disableCookieCache')) return undefined;
  const { replies, seen } = script;
  seen.urls.push(request.url);
  const next = replies[Math.min(seen.hits++, replies.length - 1)];
  const reply = typeof next === 'function' ? await next() : next;
  switch (reply) {
    case 'alive':
      return undefined;
    case 'dead':
      return HttpResponse.json(null);
    case '401':
      return HttpResponse.json({ code: 'UNAUTHORIZED', message: 'UNAUTHORIZED' }, { status: 401 });
    case '500':
      return HttpResponse.json({ message: 'boom' }, { status: 500 });
    case 'offline':
      return HttpResponse.error();
  }
});

/** A recheck that stays in flight until released. */
function holdRecheck() {
  let release!: (reply: Reply) => void;
  const answer = new Promise<Reply>((r) => (release = r));
  let enter!: () => void;
  const entered = new Promise<void>((r) => (enter = r));
  return {
    reply: () => {
      enter();
      return answer;
    },
    entered,
    release,
  };
}

/** Waits for the in-flight recheck and for its `.then` callback to run. */
async function settle() {
  for (let i = 0; i < 20_000 && _getBreakerState().recheckInFlight; i++) await tick();
  expect(_getBreakerState().recheckInFlight).toBe(false);
  await tick();
  await tick();
}

/** n GraphQL 401s through the real Apollo error link, each one a recordAuthFailure(). */
async function fail401(n = 1) {
  server.use(mockGqlError('AppVersionInfo', 'UNAUTHENTICATED', { statusCode: 401 }));
  for (let i = 0; i < n; i++) await AppVersionService.getVersionInfo().catch(() => null);
}

/** An error-free response through the real Apollo chain, i.e. recordAuthSuccess(). */
async function succeed() {
  server.use(mockGql('AppVersionInfo', { appVersionInfo: appVersionInfo }));
  await AppVersionService.getVersionInfo();
}

// The dead-session path flags for re-auth but never clears local auth (clearAuthStorage).
const notEjected = () => expect(Object.keys(secureStoreDump())).toContain(COOKIE_KEY);
const feedSyncPaused = () => AppScheduler.isPaused('feed-sync');
const needsReauth = () => useUserStore.getState().needsReauth;
const trippedEvents = () => captureMessage.mock.calls.filter(([m]) => m === 'Auth circuit breaker tripped');
const trippedExtra = () => trippedEvents()[0][1].extra;

/** Trips the breaker and lets the recheck decide. */
async function tripWith(...replies: Scripted[]) {
  const seen = scriptRecheck(...replies);
  await fail401(3);
  await settle();
  return seen;
}

beforeAll(() => {
  // The logger prints every captureMessage and scheduler pause through console.info.
  jest.spyOn(console, 'info').mockImplementation(() => {});
});

beforeEach(async () => {
  jest.clearAllMocks();
  _resetForTests();
  scriptRecheck('alive');
  server.use(recheckHandler);
  AppScheduler.resumeTask('feed-sync');
  useUserStore.setState({ needsReauth: false });
  setAppState('active');
  // Signed in: a cookie is on hand and the mock session is alive.
  await signInFixtureAccount();
});

describe('recordAuthFailure: tripping', () => {
  it('does not trip before the threshold (2 failures)', async () => {
    await fail401(2);
    expect(captureMessage).not.toHaveBeenCalled();
    expect(feedSyncPaused()).toBe(false);
    expect(_getBreakerState().breakerOpen).toBe(false);
  });

  it('repairs BEFORE pausing: the 3rd failure only drops the JWT and re-checks', async () => {
    // Warm the JWT cache, so a dropped cache shows as a second /token request.
    let tokenRequests = 0;
    server.use(
      http.get('*/api/auth/token', () => {
        tokenRequests++;
        return undefined;
      }),
    );
    await getJwtToken();
    await getJwtToken();
    expect(tokenRequests).toBe(1);

    const held = holdRecheck();
    const seen = scriptRecheck(held.reply);
    await fail401(3);
    await held.entered;

    expect(seen.hits).toBe(1);
    expect(new URL(seen.urls[0]).searchParams.get('disableCookieCache')).toBe('true');
    // Undecided: nothing paused, nothing reported.
    expect(captureMessage).not.toHaveBeenCalled();
    expect(feedSyncPaused()).toBe(false);

    held.release('alive');
    await settle();
    await getJwtToken();
    expect(tokenRequests).toBe(2);
  });

  it('threshold with a LIVE session: feed-sync is never paused, no Sentry event', async () => {
    await tripWith('alive');

    expect(feedSyncPaused()).toBe(false);
    expect(captureMessage).not.toHaveBeenCalled();
    expect(needsReauth()).toBe(false);
    expect(_getBreakerState().breakerOpen).toBe(false);
    expect(_getBreakerState().consecutiveFailures).toBe(0);
  });

  it('threshold with a DEAD session: pauses, captures once, flags needsReauth', async () => {
    await tripWith('dead');

    expect(captureMessage).toHaveBeenCalledTimes(1);
    expect(captureMessage).toHaveBeenCalledWith(
      'Auth circuit breaker tripped',
      expect.objectContaining({
        level: 'warning',
        tags: { source: 'auth-breaker', type: 'auth' },
        extra: expect.objectContaining({ consecutiveFailures: 3, recheck: 'dead' }),
      }),
    );
    expect(feedSyncPaused()).toBe(true);
    expect(needsReauth()).toBe(true);
    expect(_getBreakerState().breakerOpen).toBe(true);
  });

  it('does not re-capture or re-pause on a 4th failure while re-check pending', async () => {
    const held = holdRecheck();
    const seen = scriptRecheck(held.reply);

    await fail401(4); // the 3rd trips, the 4th lands while the re-check is in flight
    await held.entered;

    expect(seen.hits).toBe(1);
    expect(captureMessage).not.toHaveBeenCalled();
    expect(feedSyncPaused()).toBe(false);

    held.release('dead');
    await settle();

    // One event and one pause for the whole trip, whatever landed in between.
    expect(trippedEvents()).toHaveLength(1);
    expect(feedSyncPaused()).toBe(true);
  });

  it('does not act on a stale verdict when a success closed the breaker mid-re-check', async () => {
    // A success that lands while the re-check is out makes the verdict stale. Pausing on
    // it would leave feed-sync paused with the breaker closed, which nothing resumes.
    const held = holdRecheck();
    scriptRecheck(held.reply);

    await fail401(3);
    await held.entered;
    await succeed();
    expect(_getBreakerState().breakerOpen).toBe(false);

    held.release('dead');
    await settle();

    expect(feedSyncPaused()).toBe(false);
    expect(captureMessage).not.toHaveBeenCalled();
    expect(_getBreakerState().breakerOpen).toBe(false);
  });
});

describe('recordAuthSuccess: reset', () => {
  it('resets the counter so 2 + success + 2 does not trip', async () => {
    await fail401(2);
    await succeed();
    await fail401(2);

    expect(captureMessage).not.toHaveBeenCalled();
    expect(_getBreakerState().consecutiveFailures).toBe(2);
  });

  it('closes an open breaker and resumes feed-sync', async () => {
    await tripWith('dead');
    // A dead session is flagged for re-auth (not ejected), and the breaker stays open.
    expect(needsReauth()).toBe(true);
    notEjected();
    expect(feedSyncPaused()).toBe(true);

    await succeed();
    // The success clears the flag and resumes the poller.
    expect(needsReauth()).toBe(false);
    expect(feedSyncPaused()).toBe(false);
    expect(_getBreakerState().breakerOpen).toBe(false);
  });
});

describe('re-check outcomes', () => {
  it('alive session: resumes feed-sync, breaker closed, no reauth flag', async () => {
    AppScheduler.pauseTask('feed-sync'); // paused by something else: only a live recheck resumes it
    await tripWith('alive');

    expect(needsReauth()).toBe(false);
    notEjected();
    expect(feedSyncPaused()).toBe(false);
    expect(_getBreakerState().breakerOpen).toBe(false);
    expect(_getBreakerState().consecutiveFailures).toBe(0);
  });

  it('dead session (null data, no error): flags needsReauth, no eject', async () => {
    await tripWith('dead');

    expect(needsReauth()).toBe(true);
    notEjected();
    // The breaker stays open so feed-sync remains paused until re-login.
    expect(_getBreakerState().breakerOpen).toBe(true);
  });

  it('401 error: flags needsReauth, no eject', async () => {
    await tripWith('401');

    expect(needsReauth()).toBe(true);
    notEjected();
    expect(trippedExtra().recheck).toBe('dead');
  });

  it('network/offline error: does NOT flag reauth, breaker stays open', async () => {
    await tripWith('500');

    expect(needsReauth()).toBe(false);
    notEjected();
    expect(_getBreakerState().breakerOpen).toBe(true);
  });

  it('thrown error (offline): does NOT flag reauth, breaker stays open', async () => {
    await tripWith('offline');

    expect(needsReauth()).toBe(false);
    notEjected();
    expect(_getBreakerState().breakerOpen).toBe(true);
  });
});

describe('re-check dedupe', () => {
  it('does not start a second re-check while one is in flight', async () => {
    const held = holdRecheck();
    const seen = scriptRecheck(held.reply);

    await fail401(5); // trip on the 3rd, two more while pending
    await held.entered;
    expect(seen.hits).toBe(1);

    held.release('500'); // inconclusive, stays open
    await settle();
    expect(seen.hits).toBe(1);
  });

  it('recheckSession() joins the breaker\'s own in-flight run', async () => {
    const held = holdRecheck();
    const seen = scriptRecheck(held.reply);

    await fail401(3);
    await held.entered;
    const joined = recheckSession();
    held.release('alive');

    expect(await joined).toBe('alive');
    expect(seen.hits).toBe(1);
  });
});

describe('onAppForeground', () => {
  // Open, paused or not, no needsReauth flag: the state a foreground is meant to recover from.
  async function tripInconclusive() {
    await tripWith('500');
    expect(_getBreakerState().breakerOpen).toBe(true);
    AppScheduler.pauseTask('feed-sync'); // 'inconclusive' pauses nothing itself; the offline trip is paused by the caller
  }

  it('resumes only after a fresh getSession proves the session alive', async () => {
    await tripInconclusive();
    const held = holdRecheck();
    const seen = scriptRecheck(held.reply);

    onAppForeground();
    await held.entered;
    // Revalidates instead of resuming blind: while the question is out, nothing resumes.
    expect(feedSyncPaused()).toBe(true);
    expect(_getBreakerState().breakerOpen).toBe(true);

    held.release('alive');
    await settle();
    expect(seen.hits).toBe(1);
    expect(new URL(seen.urls[0]).searchParams.get('disableCookieCache')).toBe('true');
    expect(feedSyncPaused()).toBe(false);
    expect(_getBreakerState().breakerOpen).toBe(false);
    expect(_getBreakerState().consecutiveFailures).toBe(0);
  });

  it('returns synchronously: does not await the re-check', async () => {
    await tripInconclusive();
    const held = holdRecheck();
    const seen = scriptRecheck(held.reply);

    // AppScheduler._onForeground calls this inline; it must not block on a round-trip.
    expect(onAppForeground()).toBeUndefined();
    await held.entered;
    expect(seen.hits).toBe(1);
    expect(feedSyncPaused()).toBe(true);
    expect(_getBreakerState().breakerOpen).toBe(true);

    held.release('alive');
    await settle();
    expect(feedSyncPaused()).toBe(false);
  });

  it('leaves the breaker open when the foreground re-check is still inconclusive', async () => {
    await tripInconclusive();
    scriptRecheck('500');

    onAppForeground();
    await tick();
    await settle();

    expect(feedSyncPaused()).toBe(true);
    expect(_getBreakerState().breakerOpen).toBe(true);
  });

  it('VERIFIES but does not resume when needsReauth is set, and clears on alive', async () => {
    // The session was fine all along: a verdict that was wrong must be able to heal.
    await tripWith('dead');
    expect(needsReauth()).toBe(true);

    const seen = scriptRecheck('alive');
    onAppForeground();
    await tick();
    await settle();

    expect(seen.hits).toBe(1);
    expect(needsReauth()).toBe(false);
    expect(_getBreakerState().breakerOpen).toBe(false);
  });

  it('a still-dead session stays flagged and resumes NOTHING', async () => {
    // Resuming the poller on a dead session buys three more 401s and an immediate re-trip.
    await tripWith('dead');
    expect(feedSyncPaused()).toBe(true);

    const seen = scriptRecheck('dead');
    onAppForeground();
    await tick();
    await settle();

    expect(seen.hits).toBe(1);
    expect(feedSyncPaused()).toBe(true);
    expect(needsReauth()).toBe(true);
  });

  it('bounds the verification by its own cooldown', async () => {
    // A signed-out device answers 'dead' every time: one getSession per ten minutes.
    useFakeClock(Date.now());
    await tripWith('dead');
    const seen = scriptRecheck('dead');

    onAppForeground();
    await tick();
    await settle();
    expect(seen.hits).toBe(1);

    onAppForeground();
    await tick();
    onAppForeground();
    await tick();
    await settle();
    expect(seen.hits).toBe(1);

    // Past the 10 minute cooldown it asks again.
    jest.setSystemTime(Date.now() + 10 * 60_000 + 1_000);
    onAppForeground();
    await tick();
    await settle();
    expect(seen.hits).toBe(2);
  });

  it('resets the counter without a round-trip when the breaker never opened', async () => {
    const seen = scriptRecheck('alive');
    await fail401(2);

    onAppForeground();
    await tick();
    await tick();

    expect(_getBreakerState().consecutiveFailures).toBe(0);
    expect(seen.hits).toBe(0);
    expect(_getBreakerState().recheckInFlight).toBe(false);
  });

  it('is a no-op when the breaker is closed and counter is zero', async () => {
    const seen = scriptRecheck('alive');
    AppScheduler.pauseTask('feed-sync');

    onAppForeground();
    await tick();
    await tick();

    expect(seen.hits).toBe(0);
    expect(feedSyncPaused()).toBe(true); // nothing resumed it
  });
});

// AppScheduler._onNetworkReconnect skips paused tasks as its FIRST check, so only this
// hook can revive a breaker-paused feed-sync when connectivity returns.
describe('onNetworkReconnect', () => {
  async function tripInconclusive() {
    await tripWith('500');
    expect(_getBreakerState().breakerOpen).toBe(true);
    AppScheduler.pauseTask('feed-sync');
  }

  it('revalidates and resumes feed-sync once the session proves alive', async () => {
    await tripInconclusive();
    const seen = scriptRecheck('alive');

    onNetworkReconnect();
    await tick();
    await settle();

    expect(seen.hits).toBe(1);
    expect(new URL(seen.urls[0]).searchParams.get('disableCookieCache')).toBe('true');
    expect(feedSyncPaused()).toBe(false);
    expect(_getBreakerState().breakerOpen).toBe(false);
  });

  it('does NOT resume on a still-inconclusive re-check', async () => {
    await tripInconclusive();
    scriptRecheck('500');

    onNetworkReconnect();
    await tick();
    await settle();

    expect(feedSyncPaused()).toBe(true);
    expect(_getBreakerState().breakerOpen).toBe(true);
  });

  it('verifies a flagged session on reconnect but never resumes it', async () => {
    // Same split as onAppForeground: asking is one bounded request, resuming on a dead
    // session buys three more 401s and a re-trip.
    await tripInconclusive();
    useUserStore.setState({ needsReauth: true });
    const seen = scriptRecheck('dead');

    onNetworkReconnect();
    await tick();
    await settle();

    expect(seen.hits).toBe(1);
    expect(feedSyncPaused()).toBe(true);
  });

  it('is a no-op when the breaker never tripped: no round-trip per reconnect', async () => {
    const seen = scriptRecheck('alive');
    AppScheduler.pauseTask('feed-sync');

    onNetworkReconnect();
    await tick();
    await tick();

    expect(seen.hits).toBe(0);
    expect(feedSyncPaused()).toBe(true);
  });

  it('ignores the cooldown: an explicit reconnect always gets a fresh check', async () => {
    await tripInconclusive();
    const seen = scriptRecheck('500', 'alive');

    onNetworkReconnect();
    await tick();
    await settle();
    expect(seen.hits).toBe(1);

    // A second reconnect moments later (well inside the 60s cooldown) still asks:
    // connectivity genuinely changed.
    onNetworkReconnect();
    await tick();
    await settle();
    expect(seen.hits).toBe(2);
    expect(feedSyncPaused()).toBe(false);
  });
});

// MERA-APP-75: several unrelated causes all rendered as one opaque 'dead', and a session
// the app already knew was dead was re-reported on every cold start.
describe('no-credential: the re-check could not present anything', () => {
  // The launch race: the latch answers null to sync auth reads until the install boundary
  // decides, so the re-check goes out with no Cookie header and the server answers 200 with
  // no session. The same wire response as a dead session; the difference is on our side.
  async function tripNoCredential() {
    __resetAuthReadQuarantineForTests();
    return tripWith('dead');
  }

  it('asserts nothing: no Sentry event and no needsReauth flag', async () => {
    await tripNoCredential();

    expect(captureMessage).not.toHaveBeenCalled();
    expect(needsReauth()).toBe(false);
  });

  it('still pauses feed-sync and leaves the breaker open for a retry', async () => {
    // There is nothing to poll WITH, so the poller stops, but no verdict is persisted.
    await tripNoCredential();

    expect(feedSyncPaused()).toBe(true);
    expect(_getBreakerState().breakerOpen).toBe(true);
  });

  it('self-heals on foreground once the latch has released', async () => {
    // Never setting needsReauth is what keeps this door open.
    await tripNoCredential();
    expect(_getBreakerState().breakerOpen).toBe(true);

    // The install boundary decides: the cookie is visible again, the session was fine.
    await signInFixtureAccount();
    scriptRecheck('alive');
    onAppForeground();
    await tick();
    await settle();

    expect(feedSyncPaused()).toBe(false);
    expect(_getBreakerState().breakerOpen).toBe(false);
    expect(_getBreakerState().consecutiveFailures).toBe(0);
  });

  it('honours the 60s re-check cooldown after a no-credential outcome', async () => {
    useFakeClock(Date.now());
    await tripNoCredential();
    await signInFixtureAccount(); // latch released; the breaker is still open awaiting a retry
    const seen = scriptRecheck('alive');

    // A later failure must not hammer getSession: the bottom branch of recordAuthFailure is
    // cooldown-gated, and no-credential is no exception.
    await fail401();
    await tick();
    expect(seen.hits).toBe(0);

    // Past the 60s cooldown it re-asks.
    jest.setSystemTime(Date.now() + 61_000);
    await fail401();
    await tick();
    await settle();
    expect(seen.hits).toBe(1);
  });
});

describe('one event per dead-state transition', () => {
  it('reports the transition into the dead state', async () => {
    await tripWith('dead');
    expect(trippedEvents()).toHaveLength(1);
    expect(needsReauth()).toBe(true);
  });

  it('does NOT re-report a session already known dead, but still pauses', async () => {
    // The cold-start case: breaker state died with the last process, the verdict did not.
    useUserStore.setState({ needsReauth: true });
    await tripWith('dead');

    expect(captureMessage).not.toHaveBeenCalled();
    expect(feedSyncPaused()).toBe(true);
  });
});

describe('the event says WHICH cause it was', () => {
  it('a 200 with no session reports deadReason no-session', async () => {
    await tripWith('dead');

    expect(trippedExtra()).toMatchObject({ recheck: 'dead', deadReason: 'no-session', repeat: false });
  });

  it('an explicit 401 reports deadReason rejected, whatever we thought we sent', async () => {
    await tripWith('401');

    expect(trippedExtra().deadReason).toBe('rejected');
  });

  it('distinguishes an EXPIRED cookie from an absent one', async () => {
    // Nothing on the wire, latch inactive, but the keychain still holds an entry:
    // better-auth filtered it as expired. A real lapse, correctly dead.
    useFakeClock(Date.now());
    jest.setSystemTime(Date.now() + 31 * DAY_MS); // past the 30 day cookie
    await tripWith('dead');

    expect(trippedExtra().recheckBasis).toBe('expired');
    // STILL dead: unlike 'quarantined' and 'unreadable' it cannot recover without the user
    // signing in, so the banner is the only way out.
    expect(trippedExtra().recheck).toBe('dead');
    expect(needsReauth()).toBe(true);
  });

  it('emits recheckBasis, NOT credentialState (Sentry scrubs the old key)', async () => {
    await tripWith('dead');

    expect(trippedExtra()).toHaveProperty('recheckBasis');
    expect(trippedExtra()).not.toHaveProperty('credentialState');
    expect(trippedExtra().recheckBasis).toBe('present');
  });

  it('reports absent when the keychain holds nothing', async () => {
    // Signed out for real: no cookie was ever stored.
    await secureStore.deleteItemAsync(COOKIE_KEY);
    await tripWith('dead');

    expect(trippedExtra().recheckBasis).toBe('absent');
  });

  it('an unreadable keychain is no-credential, NOT dead', async () => {
    // A locked keychain recovers at the device's first unlock. The sync read swallows the
    // throw, so the app sends nothing and every request 401s; the credential is still THERE.
    failSecureStore(COOKIE_KEY, 'get');
    await tripWith('dead');

    expect(needsReauth()).toBe(false);
    expect(captureMessage).not.toHaveBeenCalled();
    expect(feedSyncPaused()).toBe(true);
  });

  it('keeps the pinned fingerprint', async () => {
    // captureMessage otherwise groups on an async stack and one string becomes four issues.
    await tripWith('dead');

    expect(trippedEvents()[0][1].fingerprint).toEqual(['auth-breaker-tripped']);
  });
});

describe('recordAuthSuccess does not retract a verdict it cannot have earned', () => {
  it('clears needsReauth when a credential was actually held', async () => {
    useUserStore.setState({ needsReauth: true });
    await succeed();
    expect(needsReauth()).toBe(false);
  });

  it('does NOT clear needsReauth when there was no cookie to authenticate with', async () => {
    // The Apollo success link fires for ANY error-free result, including operations that
    // carried no credential and needed none. Such a success is no evidence of a live session.
    __resetAuthReadQuarantineForTests();
    useUserStore.setState({ needsReauth: true });
    await succeed();
    expect(needsReauth()).toBe(true);
  });

  it('still resets the counter on a cookie-less success', () => {
    __resetAuthReadQuarantineForTests();
    recordAuthFailure();
    recordAuthSuccess();
    expect(_getBreakerState().consecutiveFailures).toBe(0);
  });
});

// A 401 inside the OS background run means an expired session or an unreadable keychain in
// a wake nobody is watching. It must never trip the breaker. A reader who opened mid-run
// is making real requests, and those still count.
describe('withTaskAuthScope', () => {
  it('ignores auth failures inside the task while the app is in the background', async () => {
    setAppState('background');
    await withTaskAuthScope(async () => {
      recordAuthFailure();
      recordAuthFailure();
      recordAuthFailure();
    });
    expect(_getBreakerState()).toEqual({ consecutiveFailures: 0, breakerOpen: false, recheckInFlight: false });
  });

  it('ignores GraphQL 401s the real Apollo link sees inside the task', async () => {
    setAppState('background');
    await withTaskAuthScope(() => fail401(3));
    expect(_getBreakerState()).toEqual({ consecutiveFailures: 0, breakerOpen: false, recheckInFlight: false });
  });

  it('still counts them when the reader has the app open', async () => {
    setAppState('active');
    await withTaskAuthScope(async () => {
      recordAuthFailure();
    });
    expect(_getBreakerState().consecutiveFailures).toBe(1);
  });

  it('counts again once the task scope has ended', async () => {
    setAppState('background');
    await withTaskAuthScope(async () => {});
    recordAuthFailure();
    expect(_getBreakerState().consecutiveFailures).toBe(1);
  });

  it('ends the scope even when the task throws', async () => {
    setAppState('background');
    await expect(
      withTaskAuthScope(async () => {
        throw new Error('x');
      }),
    ).rejects.toThrow('x');
    recordAuthFailure();
    expect(_getBreakerState().consecutiveFailures).toBe(1);
  });

  it('nested scopes: the outer one still shields after the inner one ends', async () => {
    setAppState('background');
    await withTaskAuthScope(async () => {
      await withTaskAuthScope(async () => {});
      recordAuthFailure();
    });
    expect(_getBreakerState().consecutiveFailures).toBe(0);
    recordAuthFailure();
    expect(_getBreakerState().consecutiveFailures).toBe(1);
  });

  it('overlapping scopes: the shield holds until the last one ends', async () => {
    setAppState('background');
    let endFirst!: () => void;
    const first = withTaskAuthScope(() => new Promise<void>((r) => (endFirst = r)));
    await withTaskAuthScope(async () => {});
    recordAuthFailure();
    expect(_getBreakerState().consecutiveFailures).toBe(0);
    endFirst();
    await first;
    recordAuthFailure();
    expect(_getBreakerState().consecutiveFailures).toBe(1);
  });
});
