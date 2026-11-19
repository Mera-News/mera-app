// Every host the phone contacts while a pod-sync push wakes it, by launch state: the pod's, and
// nothing else. Expo's update host is the one documented exception, and the native update check
// that reaches it runs before JavaScript, so it is not reachable from jest. See the open decision
// on `updates.checkAutomatically`.
jest.mock('expo-task-manager', () => require('../background/native-fakes').taskManagerModule);
jest.mock('expo-background-task', () => require('../background/native-fakes').backgroundTaskModule);
jest.mock('expo-keep-awake', () => ({
  activateKeepAwakeAsync: jest.fn(async () => undefined),
  deactivateKeepAwake: jest.fn(),
}));

import * as TaskManager from 'expo-task-manager';

import { INFERENCE_TASK, defineInferenceTask } from '@/lib/background/inference-task';
import { unpairForWipe } from '@/lib/own-services/pod-pairing';
import { resetPodHealth } from '@/lib/own-services/pod-health';
import { enterPodMode, leavePodMode, resetPodSyncGuard } from '@/lib/own-services/pod-runner';
import { forgetPairing, podState, savePairing } from '@/lib/own-services/pod-state';
import { advanceUntilDone, fakePod, http, HttpResponse, podPairing, POD_URL, server } from '@/test/helpers';
import { launchInBackground, launchInForeground, recordRequests } from '@/test/helpers/wake-census';
import { setSetting } from '@/lib/database/services/setting-service';
import { HAS_LAUNCHED_SETTING_KEY, __resetInstallBoundaryForTests } from '@/lib/security/install-boundary';
import { resetCycleWorld } from '@/test/integration/chat/jobs/support';

jest.setTimeout(60_000);

const TOKEN = 'pod-token-abcdef123456';
const POD_HOST = new URL(POD_URL).host;

defineInferenceTask();
const taskBody = (TaskManager.defineTask as jest.Mock).mock.calls.find((c) => c[0] === INFERENCE_TASK)![1] as (b: unknown) => Promise<unknown>;
const ios = { data: { notification: { request: { content: { data: { type: 'pod-sync' } } } } } };
const android = { data: { dataString: JSON.stringify({ type: 'pod-sync' }) } };

async function pairedWithWakeups() {
  const pod = fakePod({ token: TOKEN });
  await savePairing(podPairing({ token: TOKEN, wakeups: true }));
  podState.resetMemory();
  return pod;
}

beforeEach(async () => {
  podState.resetMemory();
  resetPodHealth();
  resetPodSyncGuard();
  await resetCycleWorld();
  // An install that has launched before, whose boundary has not run in this process yet.
  __resetInstallBoundaryForTests();
  await setSetting(HAS_LAUNCHED_SETTING_KEY, '1');
});
afterEach(async () => {
  await leavePodMode();
  await forgetPairing();
  podState.resetMemory();
  launchInForeground();
});

describe('wake', () => {
  // Expo's update host would be allowed here by the design; the native check never runs under jest.
  it('on an iOS cold start into pod-sync the app contacts no host but the pod\'s and Expo\'s update host', async () => {
    const pod = await pairedWithWakeups();
    launchInBackground();
    const census = recordRequests();
    await advanceUntilDone(taskBody(ios));
    const seen = await census.stop();
    expect(census.hosts()).toEqual([POD_HOST]);
    expect(seen.length).toBeGreaterThan(0);
    expect(pod.requests.length).toBe(seen.length);
  });

  it('on an Android headless start into pod-sync the app contacts no host but the pod\'s', async () => {
    await pairedWithWakeups();
    launchInBackground();
    const census = recordRequests();
    await advanceUntilDone(taskBody(android));
    await census.stop();
    expect(census.hosts()).toEqual([POD_HOST]);
  });

  it('on a warm wake with overdue timers the app contacts no host but the pod\'s', async () => {
    const pod = await pairedWithWakeups();
    await podState.hydrate();
    await enterPodMode();
    // Recording from before the timers fire: whatever they send in the wake counts.
    const census = recordRequests();
    launchInBackground();
    await jest.advanceTimersByTimeAsync(2 * 24 * 60 * 60 * 1000);
    await advanceUntilDone(taskBody(ios));
    await census.stop();
    expect(census.hosts()).toEqual([POD_HOST]);
    expect(pod.requests.length).toBeGreaterThan(0);
  });

  it('sign-out: with the pod unreachable, a pod-sync wake during the revoke sends nothing', async () => {
    const pod = await pairedWithWakeups();
    await podState.hydrate();
    let release: () => void = () => undefined;
    const held = new Promise<void>((r) => (release = r));
    server.use(http.post(`${POD_URL}/devices/revoke`, async () => (await held, HttpResponse.error())));
    const wipe = unpairForWipe();
    await jest.advanceTimersByTimeAsync(1_000);
    pod.requests.length = 0;
    const census = recordRequests();

    await advanceUntilDone(taskBody(ios));

    expect(await census.stop()).toEqual([]);
    release();
    await advanceUntilDone(wipe);
  });
});
