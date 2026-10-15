// Re-entrancy and abandonment: a second start() while a run is live joins it, and a run that never
// settles is abandoned after INFLIGHT_STALE_MS and replaced. The abandoned run (the "zombie") keeps
// executing against the singleton, so every shared write it can still reach must be inert.
// Time is the fake clock. A run is held at its fetch step (see fetchStep in support), which is what a
// run that "never settles" looks like to the machine, and released later to play the zombie waking.
// Replaces the re-entrancy and stale-in-flight blocks of
// lib/scheduler/feed-sync/__tests__/FeedSyncMachine.test.ts.
jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    captureException: jest.fn(),
    captureMessage: jest.fn(),
    addBreadcrumb: jest.fn(),
  },
}));
jest.mock('expo-keep-awake', () => ({
  activateKeepAwakeAsync: jest.fn(async () => undefined),
  deactivateKeepAwake: jest.fn(),
}));

import { batchMarkExcluded } from '@/lib/database/services/article-suggestion-scoring-writes';
import logger from '@/lib/logger';
import { INFLIGHT_STALE_MS } from '@/lib/scheduler/feed-sync/FeedSyncMachine';
import * as persistence from '@/lib/scheduler/feed-sync/feed-sync-persistence';
import * as steps from '@/lib/scheduler/feed-sync/feed-sync-steps';
import { useForYouStore } from '@/lib/stores/for-you-store';
import { useNetworkStore } from '@/lib/stores/network-store';
import { advanceUntilDone, server } from '@/test/helpers';
import {
  cleanupFeedSync,
  fetchAndDiff,
  hydrate,
  ids,
  makeCtx,
  recordOps,
  resetFeedSyncMemory,
  resetScoringWorld,
  rowsById,
  serveHydrate,
  servePersona,
  spyOnExport,
} from '../steps/support';
import {
  feedSyncMachine,
  fetchStep,
  gate,
  keepAwake,
  recordMachine,
  watchScoring,
  serveNew,
  settleMachine,
  startMachine,
  waitFor,
  watchNetworkSubscriptions,
} from './support';

jest.setTimeout(60_000);

const store = () => useForYouStore.getState();
const later = (ms: number) => jest.setSystemTime(Date.now() + ms);
const breadcrumbs = () => (logger.addBreadcrumb as jest.Mock).mock.calls.map((c) => String(c[0]));
const captured = () => (logger.captureException as jest.Mock).mock.calls;
const quiet = () => advanceUntilDone(Promise.resolve());

describe('FeedSyncMachine re-entrancy and abandonment', () => {
  beforeEach(async () => {
    resetFeedSyncMemory();
    await resetScoringWorld();
    watchScoring();
  });
  afterEach(async () => {
    await settleMachine();
    cleanupFeedSync();
  });

  describe('single-flight', () => {
    it('joins the live run instead of starting a second: one fetch, one set of rows, no invalid transition', async () => {
      const all = ids(5);
      await serveNew(all);
      const held = gate();
      const fetch = fetchStep().hold(held.held);
      const sent = recordOps();

      const first = startMachine();
      await fetch.reached(1);
      const second = startMachine();
      await quiet();
      expect(fetch.calls()).toBe(1);

      held.release();
      await advanceUntilDone(Promise.all([first, second]));

      expect(fetch.calls()).toBe(1);
      expect(await sent.count('GetArticleIdsForPersona')).toBe(1);
      expect([...(await rowsById()).keys()].sort()).toEqual(all);
      expect(captured().filter(([e]) => /Invalid FeedSyncMachine transition/.test(String(e?.message)))).toEqual([]);
    });

    it('allows a fresh run once the previous one has settled', async () => {
      await serveNew(ids(3));
      const sent = recordOps();

      await advanceUntilDone(startMachine());
      await advanceUntilDone(startMachine());

      expect(await sent.count('GetArticleIdsForPersona')).toBe(2);
    });

    it('joins a failing run too: both callers see the one failure, and it is published once', async () => {
      await serveNew(ids(3));
      const held = gate();
      const fetch = fetchStep().hold(held.held, { fail: true });
      const rec = recordMachine();

      const first = startMachine();
      await fetch.reached(1);
      const second = startMachine();
      held.release();
      const results = await advanceUntilDone(Promise.allSettled([first, second]));

      expect(results.map((r) => r.status)).toEqual(['rejected', 'rejected']);
      expect(fetch.calls()).toBe(1);
      expect(rec.published.filter((s) => s === 'failed')).toHaveLength(1);
      expect(feedSyncMachine.state).toBe('failed');
      rec.stop();
    });

    it('joins a run that is still inside the stale window', async () => {
      await serveNew(ids(3));
      const held = gate();
      const fetch = fetchStep().hold(held.held);
      startMachine();
      await fetch.reached(1);

      later(INFLIGHT_STALE_MS - 30_000);
      startMachine();
      await quiet();

      expect(fetch.calls()).toBe(1);
    });
  });

  describe('abandoning a run that never settles', () => {
    /** Run A hangs at its fetch step; the clock passes the stale window. */
    async function abandonedRun(all = ids(5)) {
      await serveNew(all);
      const heldA = gate();
      const fetch = fetchStep().hold(heldA.held, { nth: 1 });
      const runA = startMachine();
      await fetch.reached(1);
      later(INFLIGHT_STALE_MS + 60_000);
      return { runA, heldA, all, fetch };
    }

    it('starts fresh after the stale window: the second run completes while the first is still hanging', async () => {
      const { all, fetch } = await abandonedRun();

      await advanceUntilDone(startMachine());

      expect(fetch.calls()).toBe(2); // A's, held, and B's
      expect(feedSyncMachine.state).toBe('done');
      expect([...(await rowsById()).keys()].sort()).toEqual(all);
      expect(breadcrumbs().some((m) => m.includes('dropped transition'))).toBe(false);
    });

    it("cannot corrupt the replacement: when A wakes into a transition the machine has moved past, it is dropped and B's state stays", async () => {
      const { runA, heldA } = await abandonedRun();
      await advanceUntilDone(startMachine());
      expect(feedSyncMachine.state).toBe('done');

      heldA.release();
      await expect(advanceUntilDone(runA)).resolves.toBeUndefined();

      expect(feedSyncMachine.state).toBe('done');
      expect(breadcrumbs().some((m) => m.includes('dropped transition from abandoned run'))).toBe(true);
      expect(captured()).toEqual([]);
    });

    it('its terminal branch (a no-topics-configured reject) cannot knock the LIVE run out of hydrating', async () => {
      await serveNew(ids(5));
      const heldA = gate();
      const original = steps.stepFetchTopicIds;
      let calls = 0;
      spyOnExport(steps, 'stepFetchTopicIds').mockImplementation(async (personaId, ctx) => {
        calls += 1;
        if (calls > 1) return original(personaId, ctx);
        await heldA.held;
        throw Object.assign(new Error('no-topics-configured'), { code: 'no-topics-configured' });
      });
      const runA = startMachine();
      await waitFor(() => calls === 1, 'run A to reach the fetch step');
      later(INFLIGHT_STALE_MS + 60_000);
      // B parks in hydrate, so the machine sits at `hydrating` when A's catch runs
      const heldB = gate();
      const served = serveHydrate({ gate: () => heldB.held });
      server.use(...served.handlers);
      const runB = startMachine();
      await waitFor(() => served.stats.requests.length > 0, 'run B to be hydrating');
      expect(feedSyncMachine.state).toBe('hydrating');
      const rec = recordMachine();

      heldA.release();
      await expect(advanceUntilDone(runA)).resolves.toBeUndefined();

      expect(feedSyncMachine.state).toBe('hydrating'); // A's force-reset to idle did not land
      expect(rec.published).toEqual([]); // and A's error did not paint over B's header

      heldB.release();
      await advanceUntilDone(runB);
      expect(feedSyncMachine.state).toBe('done');
      rec.stop();
    });

    it('its no-new-articles branch cannot stamp "processing finished" over a live run', async () => {
      // the device already holds every id, so A's own diff comes back empty the moment it wakes
      const all = ids(4);
      await serveNew(all);
      const setup = makeCtx();
      const { diff } = await advanceUntilDone(fetchAndDiff(setup));
      await advanceUntilDone(hydrate(diff, setup));
      await batchMarkExcluded(all); // terminal rows: no scoring pass can stamp on its own
      const heldA = gate();
      const heldB = gate();
      const fetch = fetchStep().hold(heldA.held, { nth: 1 }).hold(heldB.held, { nth: 2 });
      const runA = startMachine();
      await fetch.reached(1);
      later(INFLIGHT_STALE_MS + 60_000);
      const runB = startMachine();
      await fetch.reached(2);
      expect(feedSyncMachine.state).toBe('fetching-topic-ids');

      heldA.release();
      await advanceUntilDone(runA);

      expect(store().lastProcessingRunFinishedAt).toBeNull();
      expect(store().lastSyncAt).toBeNull();
      expect(feedSyncMachine.state).toBe('fetching-topic-ids');

      heldB.release();
      await advanceUntilDone(runB);
      expect(store().lastProcessingRunFinishedAt).toEqual(expect.any(Number)); // the LIVE run still stamps
      expect(store().lastSyncAt).toEqual(expect.any(Number));
    });

    it("releases the abandoned run's network listener when the replacement subscribes, and the dead one cannot pause the live run", async () => {
      const subscriptions = watchNetworkSubscriptions();
      const { runA, heldA } = await abandonedRun(ids(5));
      const heldB = gate();
      const served = serveHydrate({ gate: () => heldB.held });
      server.use(...served.handlers);
      const runB = startMachine();
      await waitFor(() => served.stats.requests.length > 0, 'run B to be hydrating');
      expect(feedSyncMachine.state).toBe('hydrating');
      expect(subscriptions.calls()).toBe(2);
      expect(subscriptions.live()).toBe(1);
      const rec = recordMachine();

      useNetworkStore.getState().setIsConnected(false);

      expect(rec.published).toEqual(['paused-offline']); // one listener reacted: the live one
      expect(feedSyncMachine.state).toBe('paused-offline');
      useNetworkStore.getState().setIsConnected(true);
      heldB.release();
      await advanceUntilDone(runB);
      heldA.release(); // the zombie wakes, drops its transitions and unwinds
      await advanceUntilDone(runA.catch(() => undefined));
      expect(feedSyncMachine.state).toBe('done');
      rec.stop();
    });

    it("keeps the abandoned run's network listener inert in the window before the replacement subscribes", async () => {
      const { runA, heldA } = await abandonedRun(ids(4));
      const heldStart = gate();
      const original = persistence.loadValidSnapshot;
      const starting = spyOnExport(persistence, 'loadValidSnapshot').mockImplementation(async () => {
        await heldStart.held;
        return original();
      });
      const runB = startMachine(); // B owns the machine now, but has not yet released A's listener
      await waitFor(() => starting.mock.calls.length > 0, 'run B to be starting');
      const rec = recordMachine();
      const stateBefore = feedSyncMachine.state;

      useNetworkStore.getState().setIsConnected(false);

      expect(rec.published).toEqual([]); // A's listener fired and did nothing
      expect(feedSyncMachine.state).toBe(stateBefore);
      useNetworkStore.getState().setIsConnected(true);
      heldStart.release();
      await advanceUntilDone(runB);
      heldA.release();
      await advanceUntilDone(runA);
      expect(feedSyncMachine.state).toBe('done');
      rec.stop();
    });

    it('does not inherit a pause: a run that died while paused does not park the next one forever', async () => {
      await serveNew(ids(4));
      const held = gate();
      const fetch = fetchStep().hold(held.held, { nth: 1, fail: true });
      const failing = startMachine();
      await fetch.reached(1);
      useNetworkStore.getState().setIsConnected(false); // parks the run: `_paused` is now true
      expect(feedSyncMachine.state).toBe('paused-offline');
      held.release();
      await expect(advanceUntilDone(failing)).rejects.toBeDefined(); // the fetch fails; the run dies still paused
      expect(feedSyncMachine.state).toBe('failed');
      useNetworkStore.getState().setIsConnected(true); // nobody is listening any more
      server.use(servePersona({ topics: { 'formula 1': ids(4) } }), ...serveHydrate().handlers);

      await advanceUntilDone(startMachine(), 60_000);

      expect(feedSyncMachine.state).toBe('done');
    });

    it("the abandoned run cannot clear the replacement's in-flight slot or drop its wake lock", async () => {
      await serveNew(ids(5));
      const heldA = gate();
      const heldB = gate();
      const fetch = fetchStep().hold(heldA.held, { nth: 1 }).hold(heldB.held, { nth: 2 });
      const runA = startMachine();
      await fetch.reached(1);
      later(INFLIGHT_STALE_MS + 60_000);
      startMachine(); // B: hangs at its own fetch step, so it owns the slot
      await fetch.reached(2);
      const takenBefore = keepAwake.taken();
      const releasedBefore = keepAwake.released();

      heldA.release();
      await advanceUntilDone(runA);
      startMachine(); // a third caller must JOIN B, not start a run of its own
      await quiet();

      expect(fetch.calls()).toBe(2);
      expect(keepAwake.released()).toBe(releasedBefore); // A's teardown did not release B's lock
      expect(keepAwake.taken()).toBe(takenBefore);
      expect(feedSyncMachine.isRunning()).toBe(true);
    });
  });
});
