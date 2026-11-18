// A task paused for an own mode stays paused through an auth-breaker trip and recovery.
import { _resetForTests, isBreakerOpen, recordAuthFailure } from '@/lib/auth-failure-breaker';
import { holdFeedSyncForMode } from '@/lib/own-services/mode-hold';
import { AppScheduler } from '@/lib/scheduler/AppScheduler';
import { enterPodMode, leavePodMode } from '@/lib/own-services/pod-runner';
import { forgetPairing, podState, savePairing } from '@/lib/own-services/pod-state';
import { fakePod, http, HttpResponse, podPairing, POD_URL, server, setAppState, signInFixtureAccount } from '@/test/helpers';

const tick = () => new Promise<void>((r) => setImmediate(r));
const paused = () => AppScheduler.isPaused('feed-sync');

// The recheck answers alive: the mock backend's own handler serves the signed-in account.
async function tripAndRecover() {
  for (let i = 0; i < 3; i++) recordAuthFailure();
  for (let i = 0; i < 200; i++) await tick();
}

beforeAll(() => {
  jest.spyOn(console, 'info').mockImplementation(() => {});
});

beforeEach(async () => {
  jest.clearAllMocks();
  _resetForTests();
  holdFeedSyncForMode(false);
  AppScheduler.resumeTask('feed-sync');
  setAppState('active');
  await signInFixtureAccount();
});
afterEach(() => holdFeedSyncForMode(false));

it('hold on: a trip and an alive recheck leave feed-sync paused', async () => {
  holdFeedSyncForMode(true);
  AppScheduler.pauseTask('feed-sync');

  await tripAndRecover();

  expect(paused()).toBe(true);
});

it('hold off: the alive recheck resumes feed-sync as today', async () => {
  AppScheduler.pauseTask('feed-sync');

  await tripAndRecover();

  expect(paused()).toBe(false);
});

describe('while paired', () => {
  const TOKEN = 'pod-token-abcdef123456';
  let pod: ReturnType<typeof fakePod>;

  beforeEach(async () => {
    podState.resetMemory();
    pod = fakePod({ token: TOKEN });
    await savePairing(podPairing({ deviceId: 'd1', token: TOKEN }));
    await enterPodMode();
  });
  afterEach(async () => {
    await leavePodMode();
    await forgetPairing();
    AppScheduler.resumeTask('feed-sync');
  });

  it('Mera account 401s still trip the breaker but never pause feed-sync, and a trigger still syncs with the server', async () => {
    await tripAndRecover();

    expect(paused()).toBe(false);
    await AppScheduler.trigger('feed-sync', undefined, { bypassDebounce: true });
    expect(pod.requests.filter((r) => r.path === '/snapshot')).toHaveLength(1);
  });

  it('a trip with no recovery leaves feed-sync running, and leaving then pauses it because the breaker is open', async () => {
    server.use(http.get('*/api/auth/get-session', () => HttpResponse.json(null, { status: 401 })));
    for (let i = 0; i < 3; i++) recordAuthFailure();
    for (let i = 0; i < 200; i++) await tick();
    expect(isBreakerOpen()).toBe(true);
    expect(paused()).toBe(false);

    await leavePodMode();

    expect(paused()).toBe(true);
  });

  it('leaving with the breaker closed leaves feed-sync running', async () => {
    await leavePodMode();
    expect(isBreakerOpen()).toBe(false);
    expect(paused()).toBe(false);
  });
});
