// Going offline mid-run and coming back, and the wake lock (B1.4) around it: the real network store
// is flipped while the run is held at a network-dependent stage (a held persona or hydrate
// response), and the machine parks, drops its lock, and resumes. expo-keep-awake is the observed
// native edge.
// Replaces the offline pause/resume, isRunning and wake-lock blocks of
// lib/scheduler/feed-sync/__tests__/FeedSyncMachine.test.ts, and the "releases EVERY parked waiter"
// and "abandoned run parked offline" tests of its stale in-flight block.
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

import { HYDRATE_CHUNK_SIZE, HYDRATE_CONCURRENCY } from '@/lib/scheduler/feed-sync/feed-sync-steps';
import { INFLIGHT_STALE_MS } from '@/lib/scheduler/feed-sync/FeedSyncMachine';
import { useForYouStore } from '@/lib/stores/for-you-store';
import { useNetworkStore } from '@/lib/stores/network-store';
import { advanceUntilDone } from '@/test/helpers';
import { cleanupFeedSync, fetchAndDiff, hydrate, ids, makeCtx, recordOps, resetFeedSyncMemory, resetScoringWorld, rowsById } from '../steps/support';
import {
  feedSyncMachine,
  gate,
  fetchStep,
  keepAwake,
  watchScoring,
  scoreEntries,
  serveNew,
  settleMachine,
  startMachine,
  takeOverStuckRun,
  waitFor,
} from './support';

jest.setTimeout(60_000);

const offline = () => useNetworkStore.getState().setIsConnected(false);
const online = () => useNetworkStore.getState().setIsConnected(true);
const header = () => useForYouStore.getState().syncStatusMessage;

describe('FeedSyncMachine offline pause and the wake lock', () => {
  beforeEach(async () => {
    resetFeedSyncMemory();
    await resetScoringWorld();
    watchScoring();
    useNetworkStore.setState({ isConnected: true });
  });
  afterEach(async () => {
    await settleMachine();
    cleanupFeedSync();
  });

  describe('isRunning', () => {
    it('is true in every active stage, including parked offline, and false once the run is over', async () => {
      await serveNew(ids(3));
      const held = gate();
      const fetch = fetchStep().hold(held.held);
      expect(feedSyncMachine.isRunning()).toBe(false);

      const running = startMachine();
      await fetch.reached(1);
      expect(feedSyncMachine.state).toBe('fetching-topic-ids');
      expect(feedSyncMachine.isRunning()).toBe(true);

      offline();
      expect(feedSyncMachine.state).toBe('paused-offline');
      expect(feedSyncMachine.isRunning()).toBe(true);

      online();
      held.release();
      await advanceUntilDone(running);
      expect(feedSyncMachine.state).toBe('done');
      expect(feedSyncMachine.isRunning()).toBe(false);
    });
  });

  describe('losing the link', () => {
    it('while fetching topic ids: parks, publishes where it stopped, and finishes once the link is back', async () => {
      await serveNew(ids(4));
      const held = gate();
      const fetch = fetchStep().hold(held.held);
      const running = startMachine();
      await fetch.reached(1);

      offline();

      expect(feedSyncMachine.state).toBe('paused-offline');
      expect(header()).toEqual(
        expect.objectContaining({ state: 'paused-offline', headlineKey: 'sync.waitingForConnection', pausedAtState: 'fetching-topic-ids', isRecoverable: true }),
      );

      online();
      held.release();
      await advanceUntilDone(running);

      expect(feedSyncMachine.state).toBe('done');
      expect((await rowsById()).size).toBe(4);
    });

    // DATA-U6b-1. The link drops while the fetch is in flight and the fetch still lands. The run
    // walks on (paused-offline -> diffing -> hydrating) and parks at the hydrate gate with `_paused`
    // set, but its state is now 'hydrating'. The reconnect listener resumes only a machine whose
    // state is 'paused-offline', so coming back online wakes nobody: the run sits parked, holding
    // the in-flight slot, until a later start() finds it older than the stale window and abandons it.
    describe('DATA-U6b-1: the link drops during the fetch, the fetch lands, and the link returns', () => {
      async function dropDuringFetchThenFetchLands() {
        await serveNew(ids(4));
        const held = gate();
        const fetch = fetchStep().hold(held.held);
        const t = makeCtx();
        const sent = recordOps();
        const running = startMachine(t);
        await fetch.reached(1);
        offline();
        held.release();
        await waitFor(() => keepAwake.released() === 1, 'the run to park at the hydrate gate (lock dropped)');
        return { running, t, sent };
      }

      test.failing('resumes and finishes once the link is back', async () => {
        const { running, t, sent } = await dropDuringFetchThenFetchLands();
        try {
          online();
          await waitFor(() => !feedSyncMachine.isRunning(), 'the parked run to resume and finish', 5_000);
          expect(await sent.count('GetArticlesForTopicsByIds')).toBeGreaterThan(0);
        } finally {
          await takeOverStuckRun(running, t);
        }
      });

      it('today: stays parked after the link is back, hydrates nothing, and only a takeover after the stale window frees it', async () => {
        const { running, t, sent } = await dropDuringFetchThenFetchLands();

        online();
        await expect(waitFor(() => !feedSyncMachine.isRunning(), 'resume', 3_000)).rejects.toThrow(/timed out/);

        expect(feedSyncMachine.state).toBe('hydrating'); // not paused-offline: the resume check never matches
        expect(feedSyncMachine.isRunning()).toBe(true);
        expect(await sent.count('GetArticlesForTopicsByIds')).toBe(0);
        await takeOverStuckRun(running, t);
        expect(feedSyncMachine.state).toBe('done');
      });
    });

    it('while hydrating: publishes that it stopped at hydrating', async () => {
      const hold = gate();
      const served = await serveNew(ids(4), { gate: () => hold.held });
      const running = startMachine();
      await waitFor(() => served.stats.requests.length > 0, 'the hydrate to be in flight');
      expect(feedSyncMachine.state).toBe('hydrating');

      offline();

      expect(header()).toEqual(expect.objectContaining({ state: 'paused-offline', pausedAtState: 'hydrating' }));
      online();
      hold.release();
      await advanceUntilDone(running);
      expect(feedSyncMachine.state).toBe('done');
    });

    it('wakes EVERY parked hydrate worker on reconnect, not just the last', async () => {
      // HYDRATE_CONCURRENCY workers each hold a chunk; offline, they finish it and park one by one.
      // A single resume slot would wake only the last and hang the other two for the session.
      const chunks = HYDRATE_CONCURRENCY + 2;
      const hold = gate();
      const served = await serveNew(ids(HYDRATE_CHUNK_SIZE * chunks), { gate: () => hold.held });
      const running = startMachine();
      await waitFor(() => served.stats.requests.length === HYDRATE_CONCURRENCY, 'every worker to be in flight');
      offline();

      hold.release();
      await waitFor(() => served.stats.inFlight === 0, 'the held chunks to finish');
      await advanceUntilDone(Promise.resolve());
      expect(served.stats.requests).toHaveLength(HYDRATE_CONCURRENCY); // all three parked, none fetching on

      online();
      await advanceUntilDone(running, 120_000);

      expect(served.stats.requests).toHaveLength(chunks);
      expect((await rowsById()).size).toBe(HYDRATE_CHUNK_SIZE * chunks);
      expect(feedSyncMachine.state).toBe('done');
    });

    it('a run abandoned while parked offline unwinds instead of hanging for the session', async () => {
      const hold = gate();
      const served = await serveNew(ids(HYDRATE_CHUNK_SIZE * (HYDRATE_CONCURRENCY + 1)), { gate: () => hold.held });
      const runA = startMachine();
      await waitFor(() => served.stats.requests.length === HYDRATE_CONCURRENCY, 'every worker to be in flight');
      offline();
      hold.release();
      await waitFor(() => served.stats.inFlight === 0, 'the held chunks to finish');
      await advanceUntilDone(Promise.resolve());
      expect(feedSyncMachine.state).toBe('paused-offline');
      jest.setSystemTime(Date.now() + INFLIGHT_STALE_MS + 60_000);

      const runB = startMachine();
      await advanceUntilDone(runB, 120_000);

      await expect(advanceUntilDone(runA, 120_000)).resolves.toBeUndefined(); // released by the takeover
      expect(feedSyncMachine.state).toBe('done');
    });
  });

  describe('the wake lock', () => {
    it('is taken once for the run, held across fetch and hydrate, and down before scoring starts', async () => {
      const hold = gate();
      const held = gate();
      const served = await serveNew(ids(4), { gate: () => hold.held });
      const fetch = fetchStep().hold(held.held);
      expect(keepAwake.taken()).toBe(0);

      const running = startMachine();
      await fetch.reached(1);
      expect([keepAwake.taken(), keepAwake.released()]).toEqual([1, 0]); // fetching
      held.release();
      await waitFor(() => served.stats.requests.length > 0, 'the hydrate to be in flight');
      expect(feedSyncMachine.state).toBe('hydrating');
      expect([keepAwake.taken(), keepAwake.released()]).toEqual([1, 0]); // hydrating

      hold.release();
      await advanceUntilDone(running);

      expect(scoreEntries.map((e) => e.keepAwakeHeld)).toEqual([false]); // down when scoring began
      expect(keepAwake.tags()).toEqual({ taken: ['mera-feed-sync'], released: ['mera-feed-sync'] }); // once each
    });

    it('is down before scoring on a run that found nothing new, too, and again once it is over', async () => {
      const all = ids(3);
      await serveNew(all);
      const setup = makeCtx();
      const { diff } = await advanceUntilDone(fetchAndDiff(setup)); // the device already holds every id
      await advanceUntilDone(hydrate(diff, setup));

      await advanceUntilDone(startMachine());

      expect(scoreEntries.map((e) => e.keepAwakeHeld)).toEqual([false]);
      expect(keepAwake.tags()).toEqual({ taken: ['mera-feed-sync'], released: ['mera-feed-sync'] });
    });

    it('is dropped while parked offline and taken again on resume', async () => {
      const hold = gate();
      const served = await serveNew(ids(HYDRATE_CHUNK_SIZE * (HYDRATE_CONCURRENCY + 1)), { gate: () => hold.held });
      const running = startMachine();
      await waitFor(() => served.stats.requests.length === HYDRATE_CONCURRENCY, 'every worker to be in flight');
      expect(keepAwake.released()).toBe(0);
      offline();
      hold.release();
      await waitFor(() => keepAwake.released() === 1, 'the lock to be dropped while parked');
      const takenWhileParked = keepAwake.taken();

      online();
      await advanceUntilDone(running);

      expect(keepAwake.taken()).toBe(takenWhileParked + 1);
      expect(keepAwake.released()).toBe(keepAwake.taken());
    });

    it('is released when the run ends early on an abort', async () => {
      await serveNew(ids(3));
      const t = makeCtx();
      t.abort();

      await advanceUntilDone(startMachine(t));

      expect(keepAwake.taken()).toBe(1);
      expect(keepAwake.released()).toBe(1);
    });
  });
});
