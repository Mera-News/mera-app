// A sync that starts while a scoring-pipeline run is already in flight (FETCH_WHILE_SCORING), and
// the stale guard that decides whether that run is aborted. The in-flight run is built the way the
// app builds one: a first sync hands articles to the real pipeline, which submits them to the
// gateway mock, and the mock leaves the jobs unfinished (`pendingPolls`). Time then moves the clock
// past the guard.
// Replaces the scoring-pipeline gate and stale-guard blocks of
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

import logger from '@/lib/logger';
import { COLLECT_WINDOW_MS, getPipelineStatus, STALE_RUN_GUARD_MS, staleRunVerdict } from '@/lib/services/scoring-pipeline';
import { useForYouStore } from '@/lib/stores/for-you-store';
import {
  advanceUntilDone,
  assertNoGatewayViolations,
  defaultResponder,
  gatewayCalls,
  mockGateway,
  server,
} from '@/test/helpers';
import {
  cleanupFeedSync,
  ids,
  makeCtx,
  recordOps,
  resetFeedSyncMemory,
  resetScoringWorld,
  rowsById,
  scoredIds,
  tick,
  tickUntilScored,
} from '../steps/support';
import {
  buildRunningPipeline,
  currentRunId,
  gate,
  feedSyncMachine,
  watchScoring,
  scoreEntries,
  serveNew,
  settleMachine,
  startMachine,
  waitFor,
} from './support';

jest.setTimeout(60_000);

describe('FeedSyncMachine beside a scoring run in flight', () => {
  beforeEach(async () => {
    resetFeedSyncMemory();
    await resetScoringWorld();
    watchScoring();
  });
  afterEach(async () => {
    await settleMachine();
    cleanupFeedSync();
    assertNoGatewayViolations();
  });

  const later = (ms: number) => jest.setSystemTime(Date.now() + ms);
  const debugLog = () => (logger.debug as jest.Mock).mock.calls.map((c) => String(c[0]));
  const jobPosts = () => gatewayCalls('job').length;
  const newIds = ids(5, 'n');

  describe('a sync that starts while a scoring run is in flight', () => {
    it('still fetches and hydrates, but hands nothing to the live run and does not score', async () => {
      const runId = await buildRunningPipeline();
      const postsBefore = jobPosts();
      const scoredBefore = scoredIds().length;
      await serveNew([...ids(6, 'p'), ...newIds]);
      const t = makeCtx();
      const sent = recordOps();

      await expect(advanceUntilDone(startMachine(t))).resolves.toBeUndefined();

      expect(await sent.count('GetArticlesForTopicsByIds')).toBeGreaterThan(0);
      const rows = await rowsById();
      expect(newIds.every((id) => rows.has(id))).toBe(true); // hydrated and persisted
      expect(jobPosts()).toBe(postsBefore); // nothing new reached the gateway
      expect(scoredIds().length).toBe(scoredBefore);
      expect(scoreEntries).toEqual([]); // the scoring step never ran
      expect(await currentRunId()).toBe(runId); // the live run was left alone
      expect(feedSyncMachine.state).toBe('done');
      expect(t.markNoOp).not.toHaveBeenCalled(); // real work happened
      expect(debugLog().some((m) => m.includes('fetching without scoring'))).toBe(true);
    });

    it('leaves the new rows unscored for the live run to pick up when it finalizes', async () => {
      await buildRunningPipeline();
      await serveNew([...ids(6, 'p'), ...newIds]);

      await advanceUntilDone(startMachine());

      const rows = await rowsById();
      expect(newIds.map((id) => rows.get(id)?.status)).toEqual(newIds.map(() => 'unscored'));
    });

    // The live run owned the backlog when this sync started, so the hydrate suppressed its enqueue.
    // If that run finishes while the sync is still hydrating, the pipeline's own post-finalize kick
    // has already come and gone, and the tail flush of the hydrate is the only thing left to hand
    // the new rows over. Without it they wait out the 30 minute staleness escape.
    it('takes the handoff itself when the live run finishes while the sync is still hydrating', async () => {
      await buildRunningPipeline();
      const hold = gate();
      const served = await serveNew([...ids(6, 'p'), ...newIds], { gate: () => hold.held });
      const running = startMachine();
      await waitFor(() => served.stats.requests.length > 0, 'the hydrate to be in flight');
      server.use(...mockGateway(defaultResponder, { pendingPolls: 0 })); // the live run's jobs can now finish
      for (let i = 0; i < 20 && (await getPipelineStatus()) === 'running'; i++) await tick();
      expect(await getPipelineStatus()).toBe('idle');

      hold.release();
      await advanceUntilDone(running);
      for (let i = 0; i < 20 && !newIds.every((id) => scoredIds().includes(id)); i++) await tick();

      expect(scoreEntries).toEqual([]); // this sync never called the scoring step
      expect(newIds.every((id) => scoredIds().includes(id))).toBe(true);
    });

    it('on a quiet poll does not claim a processing run finished while one is still in flight', async () => {
      await buildRunningPipeline();
      await serveNew(ids(6, 'p')); // nothing new for the device
      const before = useForYouStore.getState().lastProcessingRunFinishedAt;

      await advanceUntilDone(startMachine());

      expect(scoreEntries).toEqual([]);
      expect(useForYouStore.getState().lastProcessingRunFinishedAt).toBe(before);
      expect(feedSyncMachine.state).toBe('done');
    });

    it('runs the cycle normally, scoring included, when no run is in flight', async () => {
      await serveNew(ids(5));

      await advanceUntilDone(startMachine());
      await advanceUntilDone(tickUntilScored(5));

      expect(scoreEntries).toHaveLength(1);
      expect(scoredIds().sort()).toEqual(ids(5));
    });
  });

  describe('the stale guard', () => {
    /** The verdict the guard sees, read through the pipeline's own question. */
    const verdict = () => staleRunVerdict(Date.now());

    it('leaves a fresh run alone', async () => {
      const runId = await buildRunningPipeline();
      await serveNew([...ids(6, 'p'), ...newIds]);
      later(STALE_RUN_GUARD_MS - 60_000);
      expect(await verdict()).toBe('fresh');

      await advanceUntilDone(startMachine());

      expect(await currentRunId()).toBe(runId);
      expect(scoreEntries).toEqual([]);
    });

    // THE TRAP. A run the OS task submitted overnight is hours old by the first open, and its
    // results are still inside the gateway's 24h window. Age alone used to abort it, before
    // inference-recover (registered after feed-sync) could collect it.
    it.each([
      ['20 minutes', 20 * 60_000],
      ['10 hours', 10 * 3_600_000],
      ['just inside the collect window', COLLECT_WINDOW_MS - 3_600_000],
    ])('NEVER aborts a run that is %s old but collectable: its results are still at the gateway', async (_label, age) => {
      const runId = await buildRunningPipeline();
      await serveNew([...ids(6, 'p'), ...newIds]);
      later(age);
      expect(await verdict()).toBe('collectable');

      await advanceUntilDone(startMachine());

      expect(await currentRunId()).toBe(runId); // not aborted
      expect(scoreEntries).toEqual([]); // and the sync did not score over it
      const rows = await rowsById();
      expect(newIds.every((id) => rows.has(id))).toBe(true);
    });

    it('aborts a WEDGED run (nothing collectable left) and proceeds with the sync in full', async () => {
      const runId = await buildRunningPipeline();
      server.use(...mockGateway(defaultResponder)); // jobs finish from here on
      await serveNew([...ids(6, 'p'), ...newIds]);
      later(COLLECT_WINDOW_MS + 30 * 60_000);
      expect(await verdict()).toBe('wedged');

      await advanceUntilDone(startMachine());

      expect(await currentRunId()).not.toBe(runId); // the wedged run is gone (or replaced)
      expect(scoreEntries).toHaveLength(1); // and this sync scored
      expect(feedSyncMachine.state).toBe('done');
      for (let i = 0; i < 20 && !newIds.every((id) => scoredIds().includes(id)); i++) await tick();
      expect(newIds.every((id) => scoredIds().includes(id))).toBe(true);
    });
  });
});
