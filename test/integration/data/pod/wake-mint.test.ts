// The phone's side of wake-ups: when it asks Mera for a pass, hands it to its own server, and how
// often it tries again. Servers are fakes; time is a settable `Date.now`, so real timers keep MSW flowing.
jest.mock('expo-keep-awake', () => ({
  activateKeepAwakeAsync: jest.fn(async () => undefined),
  deactivateKeepAwake: jest.fn(),
}));

import { createHash } from 'node:crypto';

import { enterPodMode, leavePodMode, syncPod, syncPodInWake, resetPodSyncGuard } from '@/lib/own-services/pod-runner';
import { forgetPairing, podState, savePairing } from '@/lib/own-services/pod-state';
import { resetPodHealth } from '@/lib/own-services/pod-health';
import { setWakeups, syncFromPodPush } from '@/lib/own-services/wakeups';
import { sameAuthOrigin } from '@/lib/own-services/wake-mint';
import { unpairPod } from '@/lib/own-services/pod-pairing';
import { POD_PAIRING_KEY } from '@/lib/own-services/keys';
import { wipeAllLocalUserData } from '@/lib/security/local-wipe';
import * as Sentry from '@sentry/react-native';
import { useUserStore } from '@/lib/stores/user-store';
import { AppScheduler } from '@/lib/scheduler/AppScheduler';
import { fakePod, podPairing, secureStoreDump, setAppState, signInFixtureAccount } from '@/test/helpers';
import { emptyKeychain } from '../background/support';
import { fakeMint } from '@/test/helpers/fake-pod';
import { recordRequests } from '@/test/helpers/wake-census';

jest.setTimeout(60_000);

const TOKEN = 'pod-token-abcdef123456';
const PUSH = 'ExponentPushToken[abcdefghijklmnop]';
const AUTH = process.env.EXPO_PUBLIC_AUTH_ENDPOINT!;
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

let pod: ReturnType<typeof fakePod>;
let mint: ReturnType<typeof fakeMint>;
let now = 0;

type Setup = { wakeups?: boolean; podWakeups?: 'on' | 'off' | 'disabled' | null; origin?: string; push?: string | null };
async function paired({ wakeups = true, podWakeups = 'off', origin = AUTH, push = PUSH }: Setup = {}) {
  pod.wakeups = podWakeups ?? undefined;
  pod.relayOrigin = origin;
  useUserStore.getState().setUserPersona(push ? ({ expoPushToken: push } as never) : null);
  await savePairing(podPairing({ token: TOKEN, ...(wakeups ? { wakeups: true } : {}) }));
  await enterPodMode();
}
const hash = (t: string) => createHash('sha256').update(t).digest().subarray(0, 16).toString('base64url');
const later = (ms: number) => void (now += ms);
const paths = (p: string) => pod.requests.filter((r) => r.path === p);

beforeEach(async () => {
  await signInFixtureAccount();
  now = Date.parse('2026-11-19T10:00:00Z');
  jest.spyOn(Date, 'now').mockImplementation(() => now);
  podState.resetMemory();
  resetPodHealth();
  resetPodSyncGuard();
  setAppState('active');
  pod = fakePod({ token: TOKEN });
  mint = fakeMint(AUTH);
});
afterEach(async () => {
  await leavePodMode();
  await forgetPairing();
  AppScheduler.dispose();
  useUserStore.getState().setUserPersona(null);
  jest.restoreAllMocks();
});

describe('wake-ups off', () => {
  it('sends no mint, no ping and not even a status request, across many foreground syncs', async () => {
    await paired({ wakeups: false });
    const census = recordRequests();
    for (let i = 0; i < 5; i++) {
      await syncPod();
      later(10 * MIN);
    }
    const seen = (await census.stop()).map((e) => e.path);
    expect(mint.requests).toHaveLength(0);
    expect(seen.filter((p) => p.endsWith('/ping-capability') || p === '/ping' || p === '/status')).toEqual([]);
    expect(seen.filter((p) => p === '/snapshot')).toHaveLength(5);
  });
});

describe('minting', () => {
  it('mints once and hands the pass to the server, across many foreground syncs with a valid pass', async () => {
    await paired();
    for (let i = 0; i < 6; i++) {
      await syncPod();
      later(6 * HOUR);
    }
    expect(mint.requests).toHaveLength(1);
    expect(mint.requests[0].body).toEqual({ pushTokenHash: hash(PUSH) });
    expect(mint.requests[0].body.pushTokenHash).toHaveLength(22);
    expect(paths('/ping')).toHaveLength(1);
    expect(paths('/ping')[0].body).toEqual({ capability: mint.issued[0], expiresAt: pod.pass!.expiresAt });
  });

  it('keeps the expiry, the token hash and the times, and never the pass or the push token', async () => {
    await paired();
    await syncPod();
    const item = podState.get()!;
    expect(item.wake).toMatchObject({ expiresAt: pod.pass!.expiresAt, tokenHash: hash(PUSH), mintedAt: now });
    const stored = JSON.stringify(item);
    expect(stored).not.toContain(mint.issued[0]);
    expect(stored).not.toContain(PUSH);
  });

  it('mints again before the pass runs out, and when the push token changed', async () => {
    await paired();
    await syncPod();
    later(10 * DAY);
    await syncPod();
    expect(mint.requests).toHaveLength(1);
    later(DAY);
    await syncPod();
    expect(mint.requests).toHaveLength(2);
    useUserStore.getState().setUserPersona({ expoPushToken: 'ExponentPushToken[another]' } as never);
    later(2 * DAY);
    pod.wakeups = 'on';
    await syncPod();
    expect(mint.requests).toHaveLength(3);
    expect(mint.requests[2].body).toEqual({ pushTokenHash: hash('ExponentPushToken[another]') });
  });

  it('mints again at most once a day when the server no longer holds the pass', async () => {
    await paired();
    await syncPod();
    pod.wakeups = 'off';
    later(HOUR);
    await syncPod();
    expect(mint.requests).toHaveLength(1);
    later(24 * HOUR);
    await syncPod();
    expect(mint.requests).toHaveLength(2);
  });

  it('never mints in a wake, or on a background launch', async () => {
    await paired();
    await syncPodInWake();
    expect(mint.requests).toHaveLength(0);
    setAppState('background');
    await syncPod();
    expect(mint.requests).toHaveLength(0);
    setAppState('active');
    await syncPod();
    expect(mint.requests).toHaveLength(1);
  });

  it.each([
    ['the server says disabled', { podWakeups: 'disabled' as const }],
    ['an older server that does not say', { podWakeups: null }],
    ['the server relays through another environment', { origin: 'https://auth.other.test' }],
    ['the phone has no push token yet', { push: null }],
  ])('does not mint when %s', async (_name, setup) => {
    await paired(setup);
    await syncPod();
    later(2 * DAY);
    await syncPod();
    expect(mint.requests).toHaveLength(0);
    expect(paths('/ping')).toHaveLength(0);
  });
});

describe('refusals', () => {
  it('401 waits for the next foreground', async () => {
    await paired();
    mint.queue.push({ status: 401, body: { message: 'Unauthorized' } });
    await syncPod();
    later(3 * DAY);
    await syncPod();
    expect(mint.requests).toHaveLength(1);
    setAppState('background');
    setAppState('active');
    await syncPod();
    expect(mint.requests).toHaveLength(2);
  });

  it('429 waits as long as X-Retry-After says', async () => {
    await paired();
    mint.queue.push({ status: 429, body: { message: 'Too many' }, headers: { 'X-Retry-After': '120' } });
    await syncPod();
    later(119_000);
    await syncPod();
    expect(mint.requests).toHaveLength(1);
    later(2_000);
    await syncPod();
    expect(mint.requests).toHaveLength(2);
    expect(paths('/ping')).toHaveLength(1);
  });

  it.each([
    [400, { error: 'bad_request' }],
    [404, { error: 'not_found' }],
    [409, { error: 'no_push_token' }],
    [409, { error: 'other_phone' }],
    [503, { error: 'unavailable' }],
  ])('%s allows one more try a day later and not before', async (status, body) => {
    await paired();
    mint.queue.push({ status, body });
    await syncPod();
    later(HOUR);
    await syncPod();
    later(22 * HOUR);
    await syncPod();
    expect(mint.requests).toHaveLength(1);
    later(2 * HOUR);
    await syncPod();
    expect(mint.requests).toHaveLength(2);
  });

  it('a server that will not take the pass is tried again no sooner than a day', async () => {
    await paired();
    pod.answer('/ping', 500, { error: 'boom' });
    await syncPod();
    later(HOUR);
    await syncPod();
    expect(mint.requests).toHaveLength(1);
    later(24 * HOUR);
    await syncPod();
    expect(mint.requests).toHaveLength(2);
    expect(pod.pass?.capability).toBe(mint.issued[1]);
  });
});

describe('turning wake-ups off', () => {
  it('tells the server at the next foreground sync, and again until it says off', async () => {
    await paired();
    await syncPod();
    expect(pod.wakeups).toBe('on');
    pod.answer('/ping', 500);
    await setWakeups(false); // the off sent at once fails
    expect(pod.wakeups).toBe('on');
    pod.answer('/ping', 500);
    await syncPod();
    expect(pod.wakeups).toBe('on');
    await syncPod();
    expect(pod.wakeups).toBe('off');
    expect(paths('/ping').slice(1).map((r) => r.body)).toEqual([{}, {}, {}]);
    const before = pod.requests.length;
    await syncPod();
    expect(pod.requests.slice(before).filter((r) => r.path === '/ping')).toEqual([]);
    expect(podState.get()?.wake).toBeUndefined();
    expect(mint.requests).toHaveLength(1);
  });

  it('sends the off at once, and keeps asking if that fails', async () => {
    await paired();
    await syncPod();
    pod.answer('/ping', 500);
    await setWakeups(false);
    expect(pod.wakeups).toBe('on');
    expect(podState.get()?.wake?.offPending).toBe(true);
    await syncPod();
    expect(pod.wakeups).toBe('off');
    await syncPod();
    expect(podState.get()?.wake).toBeUndefined();
  });
});

describe('the session', () => {
  it('the mint goes out signed in; signed out, Mera refuses it and the phone waits for the next foreground', async () => {
    await paired();
    await syncPod();
    expect(mint.requests.map((r) => r.session)).toEqual([true]);

    await emptyKeychain();
    pod.wakeups = 'off';
    later(2 * DAY);
    await syncPod();
    later(HOUR);
    await syncPod();
    expect(mint.requests.map((r) => r.session)).toEqual([true, false]);
  });
});

describe('the relay origin', () => {
  it.each([
    ['https://auth.mera.news', true],
    ['https://auth.mera.news/', true],
    ['HTTPS://AUTH.MERA.NEWS', true],
    ['https://auth.mera.news:443', true],
    [' https://auth.mera.news ', true],
    ['https://auth.mera.news:8443', false],
    ['http://auth.mera.news', false],
    ['https://auth.mera.news.evil.example', false],
    ['https://auth.mera.news@evil.example', false],
    ['https://evil.example/https://auth.mera.news', false],
    ['auth.mera.news', false],
    ['', false],
  ])('%s against https://auth.mera.news: %s', (relay, same) => {
    expect(sameAuthOrigin(relay, 'https://auth.mera.news')).toBe(same);
  });

  it('matches this build\'s own auth endpoint with a default port written out', () => {
    expect(sameAuthOrigin('http://127.0.0.1:80', 'http://127.0.0.1')).toBe(true);
    expect(sameAuthOrigin('https://auth.staging.mera.news', 'https://auth.mera.news')).toBe(false);
  });
});

describe('bounds', () => {
  it('a push token that keeps changing mints at most once a day while the pass is valid', async () => {
    await paired();
    await syncPod();
    for (const token of ['ExponentPushToken[b]', 'ExponentPushToken[c]', 'ExponentPushToken[d]']) {
      useUserStore.getState().setUserPersona({ expoPushToken: token } as never);
      later(HOUR);
      await syncPod();
    }
    expect(mint.requests).toHaveLength(1);
    later(DAY);
    await syncPod();
    expect(mint.requests).toHaveLength(2);
    expect(mint.requests[1].body).toEqual({ pushTokenHash: hash('ExponentPushToken[d]') });
  });

  it('asks for a pass only after a sync with the server succeeded', async () => {
    await paired();
    pod.answer('/snapshot', 500, { error: 'boom' });
    await syncPod().catch(() => undefined);
    expect(mint.requests).toHaveLength(0);
    await syncPod();
    expect(mint.requests).toHaveLength(1);
  });
});

describe('turning wake-ups off at once', () => {
  it('sends the off when the person turns wake-ups off, with no sync needed', async () => {
    await paired();
    await syncPod();
    const before = paths('/ping').length;
    await setWakeups(false);
    expect(paths('/ping').slice(before).map((r) => r.body)).toEqual([{}]);
    expect(pod.wakeups).toBe('off');
  });

  it('with the server unreachable, the phone ignores every wake and tells the server once it answers', async () => {
    await paired();
    await syncPod();
    pod.down();
    await expect(setWakeups(false)).resolves.toBeUndefined();
    expect(podState.get()?.wake?.offPending).toBe(true);
    const census = recordRequests();
    later(2 * MIN);
    await syncFromPodPush();
    expect(await census.stop()).toEqual([]);
    pod.up();
    await syncPod();
    expect(pod.wakeups).toBe('off');
    await syncPod();
    expect(podState.get()?.wake).toBeUndefined();
  });
});

describe('what is kept and what is said', () => {
  it('nothing about the pass, the token hash, the push token or the relay reaches a log or Sentry, on any path', async () => {
    const spies = (['debug', 'info', 'warn', 'error', 'log'] as const).map((m) => jest.spyOn(console, m).mockImplementation(() => {}));
    (Sentry.captureException as jest.Mock).mockClear();
    (Sentry.captureMessage as jest.Mock).mockClear();
    (Sentry.addBreadcrumb as jest.Mock).mockClear();
    await paired({ origin: AUTH });
    await syncPod();
    mint.queue.push({ status: 429, headers: { 'X-Retry-After': '5' } });
    pod.wakeups = 'off';
    later(2 * DAY);
    await syncPod();
    mint.queue.push({ status: 503, body: { error: 'unavailable' } });
    later(2 * DAY);
    await syncPod();
    pod.answer('/ping', 500, { error: 'boom' });
    later(2 * DAY);
    await syncPod();
    pod.down();
    await setWakeups(false);
    pod.up();
    await syncPod();

    const seen = JSON.stringify([
      spies.map((s) => s.mock.calls),
      (Sentry.captureException as jest.Mock).mock.calls,
      (Sentry.captureMessage as jest.Mock).mock.calls,
      (Sentry.addBreadcrumb as jest.Mock).mock.calls,
    ]);
    expect(mint.issued.length).toBeGreaterThan(0);
    for (const secret of [...mint.issued, hash(PUSH), PUSH, TOKEN, new URL(AUTH).host]) expect(seen).not.toContain(secret);
  });

  it('the wake record leaves with the pairing: unpairing and a wipe remove it', async () => {
    await paired();
    await syncPod();
    expect(podState.get()?.wake?.expiresAt).toBeDefined();
    await unpairPod();
    expect(secureStoreDump()[POD_PAIRING_KEY]).toBeUndefined();

    pod = fakePod({ token: TOKEN }); // the first server revoked this phone's token
    await paired();
    await syncPod();
    expect(podState.get()?.wake?.expiresAt).toBeDefined();
    await wipeAllLocalUserData({ keepSession: true });
    expect(secureStoreDump()[POD_PAIRING_KEY]).toBeUndefined();
    expect(podState.get()).toBeNull();
  });
});

