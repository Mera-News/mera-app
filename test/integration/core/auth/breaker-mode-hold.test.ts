// A task paused for an own mode stays paused through an auth-breaker trip and recovery.
import { _resetForTests, recordAuthFailure } from '@/lib/auth-failure-breaker';
import { holdFeedSyncForMode } from '@/lib/own-services/mode-hold';
import { AppScheduler } from '@/lib/scheduler/AppScheduler';
import { setAppState, signInFixtureAccount } from '@/test/helpers';

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
