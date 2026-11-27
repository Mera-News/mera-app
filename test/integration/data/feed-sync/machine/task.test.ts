// The feed-sync scheduler task, registered with the REAL AppScheduler by importing its module, and
// driving the real FeedSyncMachine behind it: what starts it, what holds it back, how often, and
// what its retry ladder does. Every assertion is behavioural (a persona request went out or did
// not, a persisted job row); the scheduler's task map is never read. The persona query is the run
// counter: one run asks it exactly once.
// Replaces lib/scheduler/tasks/__tests__/feed-sync-task.test.ts.
jest.mock('expo-keep-awake', () => ({
  activateKeepAwakeAsync: jest.fn(async () => undefined),
  deactivateKeepAwake: jest.fn(),
}));

import '@/test/helpers';
import '@/lib/scheduler/tasks/feed-sync-task';

import { invalidateJwtCache } from '@/lib/auth-client';
import { AppScheduler } from '@/lib/scheduler/AppScheduler';
import { useSchedulerStore } from '@/lib/scheduler/scheduler-store';
import { useDatabaseStore } from '@/lib/stores/database-store';
import { useUserStore } from '@/lib/stores/user-store';
import {
  advanceUntilDone,
  http,
  HttpResponse,
  server,
  signInFixtureAccount,
  useFakeClock as freezeClockAt, // aliased: a use* name inside a plain function trips react-hooks/rules-of-hooks
} from '@/test/helpers';
import { resetScheduler } from '../../scheduler/core/support';
import { cleanupFeedSync, recordOps, resetFeedSyncMemory, seedInterest, servePersona } from '../steps/support';
import { watchScoring, settleMachine, waitFor } from './support';

jest.setTimeout(60_000);

const T0 = Date.UTC(2026, 9, 9, 12, 0, 0);

/** Signs in on the real clock (MSW answers in real time), then goes back under the fake one. */
async function signedIn() {
  jest.useRealTimers();
  await signInFixtureAccount();
  freezeClockAt(T0);
}

/** Moves the fake clock `ms` in `stepMs` steps, a real event-loop turn per step: a run issues real requests. */
async function elapse(ms: number, stepMs = 250) {
  for (let spent = 0; spent < ms; spent += stepMs) {
    await jest.advanceTimersByTimeAsync(stepMs);
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

let sent: ReturnType<typeof recordOps>;
// One persona request per run: the language document, which the mock backend answers.
const runs = () => sent.count('GetArticleIdsForPersonaForLanguage');

describe('feed-sync scheduler task', () => {
  beforeEach(async () => {
    resetFeedSyncMemory();
    freezeClockAt(T0);
    resetScheduler();
    watchScoring();
    // The conditions the real app has by the time the first tick fires; each test breaks one.
    await signedIn();
    useUserStore.setState({ userPersona: { _id: 'persona-1' } as never });
    useDatabaseStore.setState({ ready: true });
    await seedInterest('I follow racing', ['formula 1']);
    server.use(servePersona({ topics: {} })); // a quiet server: a run asks, finds nothing, finishes
    sent = recordOps();
  });

  afterEach(async () => {
    AppScheduler.dispose();
    await settleMachine();
    await waitFor(() => useSchedulerStore.getState().taskCurrentStatus['feed-sync'] !== 'running', 'the feed-sync job to end');
    cleanupFeedSync();
  });

  const init = () => advanceUntilDone(AppScheduler.init());

  describe('the conditions on the scheduled path', () => {
    async function blockedThenFixed(breakIt: () => void | Promise<void>, fixIt: () => void | Promise<void>) {
      await breakIt();
      await init();
      await elapse(11_000);
      expect(await runs()).toBe(0);

      await fixIt();
      await waitFor(async () => (await runs()) === 1, 'the run once the condition holds', 20_000);
    }

    it('does not run for a signed-out account (the token endpoint refuses the session)', async () => {
      let refused = true;
      await blockedThenFixed(
        () => {
          invalidateJwtCache();
          server.use(http.get('*/api/auth/token', () => (refused ? HttpResponse.json({ error: 'nope' }, { status: 401 }) : undefined)));
        },
        () => {
          refused = false;
        },
      );
    });
  });
});
