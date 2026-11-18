// The OS wake and the silent-push task while the phone is paired to its own server: the wake syncs
// with the server and does no reading of its own, so nothing reaches Mera's gateway or news server.
jest.mock('expo-task-manager', () => require('./native-fakes').taskManagerModule);
jest.mock('expo-background-task', () => require('./native-fakes').backgroundTaskModule);
jest.mock('expo-keep-awake', () => ({
  activateKeepAwakeAsync: jest.fn(async () => undefined),
  deactivateKeepAwake: jest.fn(),
}));

import * as TaskManager from 'expo-task-manager';
import { INFERENCE_TASK, defineInferenceTask } from '@/lib/background/inference-task';
import { runBackgroundRefresh } from '@/lib/background/background-task';
import { forgetPairing, podState, savePairing } from '@/lib/own-services/pod-state';
import { resetPodHealth } from '@/lib/own-services/pod-health';
import { NEWS_OPERATIONS } from '@/lib/own-services/news-operations';
import { advanceUntilDone, fakePod, gatewayCalls, podPairing, POD_URL, server } from '@/test/helpers';
import { drive, ids, resetCycleWorld, submitJobs, watchResultsGets, gatewayPolls } from '@/test/integration/chat/jobs/support';

import { resetNativeTasks } from './native-fakes';
import { rowsById, serveFresh, wakeCleanup, wakeWorld } from './support';

jest.setTimeout(60_000);

const TOKEN = 'pod-token-abcdef123456';
const pair = () => savePairing(podPairing({ token: TOKEN }));

/** Every news or gateway-bound GraphQL operation sent to a host other than the server. */
function watchMeraNews() {
  const seen: string[] = [];
  const pending: Promise<unknown>[] = [];
  const listener = ({ request }: { request: Request }) => {
    if (request.method !== 'POST' || !request.url.endsWith('/graphql') || new URL(request.url).host === 'pod.own.test') return;
    pending.push(request.clone().json().then((b: { operationName?: string }) => void seen.push(b.operationName ?? ''), () => undefined));
  };
  server.events.on('request:start', listener);
  return {
    operations: async () => (await Promise.all(pending), seen.filter((op) => NEWS_OPERATIONS.has(op))),
    stop: () => server.events.removeListener('request:start', listener),
  };
}

describe('a wake', () => {
  beforeEach(async () => {
    resetNativeTasks();
    podState.resetMemory();
    resetPodHealth();
    await wakeWorld();
  });
  afterEach(async () => {
    await wakeCleanup();
    podState.resetMemory();
  });

  it('paired: one snapshot from the server, no gateway call, no Mera news operation, and it says why it stopped', async () => {
    const pod = fakePod({ token: TOKEN });
    await serveFresh(3);
    await pair();
    podState.resetMemory(); // the wake reads the pairing itself
    const news = watchMeraNews();
    try {
      const out = await advanceUntilDone(runBackgroundRefresh());

      expect(out.stoppedBy).toBe('pod');
      expect(pod.requests.filter((r) => r.path === '/snapshot')).toHaveLength(1);
      expect(gatewayCalls()).toEqual([]);
      expect(await news.operations()).toEqual([]);
      expect(await rowsById()).toEqual(new Map());
    } finally {
      news.stop();
    }
  });

  it('paired and the server is down: the wake ends quietly with no request to Mera', async () => {
    const pod = fakePod({ token: TOKEN });
    pod.down();
    await pair();
    podState.resetMemory();
    const news = watchMeraNews();
    try {
      const out = await advanceUntilDone(runBackgroundRefresh());
      expect(out.stoppedBy).toBe('pod');
      expect(gatewayCalls()).toEqual([]);
      expect(await news.operations()).toEqual([]);
    } finally {
      news.stop();
    }
  });

  it('not paired: the wake fetches from Mera as today and the server is never asked', async () => {
    const pod = fakePod({ token: TOKEN });
    await serveFresh(3);
    await forgetPairing();
    await podState.hydrate();

    const out = await advanceUntilDone(runBackgroundRefresh());

    expect(out.stoppedBy).toBe('done');
    expect(gatewayCalls('job').length).toBeGreaterThan(0);
    expect(pod.requests).toEqual([]);
  });
});

describe('a silent push', () => {
  defineInferenceTask();
  const body = (TaskManager.defineTask as jest.Mock).mock.calls.find((c) => c[0] === INFERENCE_TASK)![1] as (b: unknown) => Promise<unknown>;

  beforeEach(async () => {
    podState.resetMemory();
    await resetCycleWorld();
  });
  afterEach(() => podState.resetMemory());

  it('paired: no gateway result fetch', async () => {
    fakePod({ token: TOKEN });
    const [, second] = await submitJobs(ids(5, 'a'), ids(5, 'b'));
    gatewayPolls(0);
    await pair();
    podState.resetMemory();
    const gets = watchResultsGets();

    await drive(body({ data: { data: { type: 'inference-done', requestId: second } } }));

    expect(gets).toEqual([]);
  });
});
