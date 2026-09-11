// auth-failure-breaker.test.ts — unit tests for the 401/auth circuit breaker.
//
// The breaker lazy-requires ./auth-client and ./scheduler/AppScheduler inside
// its functions, so mocking those modules is enough — no import ordering games.

const mockCaptureMessage = jest.fn();
const mockAddBreadcrumb = jest.fn();

const mockGetSession = jest.fn();
const mockClearAuthStorage = jest.fn((..._args: any[]) => Promise.resolve());
const mockInvalidateJwtCache = jest.fn();
const mockSetNeedsReauth = jest.fn();
// Mutable so a test can put the store in the "already flagged for re-auth"
// state that onAppForeground must refuse to resume from. The `mock` prefix is
// load-bearing: babel-jest rejects other out-of-scope names in a mock factory.
let mockNeedsReauth = false;

const mockPauseTask = jest.fn();
const mockResumeTask = jest.fn();

// What `authLink` would put on the wire. Empty string = no Cookie header,
// which is what better-auth's expo client returns for an expired cookie AND
// for a read the install-boundary latch is quarantining.
const mockGetCookie = jest.fn(() => 'mera_session=abc');
// Mutable for the same reason as mockNeedsReauth: the `mock` prefix is
// load-bearing, babel-jest rejects other out-of-scope names in a factory.
let mockQuarantineActive = false;
const mockGetItemAsync = jest.fn(async (_key: string): Promise<string | null> => null);

jest.mock('../logger', () => ({
  __esModule: true,
  default: {
    captureMessage: (...args: any[]) => mockCaptureMessage(...args),
    addBreadcrumb: (...args: any[]) => mockAddBreadcrumb(...args),
  },
}));

jest.mock('../auth-client', () => ({
  authClient: {
    getSession: (...args: any[]) => mockGetSession(...args),
    getCookie: () => mockGetCookie(),
  },
  clearAuthStorage: (...args: any[]) => mockClearAuthStorage(...args),
  invalidateJwtCache: (...args: any[]) => mockInvalidateJwtCache(...args),
}));

jest.mock('../scheduler/AppScheduler', () => ({
  AppScheduler: {
    pauseTask: (...args: any[]) => mockPauseTask(...args),
    resumeTask: (...args: any[]) => mockResumeTask(...args),
  },
}));

jest.mock('../security/install-boundary-latch', () => ({
  isAuthReadQuarantineActive: () => mockQuarantineActive,
}));

jest.mock('../utils/secure-store-adapter', () => ({
  secureStore: {
    getItemAsync: (key: string) => mockGetItemAsync(key),
  },
}));

jest.mock('expo-constants', () => ({
  __esModule: true,
  default: { expoConfig: { slug: 'mera' } },
}));

jest.mock('../stores/user-store', () => ({
  useUserStore: {
    getState: () => ({
      needsReauth: mockNeedsReauth,
      setNeedsReauth: (...args: any[]) => mockSetNeedsReauth(...args),
    }),
  },
}));

import {
  recordAuthFailure,
  recordAuthSuccess,
  onAppForeground,
  onNetworkReconnect,
  _resetForTests,
  _getBreakerState,
} from '../auth-failure-breaker';

// Flush the microtask queue so the fire-and-forget re-check promise settles.
const flush = () => new Promise((r) => setImmediate(r));

beforeEach(() => {
  jest.clearAllMocks();
  _resetForTests();
  mockNeedsReauth = false;
  mockQuarantineActive = false;
  mockGetCookie.mockReturnValue('mera_session=abc');
  mockGetItemAsync.mockResolvedValue(null);
  // mockReset, not just clearAllMocks: `clear` empties recorded calls but does
  // NOT drain queued mockResolvedValueOnce values, so an unconsumed one from a
  // previous test leaks into the next and shows up as a wrong verdict far from
  // its cause.
  mockGetSession.mockReset();
  // Default: re-check finds a live session (so an incidental trip doesn't log out).
  mockGetSession.mockResolvedValue({ data: { session: { id: 's1' } } });
});

describe('recordAuthFailure — tripping', () => {
  it('does not trip before the threshold (2 failures)', () => {
    recordAuthFailure();
    recordAuthFailure();
    expect(mockCaptureMessage).not.toHaveBeenCalled();
    expect(mockPauseTask).not.toHaveBeenCalled();
    expect(_getBreakerState().breakerOpen).toBe(false);
  });

  it('repairs BEFORE pausing: the 3rd failure only drops the JWT and re-checks', async () => {
    // Repair-first ordering: nothing is paused and nothing is reported until
    // the server-truth re-check has had its say.
    recordAuthFailure();
    recordAuthFailure();
    recordAuthFailure();

    expect(mockInvalidateJwtCache).toHaveBeenCalledTimes(1);
    expect(mockGetSession).toHaveBeenCalledTimes(1);
    expect(mockGetSession).toHaveBeenCalledWith({ query: { disableCookieCache: true } });
    expect(mockCaptureMessage).not.toHaveBeenCalled();
    expect(mockPauseTask).not.toHaveBeenCalled();

    await flush();
  });

  it('threshold with a LIVE session: feed-sync is never paused, no Sentry event', async () => {
    mockGetSession.mockResolvedValueOnce({ data: { session: { id: 's1' } } });
    recordAuthFailure();
    recordAuthFailure();
    recordAuthFailure();
    await flush();

    expect(mockPauseTask).not.toHaveBeenCalled();
    expect(mockCaptureMessage).not.toHaveBeenCalled();
    expect(mockSetNeedsReauth).not.toHaveBeenCalledWith(true);
    expect(_getBreakerState().breakerOpen).toBe(false);
    expect(_getBreakerState().consecutiveFailures).toBe(0);
  });

  it('threshold with a DEAD session: pauses, captures once, flags needsReauth', async () => {
    mockGetSession.mockResolvedValueOnce({ data: null });
    recordAuthFailure();
    recordAuthFailure();
    recordAuthFailure();
    await flush();

    expect(mockCaptureMessage).toHaveBeenCalledTimes(1);
    expect(mockCaptureMessage).toHaveBeenCalledWith(
      'Auth circuit breaker tripped',
      expect.objectContaining({
        level: 'warning',
        tags: { source: 'auth-breaker', type: 'auth' },
        extra: expect.objectContaining({ consecutiveFailures: 3, recheck: 'dead' }),
      }),
    );
    expect(mockPauseTask).toHaveBeenCalledWith('feed-sync');
    expect(mockSetNeedsReauth).toHaveBeenCalledWith(true);
    expect(_getBreakerState().breakerOpen).toBe(true);
  });

  it('does not re-capture or re-pause on a 4th failure while re-check pending', async () => {
    // Make getSession hang so the re-check stays in flight across failure #4.
    let resolveSession: (v: unknown) => void = () => {};
    mockGetSession.mockReturnValueOnce(
      new Promise((res) => {
        resolveSession = res;
      }),
    );

    recordAuthFailure();
    recordAuthFailure();
    recordAuthFailure(); // trips, re-check in flight
    recordAuthFailure(); // #4 while pending — must be a no-op

    expect(mockGetSession).toHaveBeenCalledTimes(1);
    // Still undecided, so still nothing paused/reported.
    expect(mockCaptureMessage).not.toHaveBeenCalled();
    expect(mockPauseTask).not.toHaveBeenCalled();

    resolveSession({ data: null }); // dead
    await flush();

    // Exactly one event and one pause for the whole trip, regardless of the
    // extra failures that landed while the re-check was in flight.
    expect(mockCaptureMessage).toHaveBeenCalledTimes(1);
    expect(mockPauseTask).toHaveBeenCalledTimes(1);
  });

  it('does not act on a stale verdict when a success closed the breaker mid-re-check', async () => {
    // Deferring the pause until the re-check answers opens a window: if a
    // concurrent request succeeds first, the verdict we are holding is already
    // out of date. Pausing on it would leave feed-sync paused with the breaker
    // closed — a state nothing in the module resumes from.
    let resolveSession: (v: unknown) => void = () => {};
    mockGetSession.mockReturnValueOnce(
      new Promise((res) => {
        resolveSession = res;
      }),
    );

    recordAuthFailure();
    recordAuthFailure();
    recordAuthFailure(); // trips, re-check in flight

    recordAuthSuccess(); // another query came back fine
    expect(_getBreakerState().breakerOpen).toBe(false);

    resolveSession({ data: null }); // stale "dead" verdict lands afterwards
    await flush();

    expect(mockPauseTask).not.toHaveBeenCalled();
    expect(mockCaptureMessage).not.toHaveBeenCalled();
    expect(_getBreakerState().breakerOpen).toBe(false);
  });
});

describe('recordAuthSuccess — reset', () => {
  it('resets the counter so 2 + success + 2 does not trip', () => {
    recordAuthFailure();
    recordAuthFailure();
    recordAuthSuccess();
    recordAuthFailure();
    recordAuthFailure();

    expect(mockCaptureMessage).not.toHaveBeenCalled();
    expect(_getBreakerState().consecutiveFailures).toBe(2);
  });

  it('closes an open breaker and resumes feed-sync', async () => {
    // Trip with a re-check that finds the session dead (so it stays open until success).
    mockGetSession.mockResolvedValueOnce({ data: null });
    recordAuthFailure();
    recordAuthFailure();
    recordAuthFailure();
    await flush();
    // dead session -> needsReauth flagged (NOT ejected), breaker still open
    expect(mockClearAuthStorage).not.toHaveBeenCalled();
    expect(mockSetNeedsReauth).toHaveBeenCalledWith(true);

    recordAuthSuccess();
    // success clears the reauth flag and resumes the poller
    expect(mockSetNeedsReauth).toHaveBeenLastCalledWith(false);
    expect(mockResumeTask).toHaveBeenCalledWith('feed-sync');
    expect(_getBreakerState().breakerOpen).toBe(false);
  });
});

describe('re-check outcomes', () => {
  it('alive session → resume feed-sync, breaker closed, no reauth flag', async () => {
    mockGetSession.mockResolvedValueOnce({ data: { session: { id: 's1' } } });
    recordAuthFailure();
    recordAuthFailure();
    recordAuthFailure();
    await flush();

    expect(mockClearAuthStorage).not.toHaveBeenCalled();
    expect(mockSetNeedsReauth).not.toHaveBeenCalledWith(true);
    expect(mockResumeTask).toHaveBeenCalledWith('feed-sync');
    expect(_getBreakerState().breakerOpen).toBe(false);
    expect(_getBreakerState().consecutiveFailures).toBe(0);
  });

  it('dead session (null data, no error) → flags needsReauth, no eject', async () => {
    mockGetSession.mockResolvedValueOnce({ data: null });
    recordAuthFailure();
    recordAuthFailure();
    recordAuthFailure();
    await flush();

    expect(mockClearAuthStorage).not.toHaveBeenCalled();
    expect(mockSetNeedsReauth).toHaveBeenCalledWith(true);
    // breaker stays open so feed-sync remains paused until re-login
    expect(_getBreakerState().breakerOpen).toBe(true);
  });

  it('401 error → flags needsReauth, no eject', async () => {
    mockGetSession.mockResolvedValueOnce({ data: null, error: { status: 401 } });
    recordAuthFailure();
    recordAuthFailure();
    recordAuthFailure();
    await flush();

    expect(mockClearAuthStorage).not.toHaveBeenCalled();
    expect(mockSetNeedsReauth).toHaveBeenCalledWith(true);
  });

  it('network/offline error → does NOT flag reauth, breaker stays open', async () => {
    mockGetSession.mockResolvedValueOnce({ data: null, error: { status: 0 } });
    recordAuthFailure();
    recordAuthFailure();
    recordAuthFailure();
    await flush();

    expect(mockClearAuthStorage).not.toHaveBeenCalled();
    expect(mockSetNeedsReauth).not.toHaveBeenCalledWith(true);
    expect(_getBreakerState().breakerOpen).toBe(true);
  });

  it('thrown error (offline) → does NOT flag reauth, breaker stays open', async () => {
    mockGetSession.mockRejectedValueOnce(new Error('Network request failed'));
    recordAuthFailure();
    recordAuthFailure();
    recordAuthFailure();
    await flush();

    expect(mockClearAuthStorage).not.toHaveBeenCalled();
    expect(mockSetNeedsReauth).not.toHaveBeenCalledWith(true);
    expect(_getBreakerState().breakerOpen).toBe(true);
  });
});

describe('re-check dedupe', () => {
  it('does not start a second re-check while one is in flight', async () => {
    let resolveSession: (v: unknown) => void = () => {};
    mockGetSession.mockReturnValueOnce(
      new Promise((res) => {
        resolveSession = res;
      }),
    );

    recordAuthFailure();
    recordAuthFailure();
    recordAuthFailure(); // trip + start re-check
    // Additional failures while pending must not spawn more getSession calls.
    recordAuthFailure();
    recordAuthFailure();

    expect(mockGetSession).toHaveBeenCalledTimes(1);

    resolveSession({ data: null, error: { status: 500 } }); // inconclusive, stays open
    await flush();
    expect(mockGetSession).toHaveBeenCalledTimes(1);
  });
});

describe('onAppForeground', () => {
  // Trip the breaker into the inconclusive (offline) state: open, paused, no
  // needsReauth flag — the state a foreground is supposed to recover from.
  async function tripInconclusive() {
    mockGetSession.mockResolvedValueOnce({ data: null, error: { status: 500 } });
    recordAuthFailure();
    recordAuthFailure();
    recordAuthFailure();
    await flush();
    expect(_getBreakerState().breakerOpen).toBe(true);
    jest.clearAllMocks();
  }

  it('resumes only after a fresh getSession proves the session alive', async () => {
    await tripInconclusive();

    onAppForeground();
    // Revalidates instead of resuming blind — the old unconditional resume is
    // what bought 3 more 401s and an immediate re-trip on every foreground.
    expect(mockGetSession).toHaveBeenCalledWith({ query: { disableCookieCache: true } });
    expect(mockResumeTask).not.toHaveBeenCalled();

    await flush();
    expect(mockResumeTask).toHaveBeenCalledWith('feed-sync');
    expect(_getBreakerState().breakerOpen).toBe(false);
    expect(_getBreakerState().consecutiveFailures).toBe(0);
  });

  it('returns synchronously — does not await the re-check', async () => {
    await tripInconclusive();

    let resolveSession: (v: unknown) => void = () => {};
    mockGetSession.mockReturnValueOnce(
      new Promise((res) => {
        resolveSession = res;
      }),
    );

    // AppScheduler._onForeground calls this inline; it must not block on a
    // network round-trip.
    onAppForeground();
    expect(mockGetSession).toHaveBeenCalledTimes(1);
    expect(mockResumeTask).not.toHaveBeenCalled();
    expect(_getBreakerState().breakerOpen).toBe(true);

    resolveSession({ data: { session: { id: 's1' } } });
    await flush();
    expect(mockResumeTask).toHaveBeenCalledWith('feed-sync');
  });

  it('leaves the breaker open when the foreground re-check is still inconclusive', async () => {
    await tripInconclusive();
    mockGetSession.mockResolvedValueOnce({ data: null, error: { status: 500 } });

    onAppForeground();
    await flush();

    expect(mockResumeTask).not.toHaveBeenCalled();
    expect(_getBreakerState().breakerOpen).toBe(true);
  });

  it('does nothing when needsReauth is already set — the banner is the recovery path', async () => {
    mockGetSession.mockResolvedValueOnce({ data: null }); // dead
    recordAuthFailure();
    recordAuthFailure();
    recordAuthFailure();
    await flush();
    expect(mockSetNeedsReauth).toHaveBeenCalledWith(true);
    mockNeedsReauth = true;
    jest.clearAllMocks();

    onAppForeground();
    await flush();

    expect(mockGetSession).not.toHaveBeenCalled();
    expect(mockResumeTask).not.toHaveBeenCalled();
    expect(_getBreakerState().breakerOpen).toBe(true);
  });

  it('resets the counter without a round-trip when the breaker never opened', async () => {
    recordAuthFailure();
    recordAuthFailure();

    onAppForeground();
    await flush();

    expect(_getBreakerState().consecutiveFailures).toBe(0);
    expect(mockGetSession).not.toHaveBeenCalled();
    expect(mockResumeTask).not.toHaveBeenCalled();
  });

  it('is a no-op when the breaker is closed and counter is zero', () => {
    onAppForeground();
    expect(mockResumeTask).not.toHaveBeenCalled();
    expect(mockGetSession).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// onNetworkReconnect
// ---------------------------------------------------------------------------
// AppScheduler._onNetworkReconnect skips paused tasks as its FIRST check, so the
// network-reconnect trigger can never revive a breaker-paused feed-sync on its
// own. Before this hook, recovery required a real background→foreground cycle or
// an unrelated successful query — so a user who lost signal for an hour and
// regained it without ever backgrounding the app stayed paused.
describe('onNetworkReconnect', () => {
  async function tripInconclusive() {
    mockGetSession.mockResolvedValueOnce({ data: null, error: { status: 500 } });
    recordAuthFailure();
    recordAuthFailure();
    recordAuthFailure();
    await flush();
    expect(_getBreakerState().breakerOpen).toBe(true);
    jest.clearAllMocks();
  }

  it('revalidates and resumes feed-sync once the session proves alive', async () => {
    await tripInconclusive();
    mockGetSession.mockResolvedValueOnce({ data: { session: { id: 's1' } } });

    onNetworkReconnect();
    expect(mockGetSession).toHaveBeenCalledWith({ query: { disableCookieCache: true } });

    await flush();
    expect(mockResumeTask).toHaveBeenCalledWith('feed-sync');
    expect(_getBreakerState().breakerOpen).toBe(false);
  });

  it('does NOT resume on a still-inconclusive re-check', async () => {
    await tripInconclusive();
    mockGetSession.mockResolvedValueOnce({ data: null, error: { status: 503 } });

    onNetworkReconnect();
    await flush();

    expect(mockResumeTask).not.toHaveBeenCalled();
    expect(_getBreakerState().breakerOpen).toBe(true);
  });

  it('refuses to self-heal a CONFIRMED-dead session', async () => {
    // Same guard as onAppForeground: resuming here would only buy
    // AUTH_FAILURE_THRESHOLD more 401s and an immediate re-trip. ReauthBanner is
    // the only way out of this state.
    await tripInconclusive();
    mockNeedsReauth = true;

    onNetworkReconnect();
    await flush();

    expect(mockGetSession).not.toHaveBeenCalled();
    expect(mockResumeTask).not.toHaveBeenCalled();
    mockNeedsReauth = false;
  });

  it('is a no-op when the breaker never tripped — no round-trip per reconnect', () => {
    onNetworkReconnect();
    expect(mockGetSession).not.toHaveBeenCalled();
    expect(mockResumeTask).not.toHaveBeenCalled();
  });

  it('ignores the cooldown — an explicit reconnect always gets a fresh check', async () => {
    await tripInconclusive();
    mockGetSession.mockResolvedValueOnce({ data: null, error: { status: 500 } });
    onNetworkReconnect();
    await flush();
    expect(mockGetSession).toHaveBeenCalledTimes(1);

    // A second reconnect moments later (well inside RECHECK_COOLDOWN_MS) must
    // still ask: connectivity genuinely changed, which is new information.
    mockGetSession.mockResolvedValueOnce({ data: { session: { id: 's1' } } });
    onNetworkReconnect();
    await flush();
    expect(mockGetSession).toHaveBeenCalledTimes(2);
    expect(mockResumeTask).toHaveBeenCalledWith('feed-sync');
  });
});

// ---------------------------------------------------------------------------
// MERA-APP-75. Two defects, one issue:
//
//  1. `recheck: 'dead'` was inferred from "the response carried no session",
//     which is ALSO what a request with no Cookie header gets back. better-auth's
//     expo client filters expired cookies client-side and the install-boundary
//     latch hides the keychain at launch, so several unrelated causes all
//     rendered as one opaque "dead".
//  2. The trip path had no already-dead guard (onAppForeground and
//     onNetworkReconnect both have one), so a session the app already knew was
//     dead was re-reported on every cold start.
// ---------------------------------------------------------------------------

describe('no-credential: the re-check could not present anything', () => {
  // The launch race: the latch answers null to sync auth reads until the
  // install boundary decides, so the re-check goes out with no Cookie header
  // and the server answers 200-with-no-session. Identical wire response to a
  // genuinely dead session; the difference is entirely on our side.
  async function tripNoCredential() {
    mockQuarantineActive = true;
    mockGetCookie.mockReturnValue('');
    mockGetSession.mockResolvedValueOnce({ data: null });
    recordAuthFailure();
    recordAuthFailure();
    recordAuthFailure();
    await flush();
  }

  it('asserts nothing: no Sentry event and no needsReauth flag', async () => {
    // The whole bug. Byte-identical server response to the "DEAD session" test
    // above; the only difference is that we had nothing to send.
    await tripNoCredential();

    expect(mockCaptureMessage).not.toHaveBeenCalled();
    expect(mockSetNeedsReauth).not.toHaveBeenCalledWith(true);
  });

  it('still pauses feed-sync and leaves the breaker open for a retry', async () => {
    // There is nothing to poll WITH, so the poller stops - but no verdict is
    // persisted, which is what keeps the recovery paths open below.
    await tripNoCredential();

    expect(mockPauseTask).toHaveBeenCalledWith('feed-sync');
    expect(_getBreakerState().breakerOpen).toBe(true);
  });

  it('self-heals on foreground once the latch has released', async () => {
    // The recovery loop this outcome depends on, and the reason it must NOT
    // set needsReauth: onAppForeground early-returns on that flag. Never
    // setting it is what keeps the door open.
    await tripNoCredential();
    expect(_getBreakerState().breakerOpen).toBe(true);
    jest.clearAllMocks();

    // Boundary released, real cookie visible again, session was fine all along.
    mockQuarantineActive = false;
    mockGetCookie.mockReturnValue('mera_session=abc');
    mockGetSession.mockResolvedValueOnce({ data: { session: { id: 's1' } } });

    onAppForeground();
    await flush();

    expect(mockResumeTask).toHaveBeenCalledWith('feed-sync');
    expect(_getBreakerState().breakerOpen).toBe(false);
    expect(_getBreakerState().consecutiveFailures).toBe(0);
  });

  it('honours the 60s re-check cooldown after a no-credential outcome', async () => {
    await tripNoCredential();
    jest.clearAllMocks();
    // Latch released; the breaker is still open awaiting a retry.
    mockQuarantineActive = false;
    mockGetCookie.mockReturnValue('mera_session=abc');

    // A later failure must not hammer getSession: the bottom branch of
    // recordAuthFailure is cooldown-gated, and no-credential is no exception.
    recordAuthFailure();
    expect(mockGetSession).not.toHaveBeenCalled();

    // Past RECHECK_COOLDOWN_MS (60s), it re-asks.
    const realNow = Date.now();
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(realNow + 61_000);
    try {
      recordAuthFailure();
      expect(mockGetSession).toHaveBeenCalledTimes(1);
    } finally {
      nowSpy.mockRestore();
    }
    await flush();
  });
});

describe('one event per dead-state transition', () => {
  async function tripDead() {
    mockGetSession.mockResolvedValueOnce({ data: null });
    recordAuthFailure();
    recordAuthFailure();
    recordAuthFailure();
    await flush();
  }

  it('reports the transition into the dead state', async () => {
    mockNeedsReauth = false;
    await tripDead();
    expect(mockCaptureMessage).toHaveBeenCalledTimes(1);
    expect(mockSetNeedsReauth).toHaveBeenCalledWith(true);
  });

  it('does NOT re-report a session already known dead, but still pauses', async () => {
    // The cold-start case: breaker state died with the last process, the
    // verdict did not. Re-earning the trip must not re-earn the event.
    mockNeedsReauth = true;
    await tripDead();

    expect(mockCaptureMessage).not.toHaveBeenCalled();
    expect(mockPauseTask).toHaveBeenCalledWith('feed-sync');
  });
});

describe('the event says WHICH cause it was', () => {
  it('a 200 with no session reports deadReason no-session', async () => {
    mockGetSession.mockResolvedValueOnce({ data: null });
    recordAuthFailure();
    recordAuthFailure();
    recordAuthFailure();
    await flush();

    const extra = mockCaptureMessage.mock.calls[0][1].extra;
    expect(extra.recheck).toBe('dead');
    expect(extra.deadReason).toBe('no-session');
    expect(extra.repeat).toBe(false);
  });

  it('an explicit 401 reports deadReason rejected, whatever we thought we sent', async () => {
    mockGetSession.mockResolvedValueOnce({ data: null, error: { status: 401 } });
    recordAuthFailure();
    recordAuthFailure();
    recordAuthFailure();
    await flush();

    const extra = mockCaptureMessage.mock.calls[0][1].extra;
    expect(extra.deadReason).toBe('rejected');
  });

  it('distinguishes an EXPIRED cookie from an absent one', async () => {
    // Nothing on the wire, latch inactive, but the keychain still holds an
    // entry: better-auth filtered it as expired. A real lapse, correctly dead,
    // and now legible as such in Sentry.
    mockGetCookie.mockReturnValue('');
    mockQuarantineActive = false;
    mockGetItemAsync.mockResolvedValue('{"mera_session":{"value":"x","expires":"2020-01-01"}}');
    mockGetSession.mockResolvedValueOnce({ data: null });
    recordAuthFailure();
    recordAuthFailure();
    recordAuthFailure();
    await flush();

    const extra = mockCaptureMessage.mock.calls[0][1].extra;
    expect(extra.credentialState).toBe('expired');
    expect(extra.recheck).toBe('dead');
  });

  it('reports absent when the keychain holds nothing', async () => {
    mockGetCookie.mockReturnValue('');
    mockQuarantineActive = false;
    mockGetItemAsync.mockResolvedValue(null);
    mockGetSession.mockResolvedValueOnce({ data: null });
    recordAuthFailure();
    recordAuthFailure();
    recordAuthFailure();
    await flush();

    expect(mockCaptureMessage.mock.calls[0][1].extra.credentialState).toBe('absent');
  });

  it('reports unreadable when the keychain read rejects', async () => {
    // A locked keychain still falls through to dead (closing that needs an
    // adapter-side signal), but it no longer does so anonymously.
    mockGetCookie.mockReturnValue('');
    mockQuarantineActive = false;
    mockGetItemAsync.mockRejectedValue(new Error('keychain locked'));
    mockGetSession.mockResolvedValueOnce({ data: null });
    recordAuthFailure();
    recordAuthFailure();
    recordAuthFailure();
    await flush();

    expect(mockCaptureMessage.mock.calls[0][1].extra.credentialState).toBe('unreadable');
  });

  it('keeps the pinned fingerprint', async () => {
    // Load-bearing: captureMessage otherwise groups on an async stack and one
    // string becomes four issues.
    mockGetSession.mockResolvedValueOnce({ data: null });
    recordAuthFailure();
    recordAuthFailure();
    recordAuthFailure();
    await flush();

    expect(mockCaptureMessage.mock.calls[0][1].fingerprint).toEqual(['auth-breaker-tripped']);
  });
});

describe('recordAuthSuccess does not retract a verdict it cannot have earned', () => {
  it('clears needsReauth when a credential was actually held', () => {
    mockGetCookie.mockReturnValue('mera_session=abc');
    recordAuthSuccess();
    expect(mockSetNeedsReauth).toHaveBeenCalledWith(false);
  });

  it('does NOT clear needsReauth when there was no cookie to authenticate with', () => {
    // The Apollo success link fires for ANY error-free result, including
    // operations that carried no credential and needed none. Such a success
    // cannot be evidence that our session is alive.
    mockGetCookie.mockReturnValue('');
    recordAuthSuccess();
    expect(mockSetNeedsReauth).not.toHaveBeenCalled();
  });
});
