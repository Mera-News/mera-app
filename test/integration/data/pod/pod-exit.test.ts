// Leaving a paired server: unpairing, the refusal path, and the wipes that unpair on their way. The server is
// the fake one; everything else is real.
jest.mock('expo-keep-awake', () => ({
  activateKeepAwakeAsync: jest.fn(async () => undefined),
  deactivateKeepAwake: jest.fn(),
}));

import '@/lib/scheduler/tasks/feed-sync-task';

import * as Sentry from '@sentry/react-native';
import { Q } from '@nozbe/watermelondb';

import { watermelonRowSink } from '@/lib/backup/adapters/watermelon-row-sink';
import database from '@/lib/database';
import { enqueueJob } from '@/lib/database/services/inference-job-service';
import { getSetting } from '@/lib/database/services/setting-service';
import { inferenceQueue, __setJobHandlerForTests } from '@/lib/inference/InferenceQueue';
import { _resetForTests as resetBreaker } from '@/lib/auth-failure-breaker';
import { POD_PAIRING_KEY } from '@/lib/own-services/keys';
import { forgetPairingAfterRefusal, revokeStoredPairing, unpairPod } from '@/lib/own-services/pod-pairing';
import { resetPodHealth } from '@/lib/own-services/pod-health';
import { ALL_JOB_TYPES, TASKS_PAUSED_WHILE_PAIRED, enterPodMode, leavePodMode, syncPod } from '@/lib/own-services/pod-runner';
import { forgetPairing, podPaired, podState, savePairing, type PodPairing } from '@/lib/own-services/pod-state';
import { reportSecrets, setReportSecrets } from '@/lib/own-services/report-secrets';
import { platform } from '@/lib/platform';
import { AppScheduler } from '@/lib/scheduler/AppScheduler';
import { useSchedulerStore } from '@/lib/scheduler/scheduler-store';
import { signOutAndWipe, wipeAllLocalUserData } from '@/lib/security/local-wipe';
import { useDatabaseStore } from '@/lib/stores/database-store';
import { useUserStore } from '@/lib/stores/user-store';
import {
  advanceUntilDone,
  delay,
  fakePod,
  http,
  HttpResponse,
  podSnapshotFrom,
  POD_URL,
  secureStoreDump,
  server,
  setAppState,
  signInFixtureAccount,
  useFakeClock,
} from '@/test/helpers';
import { cleanupFeedSync, recordOps, resetFeedSyncMemory, servePersona } from '../feed-sync/steps/support';
import { resetScheduler } from '../scheduler/core/support';

jest.setTimeout(60_000);

const TOKEN = 'pod-token-abcdef123456';
const HASHES_KEY = 'pod_sync_hashes';
const PAIRING: PodPairing = {
  v: 1, baseUrl: POD_URL, deviceId: 'device-1', token: TOKEN, podName: 'Home pod', pairedAt: 1,
  confirmed: { at: 1, privacyVersion: null }, state: 'active',
};

let pod: ReturnType<typeof fakePod>;
let logs: jest.SpyInstance[];
const realTurn = () => new Promise<void>((r) => setImmediate(r));
const until = async (cond: () => boolean | Promise<boolean>, ms = 5000) => {
  for (const start = Date.now(); !(await cond()); await realTurn()) if (Date.now() - start > ms) throw new Error('timed out');
};
const ids = async (table: string) => (await database.get(table as never).query().fetch()).map((r) => r.id).sort();
const hostCommand = () => platform('pod-exit test').podCommand;
const revokes = () => pod.requests.filter((r) => r.path === '/devices/revoke');

async function paired() {
  pod.snapshot = await podSnapshotFrom(() => watermelonRowSink.createRows('facts', [{ id: 'pod-fact-1', statement: 'Lives in Utrecht', created_at: 1, updated_at: 1 }]));
  await savePairing(PAIRING);
  await enterPodMode();
  await syncPod();
}

/** The sign-in a feed sync to Mera needs, with a server that answers it. */
async function readyForMera() {
  await signInFixtureAccount();
  useUserStore.setState({ userPersona: { _id: 'persona-1' } as never });
  useDatabaseStore.setState({ ready: true });
  server.use(servePersona({ topics: {} }));
}

beforeEach(async () => {
  resetScheduler();
  resetBreaker();
  resetFeedSyncMemory();
  resetPodHealth();
  podState.resetMemory();
  setAppState('active');
  pod = fakePod({ token: TOKEN });
  logs = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => jest.spyOn(console, m).mockImplementation(() => {}));
  (Sentry.addBreadcrumb as jest.Mock).mockClear();
});

afterEach(async () => {
  await leavePodMode();
  await forgetPairing();
  await inferenceQueue.stop();
  for (const t of ALL_JOB_TYPES) __setJobHandlerForTests(t, undefined);
  AppScheduler.dispose();
  cleanupFeedSync();
  setReportSecrets('pod', null);
  logs.forEach((s) => s.mockRestore());
  jest.restoreAllMocks();
});

describe('unpairing', () => {
  it('revokes, resumes the tasks, releases the queue, restores feed sync and forgets the server', async () => {
    await readyForMera();
    const original = AppScheduler.definition('feed-sync');
    await paired();
    expect(AppScheduler.definition('feed-sync')).not.toBe(original);
    const client = require('@/lib/apollo-client').default;
    client.cache.restore({ ROOT_QUERY: { __typename: 'Query', leftover: 1 } });
    const factsBefore = await ids('facts');
    const handler = jest.fn(async () => ({}));
    __setJobHandlerForTests('story_headline', handler);
    pod.requests.length = 0;
    const ops = recordOps();

    await unpairPod();

    expect(revokes()).toHaveLength(1);
    expect(revokes()[0].headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(pod.revoked.has(TOKEN)).toBe(true);
    for (const name of TASKS_PAUSED_WHILE_PAIRED) expect(AppScheduler.isPaused(name)).toBe(false);
    expect(AppScheduler.definition('feed-sync')).toBe(original);
    expect(hostCommand()).toBeUndefined();
    expect(podState.get()).toBeNull();
    expect(podPaired()).toBe(false);
    expect(secureStoreDump()[POD_PAIRING_KEY]).toBeUndefined();
    expect(await getSetting(HASHES_KEY)).toBeNull();
    expect(reportSecrets()).toEqual({ hosts: [], secrets: [] });
    await until(() => Object.keys(client.cache.extract()).length === 0);
    expect(await ids('facts')).toEqual(factsBefore);

    // A normal feed sync follows, and it goes to Mera.
    await until(async () => (await ops.count('GetArticleIdsForPersona')) >= 1);
    expect(pod.requests.filter((r) => r.path !== '/devices/revoke')).toEqual([]);

    // The queue is released: a job now runs on the phone.
    await enqueueJob('story_headline', {});
    await inferenceQueue.start();
    inferenceQueue.notify();
    await until(() => handler.mock.calls.length === 1);
    expect(await database.get('inference_jobs').query(Q.where('status', 'pending')).fetchCount()).toBe(0);
  });

  it('still completes on the phone when the server is down', async () => {
    await paired();
    pod.down();
    await unpairPod();
    expect(podState.get()).toBeNull();
    expect(podPaired()).toBe(false);
    expect(hostCommand()).toBeUndefined();
    for (const name of TASKS_PAUSED_WHILE_PAIRED) expect(AppScheduler.isPaused(name)).toBe(false);
  });

  it('with no account persona on the phone, unpairing starts no feed sync that could only fail', async () => {
    await paired();
    useUserStore.setState({ userPersona: null });
    const ops = recordOps();
    await unpairPod();
    await new Promise<void>((r) => setImmediate(r));
    expect(useSchedulerStore.getState().isRunning('feed-sync')).toBe(false);
    expect(await ops.count('GetArticleIdsForPersona')).toBe(0);
  });

  it('with the auth breaker open, unpairing leaves feed sync paused and asks Mera for nothing', async () => {
    await readyForMera();
    await paired();
    const ops = recordOps();
    // Three Mera 401s with a recheck that answers dead: the breaker stays open.
    server.use(http.get('*/api/auth/get-session', () => HttpResponse.json(null, { status: 401 })));
    const { isBreakerOpen, recordAuthFailure } = require('@/lib/auth-failure-breaker') as typeof import('@/lib/auth-failure-breaker');
    for (let i = 0; i < 3; i++) recordAuthFailure();
    for (let i = 0; i < 200 && !isBreakerOpen(); i++) await new Promise<void>((r) => setImmediate(r));
    expect(isBreakerOpen()).toBe(true);

    await unpairPod();

    expect(podPaired()).toBe(false);
    expect(AppScheduler.isPaused('feed-sync')).toBe(true);
    for (const name of TASKS_PAUSED_WHILE_PAIRED) expect(AppScheduler.isPaused(name)).toBe(false);
    await new Promise<void>((r) => setImmediate(r));
    expect(await ops.count('GetArticleIdsForPersona')).toBe(0);
  });

  it('still completes within five seconds when the server never answers', async () => {
    await paired();
    server.use(http.post(`${POD_URL}/devices/revoke`, () => delay('infinite')));
    useFakeClock('2026-01-01T00:00:00Z');
    let done = false;
    const p = unpairPod().then(() => (done = true));
    await jest.advanceTimersByTimeAsync(4_800);
    expect(done).toBe(false);
    await advanceUntilDone(p, 1_500);
    expect(done).toBe(true);
    expect(podState.get()).toBeNull();
    expect(hostCommand()).toBeUndefined();
  });

  it('does nothing harmful when nothing is paired', async () => {
    await unpairPod();
    expect(pod.requests).toEqual([]);
    expect(podPaired()).toBe(false);
  });

  it('the refusal path forgets the server and leaves the mode without a revoke', async () => {
    await paired();
    pod.requests.length = 0;
    await forgetPairingAfterRefusal();
    expect(revokes()).toEqual([]);
    expect(podState.get()).toBeNull();
    expect(hostCommand()).toBeUndefined();
    expect(await getSetting(HASHES_KEY)).toBeNull();
    for (const name of TASKS_PAUSED_WHILE_PAIRED) expect(AppScheduler.isPaused(name)).toBe(false);
  });
});

describe('revokeStoredPairing', () => {
  it('revokes the stored item even before the state was read, and keeps the item', async () => {
    await savePairing(PAIRING);
    pod.tokens.add(TOKEN);
    podState.resetMemory();
    await revokeStoredPairing();
    expect(pod.revoked.has(TOKEN)).toBe(true);
    expect(secureStoreDump()[POD_PAIRING_KEY]).toBeDefined();
  });

  it('never throws: not with the server down, not with an unreadable keychain, not with nothing stored', async () => {
    await revokeStoredPairing();
    await savePairing(PAIRING);
    pod.down();
    await expect(revokeStoredPairing()).resolves.toBeUndefined();
    pod.up();
    podState.resetMemory();
    const { failSecureStore, healSecureStore } = require('@/test/helpers');
    failSecureStore(POD_PAIRING_KEY, 'get');
    await expect(revokeStoredPairing()).resolves.toBeUndefined();
    healSecureStore();
    expect(pod.revoked.size).toBe(0);
  });
});

describe('the wipes', () => {
  /** Records whether the pairing item still existed when the revoke arrived. */
  function watchRevoke() {
    const state = { itemWhenRevoked: undefined as string | undefined, seen: 0 };
    server.use(
      http.post(`${POD_URL}/devices/revoke`, () => {
        state.seen += 1;
        state.itemWhenRevoked = secureStoreDump()[POD_PAIRING_KEY];
        pod.revoked.add(TOKEN);
        return HttpResponse.json({});
      }),
    );
    return state;
  }

  async function expectLeft(original: unknown) {
    expect(podState.get()).toBeNull();
    expect(podPaired()).toBe(false);
    expect(secureStoreDump()[POD_PAIRING_KEY]).toBeUndefined();
    expect(hostCommand()).toBeUndefined();
    for (const name of TASKS_PAUSED_WHILE_PAIRED) expect(AppScheduler.isPaused(name)).toBe(false);
    expect(AppScheduler.definition('feed-sync')).toBe(original);
    expect(await getSetting(HASHES_KEY)).toBeNull();
    expect(reportSecrets()).toEqual({ hosts: [], secrets: [] });
  }

  // The wipe resets every store; a reset that writes a shared setting would go to the server as a command.
  const commandsAfter = (since: number) => pod.requests.slice(since).filter((r) => r.path === '/commands');

  it.each([
    ['a logout', async () => (await import('@/lib/security/local-wipe')).signOutAndWipe()],
    ['an account deletion', async () => (await import('@/components/custom/config-mera/use-delete-account')).finishAccountDeletion()],
    ['an account switch', async () => (await import('@/lib/security/local-wipe')).wipeAllLocalUserData({ keepSession: true })],
  ])('%s sends the server no change at all: it leaves pod mode before any store resets', async (_n, wipe) => {
    await signInFixtureAccount();
    await paired();
    const since = pod.requests.length;
    await wipe();
    await new Promise<void>((r) => setImmediate(r));
    expect(commandsAfter(since)).toEqual([]);
    expect(pod.requests.slice(since).map((r) => r.path)).toEqual(['/devices/revoke']);
  });

  it('signing out while paired revokes before the key is deleted, then leaves everything', async () => {
    await signInFixtureAccount();
    const original = AppScheduler.definition('feed-sync');
    await paired();
    const watched = watchRevoke();

    await signOutAndWipe();

    expect(watched.seen).toBe(1);
    expect(watched.itemWhenRevoked).toContain(TOKEN);
    await expectLeft(original);
  });

  it('the account-switch wipe also revokes', async () => {
    const original = AppScheduler.definition('feed-sync');
    await paired();
    const watched = watchRevoke();

    await wipeAllLocalUserData({ keepSession: true });

    expect(watched.seen).toBe(1);
    expect(watched.itemWhenRevoked).toContain(TOKEN);
    await expectLeft(original);
  });

  it('a wipe with the server down still wipes', async () => {
    const original = AppScheduler.definition('feed-sync');
    await paired();
    pod.down();
    await wipeAllLocalUserData();
    await expectLeft(original);
  });
});

describe('what never appears', () => {
  it('no token, address or snapshot content in a log line, a breadcrumb or an error', async () => {
    await paired();
    const errors: unknown[] = [];
    pod.down();
    await unpairPod().catch((e) => errors.push(e));
    pod.up();
    await paired().catch((e) => errors.push(e));
    await wipeAllLocalUserData().catch((e) => errors.push(e));
    await revokeStoredPairing().catch((e) => errors.push(e));

    const seen = JSON.stringify([
      logs.flatMap((s) => s.mock.calls),
      (Sentry.addBreadcrumb as jest.Mock).mock.calls,
      errors.map((e) => ({ ...(e as object), message: (e as Error).message })),
    ]);
    for (const secret of [TOKEN, 'pod.own.test', 'Lives in Utrecht']) expect(seen).not.toContain(secret);
  });
});
