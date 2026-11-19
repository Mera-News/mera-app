// The silent-push task while the phone is paired to its own server: which pushes sync from the
// server, and which keep the routing they always had.
jest.mock('expo-task-manager', () => require('../background/native-fakes').taskManagerModule);
jest.mock('expo-background-task', () => require('../background/native-fakes').backgroundTaskModule);
jest.mock('expo-keep-awake', () => ({
  activateKeepAwakeAsync: jest.fn(async () => undefined),
  deactivateKeepAwake: jest.fn(),
}));

import * as TaskManager from 'expo-task-manager';

import { INFERENCE_TASK, defineInferenceTask } from '@/lib/background/inference-task';
import * as cycle from '@/lib/background/run-inference-handler';
import { forgetPairing, podConfig, podState, savePairing } from '@/lib/own-services/pod-state';
import { resetPodHealth } from '@/lib/own-services/pod-health';
import { unpairPod } from '@/lib/own-services/pod-pairing';
import { resetPodSyncGuard, syncPod } from '@/lib/own-services/pod-runner';
import { setWakeups, wakeupsOn } from '@/lib/own-services/wakeups';
import { advanceUntilDone, fakePod, http, HttpResponse, podPairing, POD_URL, server } from '@/test/helpers';
import { recordRequests } from '@/test/helpers/wake-census';
import { setSetting } from '@/lib/database/services/setting-service';
import { HAS_LAUNCHED_SETTING_KEY, __resetInstallBoundaryForTests } from '@/lib/security/install-boundary';
import { resetCycleWorld } from '@/test/integration/chat/jobs/support';
import { emptyKeychain } from '../background/support';

jest.setTimeout(60_000);

const TOKEN = 'pod-token-abcdef123456';

// Registered once, at load: the per-test mock reset would clear the call that holds the body.
defineInferenceTask();
const taskBody = (TaskManager.defineTask as jest.Mock).mock.calls.find((c) => c[0] === INFERENCE_TASK)![1] as (b: unknown) => Promise<unknown>;
const push = (data: Record<string, unknown>) => ({ data: { notification: { request: { content: { data } } } } });

beforeEach(async () => {
  podState.resetMemory();
  resetPodHealth();
  resetPodSyncGuard();
  await resetCycleWorld();
  // An install that has launched before, whose boundary has not run in this process yet.
  __resetInstallBoundaryForTests();
  await setSetting(HAS_LAUNCHED_SETTING_KEY, '1');
});
afterEach(() => {
  jest.restoreAllMocks();
  podState.resetMemory();
});

describe('push types', () => {
  const TYPES: [string, string | undefined, string][] = [
    ['inference-done', 'req-1', 'silent-push'],
    ['phase1-done', 'req-1', 'phase1-done'],
    ['phase2-done', 'req-1', 'phase2-done'],
    ['process-clusters', undefined, 'silent-push'],
    ['something-new', undefined, 'silent-push'],
    [undefined as unknown as string, undefined, 'silent-push'],
  ];

  it.each(TYPES)('not paired: type %s runs the %s id as the %s cycle', async (type, requestId, reason) => {
    const run = jest.spyOn(cycle, 'runBackgroundCycle').mockResolvedValue(undefined as never);
    await forgetPairing();
    await advanceUntilDone(taskBody(push({ type, requestId })));
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith(reason, requestId);
  });

  it.each(TYPES)('paired: type %s runs no cycle and asks the server for nothing', async (type, requestId) => {
    const run = jest.spyOn(cycle, 'runBackgroundCycle').mockResolvedValue(undefined as never);
    const pod = fakePod({ token: TOKEN });
    await savePairing(podPairing({ token: TOKEN }));
    podState.resetMemory();
    await advanceUntilDone(taskBody(push({ type, requestId })));
    expect(run).not.toHaveBeenCalled();
    expect(pod.requests).toEqual([]);
  });

  it('a body with no readable data runs the general cycle when not paired', async () => {
    const run = jest.spyOn(cycle, 'runBackgroundCycle').mockResolvedValue(undefined as never);
    await forgetPairing();
    await advanceUntilDone(taskBody({}));
    expect(run).toHaveBeenCalledWith('silent-push', undefined);
  });

  it('a malformed body on a paired phone with wake-ups on runs no cycle and asks nobody for anything', async () => {
    const run = jest.spyOn(cycle, 'runBackgroundCycle').mockResolvedValue(undefined as never);
    const pod = fakePod({ token: TOKEN });
    await savePairing(podPairing({ token: TOKEN, wakeups: true }));
    podState.resetMemory();
    const census = recordRequests();
    for (const body of [{}, { data: 'not an object' }, { data: { dataString: '{not json' } }, { data: { dataString: '"pod-sync"' } }]) {
      await advanceUntilDone(taskBody(body));
    }
    expect(await census.stop()).toEqual([]);
    expect(pod.requests).toEqual([]);
    expect(run).not.toHaveBeenCalled();
  });
});

/** The phone is paired with wake-ups `on`, the way a process that has just started finds it. */
async function pairedWith(over: { wakeups?: boolean } = {}) {
  const pod = fakePod({ token: TOKEN });
  await savePairing(podPairing({ token: TOKEN, ...over }));
  podState.resetMemory();
  return pod;
}
const podSync = () => push({ type: 'pod-sync' });
const snapshots = (pod: ReturnType<typeof fakePod>) => pod.requests.filter((r) => r.path === '/snapshot');

describe('pod-sync', () => {
  it('does nothing while signed out, unpaired, or with wake-ups off, and within 60 s of a sync', async () => {
    const run = jest.spyOn(cycle, 'runBackgroundCycle').mockResolvedValue(undefined as never);
    const census = recordRequests();

    // wake-ups off (the default)
    const pod = await pairedWith();
    await advanceUntilDone(taskBody(podSync()));
    // signed out
    await savePairing(podPairing({ token: TOKEN, wakeups: true }));
    podState.resetMemory();
    await emptyKeychain();
    await advanceUntilDone(taskBody(podSync()));
    // unpaired
    await forgetPairing();
    podState.resetMemory();
    await advanceUntilDone(taskBody(podSync()));

    expect(await census.stop()).toEqual([]);
    expect(pod.requests).toEqual([]);
    expect(run).not.toHaveBeenCalled();
  });

  it('syncs once from its own pod, and not again within 60 s of that sync', async () => {
    const pod = await pairedWith({ wakeups: true });
    const census = recordRequests();

    await advanceUntilDone(taskBody(podSync()));
    expect(snapshots(pod)).toHaveLength(1);

    await jest.advanceTimersByTimeAsync(30_000);
    await advanceUntilDone(taskBody(podSync()));
    expect(snapshots(pod)).toHaveLength(1);

    await jest.advanceTimersByTimeAsync(31_000);
    await advanceUntilDone(taskBody(podSync()));
    expect(snapshots(pod)).toHaveLength(2);
    expect((await census.stop()).map((e) => e.host)).toEqual(Array(2).fill(new URL(POD_URL).host));
  });

  it('does not start a second sync while one is running', async () => {
    const pod = await pairedWith({ wakeups: true });
    await Promise.all([advanceUntilDone(taskBody(podSync())), advanceUntilDone(taskBody(podSync()))]);
    expect(snapshots(pod)).toHaveLength(1);
  });

  it('one sync, bounded at 25 s', async () => {
    await pairedWith({ wakeups: true });
    server.use(http.post(`${POD_URL}/snapshot`, () => new Promise<Response>(() => undefined) as never));
    let done = false;
    const wake = taskBody(podSync()).then(() => (done = true));
    await jest.advanceTimersByTimeAsync(24_000);
    expect(done).toBe(false);
    await jest.advanceTimersByTimeAsync(1_500);
    await wake;
    expect(done).toBe(true);
  });

  it('sends no reporter event, even when it throws', async () => {
    await pairedWith({ wakeups: true });
    let asked = 0;
    server.use(http.post(`${POD_URL}/snapshot`, () => (asked += 1, HttpResponse.json({ error: 'boom' }, { status: 500 }))));
    const sentry = require('@sentry/react-native') as typeof import('@sentry/react-native');
    await advanceUntilDone(taskBody(podSync()));
    expect(sentry.captureException).not.toHaveBeenCalled();
    expect(sentry.captureMessage).not.toHaveBeenCalled();
    expect(asked).toBe(1);
  });

  it('a foreground sync counts toward the 60 s', async () => {
    const pod = await pairedWith({ wakeups: true });
    const { enterPodMode, leavePodMode } = await import('@/lib/own-services/pod-runner');
    await podState.hydrate();
    await enterPodMode();
    await syncPod();
    pod.requests.length = 0;
    await advanceUntilDone(taskBody(podSync()));
    expect(pod.requests).toEqual([]);
    await leavePodMode();
  });
});

describe('setting', () => {
  it('wake-ups default to off, and pairing erase and unpairing remove them', async () => {
    fakePod({ token: TOKEN });
    await savePairing(podPairing({ token: TOKEN }));
    expect(wakeupsOn()).toBe(false);

    await setWakeups(true);
    expect(wakeupsOn()).toBe(true);
    podState.resetMemory();
    await podState.hydrate();
    expect(wakeupsOn()).toBe(true);
    expect(podConfig()?.wakeups).toBe(true);

    await unpairPod();
    expect(wakeupsOn()).toBe(false);
    // a new pairing starts off
    await savePairing(podPairing({ token: TOKEN }));
    expect(wakeupsOn()).toBe(false);
  });

  it('turning it on needs a pairing', async () => {
    await forgetPairing();
    await expect(setWakeups(true)).rejects.toBeDefined();
    expect(wakeupsOn()).toBe(false);
  });
});
