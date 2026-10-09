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
import { getSetting } from '@/lib/database/services/setting-service';
import logger from '@/lib/logger';
import { AppScheduler } from '@/lib/scheduler/AppScheduler';
import * as schedulerPersistence from '@/lib/scheduler/scheduler-persistence';
import { useSchedulerStore } from '@/lib/scheduler/scheduler-store';
import { useDatabaseStore } from '@/lib/stores/database-store';
import { useForYouStore } from '@/lib/stores/for-you-store';
import { useNetworkStore } from '@/lib/stores/network-store';
import { useUserStore } from '@/lib/stores/user-store';
import {
  advanceUntilDone,
  graphql,
  http,
  HttpResponse,
  server,
  setAppState,
  setScenario,
  signInFixtureAccount,
  useFakeClock as freezeClockAt, // aliased: a use* name inside a plain function trips react-hooks/rules-of-hooks
} from '@/test/helpers';
import { jobRows, resetScheduler } from '../../scheduler/core/support';
import { cleanupFeedSync, recordOps, resetFeedSyncMemory, seedInterest, servePersona, spyOnExport } from '../steps/support';
import { fetchStep, gate, watchScoring, settleMachine, waitFor } from './support';

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
const runs = () => sent.count('GetArticleIdsForPersona');

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

  /** The task last ran `agoMs` ago, persisted so init loads it. */
  const lastRanAgo = (agoMs: number) => schedulerPersistence.saveLastRun('feed-sync', T0 - agoMs);

  describe('what starts it', () => {
    it('runs when the app returns to the foreground, and not before', async () => {
      await lastRanAgo(120_000);
      await init();
      await elapse(30_000);
      expect(await runs()).toBe(0);

      setAppState('background');
      setAppState('active');
      await waitFor(async () => (await runs()) === 1, 'the foreground run');
    });

    it('runs when the network comes back, and not before', async () => {
      await lastRanAgo(120_000);
      await init();
      await elapse(30_000);
      expect(await runs()).toBe(0);

      useNetworkStore.getState().setIsConnected(false);
      useNetworkStore.getState().setIsConnected(true);
      await waitFor(async () => (await runs()) === 1, 'the reconnect run');
    });

    it('runs on its first tick when it has never run', async () => {
      await init();
      await waitFor(async () => (await runs()) === 1, 'the first run');
    });
  });

  describe('how often', () => {
    // The cadence is a FLOOR: dropping it under five minutes is a deliberate, visible change. The
    // tick jitters it by +/-20%, so about four minutes can never be due and about six always is.
    it('is not run again by the tick inside five minutes, and is after', async () => {
      await init();
      await waitFor(async () => (await runs()) === 1, 'the first run');
      await waitFor(() => useSchedulerStore.getState().taskCurrentStatus['feed-sync'] !== 'running', 'the first run to finish');
      const finished = Date.now();

      await elapse(3 * 60_000, 1_000); // under 80% of five minutes since the run
      expect(await runs()).toBe(1);

      await waitFor(async () => (await runs()) === 2, 'the second run', 4 * 60_000);
      expect(Date.now() - finished).toBeGreaterThanOrEqual(4 * 60_000 - 5_000); // not before the jitter floor
    });
  });

  describe('the conditions on the scheduled path', () => {
    async function blockedThenFixed(breakIt: () => void | Promise<void>, fixIt: () => void | Promise<void>) {
      await breakIt();
      await init();
      await elapse(11_000);
      expect(await runs()).toBe(0);

      await fixIt();
      await waitFor(async () => (await runs()) === 1, 'the run once the condition holds', 20_000);
    }

    it('does not run while the device is offline', async () => {
      await blockedThenFixed(
        () => useNetworkStore.getState().setIsConnected(false),
        () => useNetworkStore.getState().setIsConnected(true),
      );
    });

    it('does not run while the database is not ready', async () => {
      await blockedThenFixed(
        () => useDatabaseStore.setState({ ready: false }),
        () => useDatabaseStore.setState({ ready: true }),
      );
    });

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

    it('does not run before the daily-cap reset time, and does after', async () => {
      await blockedThenFixed(
        () => useForYouStore.setState({ dailyLimitResetAt: T0 + 10 * 60_000 }),
        () => jest.setSystemTime(T0 + 10 * 60_000 + 1_000),
      );
    });
  });

  describe('no tier gate', () => {
    // Under starter-free every account holds Starter at read time, so there is no tier for which
    // skipping the sync is correct. With every other condition passing and the cap's reset past, the
    // task runs for an unentitled account and for one with no billing row at all. A reintroduced tier
    // condition (or any added custom one) blocks it here.
    it.each(['none', 'starter'] as const)('runs for an account on tier %s', async (tier) => {
      setScenario({ tier });
      useForYouStore.setState({ dailyLimitResetAt: T0 - 60_000 });

      await init();

      await waitFor(async () => (await runs()) === 1, 'the run');
    });

    it('runs for an account whose tier has never been learned on this device', async () => {
      // a fresh install: no billing row, nothing in the subscription store, no remembered tier
      await init();

      await waitFor(async () => (await runs()) === 1, 'the run');
    });
  });

  describe('exclusive', () => {
    it('answers busy to a second trigger while a run is in flight, and starts no second run', async () => {
      const held = gate();
      const fetch = fetchStep().hold(held.held);
      const first = AppScheduler.trigger('feed-sync');
      await fetch.reached(1);

      const second = await AppScheduler.trigger('feed-sync');

      expect(second).toBe('busy');
      expect(fetch.calls()).toBe(1);
      held.release();
      await expect(advanceUntilDone(first)).resolves.toBe('ran');
    });
  });

  describe('maxAttempts', () => {
    it('stops its retry ladder at three attempts on the persisted job rows', async () => {
      server.use(
        graphql.query('GetArticleIdsForPersona', () =>
          HttpResponse.json({ errors: [{ message: 'down', extensions: { code: 'INTERNAL_SERVER_ERROR' } }] }),
        ),
      );

      await advanceUntilDone(AppScheduler.trigger('feed-sync', undefined, { bypassDebounce: true }));
      await elapse(32_000);
      await elapse(62_000);
      // far past the 120s rung a fourth attempt would have waited for
      await elapse(300_000, 1_000);

      const rows = await jobRows('feed-sync');
      expect(rows.map((r) => [r.attempt, r.status])).toEqual([
        [1, 'retrying'],
        [2, 'retrying'],
        [3, 'failed'],
      ]);
    });
  });

  describe('timeout', () => {
    // The scheduler aborts a run after three minutes; the machine notices at its next check and
    // ends it as a no-op, so the job completes without arming the frequency gate (no lastRun).
    it('aborts a run that is still going after three minutes, and not before', async () => {
      const lastRun = () => getSetting('scheduler_last_run_feed-sync');
      const early = gate();
      fetchStep().hold(early.held, { after: true });
      const first = AppScheduler.trigger('feed-sync', undefined, { bypassDebounce: true });
      await waitFor(async () => (await runs()) === 1, 'the run to be in the fetch step');
      await elapse(2 * 60_000 + 50_000, 1_000);
      early.release();
      await advanceUntilDone(first);
      expect(await lastRun()).not.toBeNull(); // released at 2m50s: not aborted, a real success
    });

    it('is aborted and ends as a no-op once three minutes have passed', async () => {
      const lastRun = () => getSetting('scheduler_last_run_feed-sync');
      const late = gate();
      fetchStep().hold(late.held, { after: true });
      const first = AppScheduler.trigger('feed-sync', undefined, { bypassDebounce: true });
      await waitFor(async () => (await runs()) === 1, 'the run to be in the fetch step');
      await elapse(3 * 60_000 + 10_000, 1_000);
      late.release();
      await advanceUntilDone(first);
      expect(await lastRun()).toBeNull(); // aborted at 3m: markNoOp, so lastRun is not stamped
      const [row] = await jobRows('feed-sync');
      expect(row.status).toBe('completed');
    });
  });

  describe('the handler', () => {
    it('fails the job with UserPersona not found when there is no persona, and asks the server nothing', async () => {
      useUserStore.setState({ userPersona: null });

      await advanceUntilDone(AppScheduler.trigger('feed-sync', undefined, { bypassDebounce: true }));

      const [row] = await jobRows('feed-sync');
      expect(row.status).toBe('retrying');
      expect(row.errorMessage).toContain('UserPersona not found');
      expect(await runs()).toBe(0);
    });

    it('treats a persona with no id the same as no persona', async () => {
      useUserStore.setState({ userPersona: {} as never });

      await advanceUntilDone(AppScheduler.trigger('feed-sync', undefined, { bypassDebounce: true }));

      const [row] = await jobRows('feed-sync');
      expect(row.errorMessage).toContain('UserPersona not found');
      expect(await runs()).toBe(0);
    });

    it('logs which user and persona it runs for, and "null" when it has none', async () => {
      const debug = spyOnExport(logger, 'debug');
      useUserStore.setState({ userId: 'user-9' } as never);
      await advanceUntilDone(AppScheduler.trigger('feed-sync', undefined, { bypassDebounce: true }));
      useUserStore.setState({ userId: null } as never);
      await advanceUntilDone(AppScheduler.trigger('feed-sync', undefined, { bypassDebounce: true }));

      const lines = debug.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('[feed-sync-task]'));
      expect(lines[0]).toContain('userId=user-9 personaId=persona-1 attempt=1');
      expect(lines[1]).toContain('userId=null personaId=persona-1');
    });

    it('starts the machine for the persona it finds', async () => {
      await advanceUntilDone(AppScheduler.trigger('feed-sync', undefined, { bypassDebounce: true }));

      expect(await runs()).toBe(1);
      const [row] = await jobRows('feed-sync');
      expect(row.status).toBe('completed');
    });
  });
});
