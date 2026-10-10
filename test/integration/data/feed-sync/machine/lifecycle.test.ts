// FeedSyncMachine from start() to its terminal state: the real machine, steps, in-memory DB, MSW,
// the real for-you store, and the gateway mock wherever scoring runs. Only the clock, the logger
// and expo-keep-awake are faked; the scoring step is the real one, watched through a call-through spy.
// Replaces the state, happy path, no-new-articles, error, terminal-outcome, abort, resume and
// count blocks of lib/scheduler/feed-sync/__tests__/FeedSyncMachine.test.ts.
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

import database from '@/lib/database';
import { batchMarkExcluded } from '@/lib/database/services/article-suggestion-scoring-writes';
import logger from '@/lib/logger';
import * as persistence from '@/lib/scheduler/feed-sync/feed-sync-persistence';
import * as steps from '@/lib/scheduler/feed-sync/feed-sync-steps';
import { HYDRATE_CHUNK_SIZE, HYDRATE_CONCURRENCY } from '@/lib/scheduler/feed-sync/feed-sync-steps';
import { InvalidTransitionError, STALE_MACHINE_AGE_MS } from '@/lib/scheduler/feed-sync/feed-sync-types';
import * as scoringPipeline from '@/lib/services/scoring-pipeline';
import { useForYouStore } from '@/lib/stores/for-you-store';
import { toastManager } from '@/lib/toast-manager';
import { advanceUntilDone, graphql, HttpResponse, mockGql, server } from '@/test/helpers';
import {
  art,
  cleanupFeedSync,
  fetchAndDiff,
  hydrate,
  ids,
  makeCtx,
  recordOps,
  resetFeedSyncMemory,
  resetScoringWorld,
  rowsById,
  scoredIds,
  seedInterest,
  seedTracked,
  serveHydrate,
  servePersona,
  spyOnExport,
  tickUntilScored,
} from '../steps/support';
import {
  feedSyncMachine,
  gate,
  fetchStep,
  keepAwake,
  loadMachineSnapshot,
  recordMachine,
  watchScoring,
  scoreEntries,
  serveNew,
  settleMachine,
  startMachine,
  waitFor,
  watchNetworkSubscriptions,
} from './support';

jest.setTimeout(60_000);

const store = () => useForYouStore.getState();
const run = (t = makeCtx()) => advanceUntilDone(startMachine(t));
const compress = <T>(xs: T[]) => xs.filter((x, i) => i === 0 || x !== xs[i - 1]);
const captured = () => (logger.captureException as jest.Mock).mock.calls;
const infoLog = () => (logger.info as jest.Mock).mock.calls.map((c) => String(c[0]));
const quietToasts = () => spyOnExport(toastManager, 'showNotifiedToast').mockResolvedValue(undefined as never);

// The outer describe is what puts settleMachine BEFORE the setup file's afterEach (which puts real
// timers back): jest runs an inner describe's hooks first.
describe('FeedSyncMachine lifecycle', () => {
  beforeEach(async () => {
    resetFeedSyncMemory();
    await resetScoringWorld();
    watchScoring();
  });
  afterEach(async () => {
    await settleMachine();
    cleanupFeedSync();
  });

  // Must be the first test of the file: every later test leaves the singleton in done / failed / idle.
  describe('a machine that has never run', () => {
    it('is idle and not running', () => {
      expect(feedSyncMachine.state).toBe('idle');
      expect(feedSyncMachine.isRunning()).toBe(false);
    });
  });

  describe('a run with new articles', () => {
    it('walks fetch, diff, hydrate and score to done, publishing only from hydrating onward', async () => {
      await serveNew(ids(6));
      const rec = recordMachine();

      await run();

      expect(rec.internal).toEqual(['fetching-topic-ids', 'diffing', 'hydrating', 'scoring']);
      // a bare poll is silent until there is real work: no fetching or diffing, and `persisting` is gone
      expect(compress(rec.published)).toEqual(['hydrating', 'scoring', 'done']);
      expect(feedSyncMachine.state).toBe('done');
      expect(feedSyncMachine.isRunning()).toBe(false);
      rec.stop();
    });

    it('persists the rows, scores them through the gateway and stamps when new articles arrived', async () => {
      const all = ids(6);
      await serveNew(all);
      expect(store().lastNewArticlesAt).toBeNull();

      await run();
      await advanceUntilDone(tickUntilScored(all.length));

      expect([...(await rowsById()).keys()].sort()).toEqual(all);
      expect(scoredIds().sort()).toEqual(all);
      expect(store().lastNewArticlesAt).toEqual(expect.any(Number)); // F16
      expect(store().lastSyncAt).toEqual(expect.any(Number));
      expect(store().suggestions.length).toBeGreaterThan(0); // the final store refresh landed
    });

    // Chunk refreshes are throttled to one per 1.5s, so a second chunk's rows reach the store only
    // through the flush that follows the hydrate. Scoring must start from a store that shows them all.
    it('lands every hydrated chunk in the store before scoring starts', async () => {
      const all = ids(HYDRATE_CHUNK_SIZE * 2);
      await serveNew(all);

      await run();

      const rows = (await rowsById()).size;
      expect(rows).toBe(all.length);
      expect(scoreEntries).toHaveLength(1);
      expect(scoreEntries[0].storeRows).toBeGreaterThan(HYDRATE_CHUNK_SIZE);
      expect(scoreEntries[0].storeRows).toBe(store().suggestions.length);
    });

    it('has already handed the rows to the scoring pipeline while hydrating, before the scoring step is called', async () => {
      await serveNew(ids(6));

      await run();

      expect(scoreEntries).toHaveLength(1);
      expect(scoreEntries[0].pipelineRun).toBe(true); // the foreground enqueue ran inside the hydrate
    });

    it('lets go of the network subscription it took', async () => {
      await serveNew(ids(3));
      const subscriptions = watchNetworkSubscriptions();

      await run();

      expect(subscriptions.calls()).toBe(1);
      expect(subscriptions.live()).toBe(0);
    });

    it('does not stamp new-articles-arrived when hydration inserted nothing', async () => {
      await serveNew(ids(4), { respond: () => ({ articles: [] }) });

      await run();

      expect(await rowsById()).toEqual(new Map());
      expect(store().lastNewArticlesAt).toBeNull();
      expect(feedSyncMachine.state).toBe('done');
    });

    it('keeps a snapshot of the current stage while running and clears it when done', async () => {
      await serveNew(ids(3));
      const held = gate();
      const fetch = fetchStep().hold(held.held);

      const running = startMachine();
      await fetch.reached(1);

      expect(await loadMachineSnapshot()).toEqual(expect.objectContaining({ state: 'fetching-topic-ids', startedAt: expect.any(Number) }));
      expect(feedSyncMachine.isRunning()).toBe(true);
      held.release();
      await advanceUntilDone(running);
      expect(await loadMachineSnapshot()).toBeNull();
    });

    it('clears an old scoring error at the start of the run', async () => {
      await serveNew(ids(3));
      store().setScoringError('server');
      const held = gate();
      const fetch = fetchStep().hold(held.held);

      const running = startMachine();
      await fetch.reached(1);

      expect(store().scoringError).toBeNull();
      held.release();
      await advanceUntilDone(running);
    });

    it('reports hydrate progress to the scheduler as it goes', async () => {
      await serveNew(ids(6));
      const t = makeCtx();

      await run(t);

      const reports = (t.ctx.reportProgress as jest.Mock).mock.calls.map((c) => c[0]);
      expect(reports).toContainEqual({ step: 'hydrating', current: expect.any(Number), total: 6 });
      expect(reports.at(-1)).toEqual({ step: 'hydrating', current: 6, total: 6 });
    });

    it('hands the done state back to idle after two seconds and clears the header', async () => {
      await serveNew(ids(3));
      const rec = recordMachine();
      await run();
      expect(feedSyncMachine.state).toBe('done'); // the clock follows wall time: only the lower bound is checked right away

      await jest.advanceTimersByTimeAsync(2_100);

      expect(feedSyncMachine.state).toBe('idle');
      expect(store().syncStatusMessage).toBeNull();
      expect(rec.published.at(-1)).toBeNull();
      rec.stop();
    });

    it('survives a snapshot that cannot be cleared on the way out: the run still succeeds and reports it', async () => {
      await serveNew(ids(3));
      spyOnExport(persistence, 'clearMachineSnapshot').mockRejectedValueOnce(new Error('snap clear error'));

      await expect(run()).resolves.toBeUndefined();

      expect(captured()).toContainEqual([
        expect.objectContaining({ message: 'snap clear error' }),
        expect.objectContaining({ tags: expect.objectContaining({ step: 'clearMachineSnapshot' }) }),
      ]);
      expect(feedSyncMachine.state).toBe('done');
    });
  });

  describe('the article count', () => {
    it("is the server's 24h count when the server has one", async () => {
      await serveNew(ids(3));
      server.use(mockGql('GetRecentArticleCount', { recentArticleCount: 25 }));

      await run();

      expect(store().articleCount).toBe(25);
    });

    // DA43: a real zero from the server is shown as zero, and a failed count query (null) keeps the
    // last known figure instead of the topic-matched count.
    test('DA43: a real zero from the server is shown as zero', async () => {
      await serveNew(ids(5));
      store().setCounts(12, 0); // what an earlier run stored: a skipped write would leave 12
      server.use(mockGql('GetRecentArticleCount', { recentArticleCount: 0 }));

      await run();

      expect(store().articleCount).toBe(0);
    });

    test('DA43: a failed count keeps the last known figure', async () => {
      await serveNew(ids(5));
      store().setCounts(12, 0); // what an earlier run stored
      server.use(graphql.query('GetRecentArticleCount', () => HttpResponse.error()));

      await run();

      expect(store().articleCount).toBe(12);
      expect(feedSyncMachine.state).toBe('done');
    });
  });

  describe('a run with nothing new', () => {
    /** The device already holds every id the server lists; the rows are unscored and nothing was enqueued. */
    async function deviceAlreadyHolds(all: string[], { terminal = false } = {}) {
      await serveNew(all);
      const t = makeCtx();
      const { diff } = await advanceUntilDone(fetchAndDiff(t));
      await advanceUntilDone(hydrate(diff, t));
      expect((await rowsById()).size).toBe(all.length);
      // terminal rows leave no backlog, so no scoring pass can start a pipeline run that stamps by itself
      if (terminal) await batchMarkExcluded(all);
    }

    it('hydrates nothing, walks fetch, diff and scoring, and still scores the backlog an earlier run left', async () => {
      const all = ids(6);
      await deviceAlreadyHolds(all);
      const sent = recordOps();
      const rec = recordMachine();

      await run();
      await advanceUntilDone(tickUntilScored(all.length));

      expect(await sent.count('GetArticlesForTopicsByIds')).toBe(0);
      expect(rec.internal).toEqual(['fetching-topic-ids', 'diffing', 'scoring']);
      expect(scoredIds().sort()).toEqual(all);
      expect(feedSyncMachine.state).toBe('done');
      rec.stop();
    });

    it('is silent: nothing is published for a poll that found nothing', async () => {
      await deviceAlreadyHolds(ids(4), { terminal: true });
      const rec = recordMachine();

      await run();

      expect(rec.published).toEqual([]);
      expect(store().syncStatusMessage).toBeNull();
      rec.stop();
    });

    // THE TRAP. Both feed surfaces choose between the preparing card and the all-caught-up card on
    // lastProcessingRunFinishedAt, and on this path nothing else can ever stamp it: no rows are
    // enqueued, so no pipeline run exists, so the usual stamper never runs.
    it('stamps lastProcessingRunFinishedAt: a sync that found nothing still finished', async () => {
      await deviceAlreadyHolds(ids(4), { terminal: true });
      expect(store().lastProcessingRunFinishedAt).toBeNull();

      await run();

      expect(store().lastProcessingRunFinishedAt).toEqual(expect.any(Number));
    });

    it('stamps lastSyncAt but not new-articles-arrived, so "Updated just now" does not reset on a quiet poll', async () => {
      await deviceAlreadyHolds(ids(4), { terminal: true });

      await run();

      expect(store().lastSyncAt).toEqual(expect.any(Number));
      expect(store().lastNewArticlesAt).toBeNull();
    });

    it('clears the snapshot, rests at done, and never arms the two second hand-back to idle', async () => {
      await deviceAlreadyHolds(ids(4), { terminal: true });
      const rec = recordMachine();

      await run();
      await jest.advanceTimersByTimeAsync(2_500);

      expect(await loadMachineSnapshot()).toBeNull();
      expect(feedSyncMachine.state).toBe('done');
      expect(rec.published).toEqual([]);
      rec.stop();
    });

    it('survives a snapshot that cannot be cleared: the run still succeeds and reports it', async () => {
      await deviceAlreadyHolds(ids(4), { terminal: true });
      spyOnExport(persistence, 'clearMachineSnapshot').mockRejectedValueOnce(new Error('snap clear error'));

      await expect(run()).resolves.toBeUndefined();

      expect(captured()).toContainEqual([
        expect.objectContaining({ message: 'snap clear error' }),
        expect.objectContaining({ tags: expect.objectContaining({ step: 'clearMachineSnapshot' }) }),
      ]);
    });
  });

  describe('the daily cap', () => {
    const RESET = '2026-10-10T00:00:00.000Z';

    it('a full clip is a normal outcome: banner up, status published, back to idle, resolved, no Sentry', async () => {
      await serveNew(ids(4), { respond: () => ({ articles: [], dailyLimitReached: true, resetAt: RESET }) });
      const notified = quietToasts();

      await expect(run()).resolves.toBeUndefined();

      expect(store().dailyLimitResetAt).toBe(Date.parse(RESET));
      expect(store().syncStatusMessage).toEqual(
        expect.objectContaining({ errorCode: 'daily-limit', retryAt: Date.parse(RESET), failedAtState: 'hydrating' }),
      );
      expect(feedSyncMachine.state).toBe('idle');
      expect(await loadMachineSnapshot()).toBeNull();
      expect(captured()).toEqual([]);
      expect(notified).not.toHaveBeenCalled(); // Y11: the Feed icon carries the limit, no notice
      expect(await database.get('notifications').query().fetchCount()).toBe(0);
    });

    it('falls back to the next UTC midnight when the server names no reset time', async () => {
      await serveNew(ids(4), { respond: () => ({ articles: [], dailyLimitReached: true }) });

      await run();

      const now = new Date(Date.now());
      expect(store().dailyLimitResetAt).toBe(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
    });

    it('a partial clip still delivers what fit and raises the banner with the server reset time', async () => {
      const all = ids(4);
      await serveNew(all, {
        respond: ({ ids: asked }) => ({
          articles: asked.slice(0, 1).map((id) => art(id)),
          dailyLimitReached: true,
          resetAt: RESET,
        }),
      });

      await run();

      expect([...(await rowsById()).keys()]).toEqual([all[0]]);
      expect(store().dailyLimitResetAt).toBe(Date.parse(RESET));
      expect(store().lastNewArticlesAt).toEqual(expect.any(Number));
      expect(feedSyncMachine.state).toBe('done');
    });

    it('a fully delivered run clears a banner left by an earlier clip once its reset time has passed', async () => {
      await serveNew(ids(3));
      store().setDailyLimitResetAt(Date.now() - 1);

      await run();

      expect(store().dailyLimitResetAt).toBeNull();
    });

    // Owner ruling: followed stories always keep updating, after the cap too. While the cap holds, the
    // metered ids stay out of the hydrate (the server would clip them) and the quota-free stories go through.
    it('while the cap holds, hydrates only the followed-story ids and keeps the banner', async () => {
      await seedTracked('titan inquiry');
      await seedInterest('I follow racing', ['formula 1']);
      const story = ids(3, 's');
      const metered = ids(3, 'm');
      const served = serveHydrate();
      server.use(servePersona({ topics: { 'titan inquiry': story, 'formula 1': metered } }), ...served.handlers);
      const holdsUntil = Date.now() + 3_600_000;
      store().setDailyLimitResetAt(holdsUntil);

      await run();

      expect(served.stats.requests.map((r) => r.op)).toEqual(['GetArticlesForStories']);
      expect([...(await rowsById()).keys()].sort()).toEqual([...story].sort());
      expect(store().dailyLimitResetAt).toBe(holdsUntil);
    });

    it('while the cap holds, a run with only metered ids sends no hydrate request and keeps the banner', async () => {
      await serveNew(ids(3));
      const holdsUntil = Date.now() + 3_600_000;
      store().setDailyLimitResetAt(holdsUntil);
      const sent = recordOps();

      await run();

      expect(await sent.count('GetArticlesForTopicsByIds')).toBe(0);
      expect([...(await rowsById()).keys()]).toEqual([]);
      expect(store().dailyLimitResetAt).toBe(holdsUntil);
    });
  });

  describe('no topics configured', () => {
    it('is a normal outcome: the add-interests status, back to idle, resolved, no Sentry, no failed snapshot', async () => {
      const saved = spyOnExport(persistence, 'saveMachineSnapshot');
      const sent = recordOps();

      await expect(run()).resolves.toBeUndefined();

      expect(store().syncStatusMessage).toEqual(
        expect.objectContaining({ errorCode: 'no-topics-configured', headlineKey: 'sync.noTopics' }),
      );
      expect(feedSyncMachine.state).toBe('idle');
      expect(await loadMachineSnapshot()).toBeNull();
      expect(saved).not.toHaveBeenCalledWith(expect.objectContaining({ state: 'failed' }));
      expect(captured()).toEqual([]);
      expect(await sent.count('GetArticleIdsForPersona')).toBe(0);
    });
  });

  describe('a terminal outcome whose snapshot cannot be cleared', () => {
    it('no-topics-configured: still ends quietly and reports the snapshot failure', async () => {
      spyOnExport(persistence, 'clearMachineSnapshot').mockRejectedValueOnce(new Error('snap clear error'));

      await expect(run()).resolves.toBeUndefined();

      expect(feedSyncMachine.state).toBe('idle');
      expect(captured()).toContainEqual([
        expect.objectContaining({ message: 'snap clear error' }),
        expect.objectContaining({ tags: expect.objectContaining({ step: 'clearMachineSnapshot' }) }),
      ]);
    });

    it('daily-limit: still ends quietly and reports the snapshot failure', async () => {
      await serveNew(ids(4), { respond: () => ({ articles: [], dailyLimitReached: true }) });
      spyOnExport(persistence, 'clearMachineSnapshot').mockRejectedValueOnce(new Error('snap clear error'));

      await expect(run()).resolves.toBeUndefined();

      expect(feedSyncMachine.state).toBe('idle');
      expect(captured()).toContainEqual([
        expect.objectContaining({ message: 'snap clear error' }),
        expect.objectContaining({ tags: expect.objectContaining({ step: 'clearMachineSnapshot' }) }),
      ]);
    });
  });

  describe('a step that throws', () => {
    it('fails the machine, publishes the classified code and the stage it failed at, and rejects with the cause', async () => {
      await serveNew(ids(3));
      spyOnExport(steps, 'stepFetchTopicIds').mockRejectedValueOnce(new Error('fetch failed'));

      await expect(run()).rejects.toThrow('fetch failed');

      expect(feedSyncMachine.state).toBe('failed');
      expect(store().syncStatusMessage).toEqual(
        expect.objectContaining({ state: 'failed', errorCode: 'server-unreachable', failedAtState: 'fetching-topic-ids', isRecoverable: true }),
      );
    });

    it('persists a failed snapshot carrying the code', async () => {
      await serveNew(ids(3));
      spyOnExport(steps, 'stepFetchTopicIds').mockRejectedValueOnce(new Error('disk full'));

      await expect(run()).rejects.toThrow('disk full');

      expect(await loadMachineSnapshot()).toEqual(expect.objectContaining({ state: 'failed', errorCode: 'storage-error' }));
    });

    it('releases the wake lock it took', async () => {
      await serveNew(ids(3));
      spyOnExport(steps, 'stepFetchTopicIds').mockRejectedValueOnce(new Error('boom'));

      await expect(run()).rejects.toThrow('boom');

      expect(keepAwake.tags()).toEqual({ taken: ['mera-feed-sync'], released: ['mera-feed-sync'] });
    });

    it('writes no notice or inbox row for a failed sync (Y11: the Feed icon carries it)', async () => {
      await serveNew(ids(3));
      spyOnExport(steps, 'stepFetchTopicIds').mockRejectedValueOnce(new Error('boom'));
      const notified = quietToasts();

      await expect(run()).rejects.toThrow('boom');

      expect(notified).not.toHaveBeenCalled();
      expect(await database.get('notifications').query().fetchCount()).toBe(0);
    });

    it('a real server failure on the persona query fails the same way', async () => {
      await serveNew(ids(3));
      server.use(graphql.query('GetArticleIdsForPersona', () => HttpResponse.error()));

      await expect(run()).rejects.toBeDefined();

      expect(feedSyncMachine.state).toBe('failed');
      expect(store().syncStatusMessage).toEqual(expect.objectContaining({ state: 'failed', errorCode: 'server-unreachable' }));
    });

    it('keeps the ORIGINAL error when the failure comes before the first transition', async () => {
      // the pipeline check runs while the machine is still idle, and idle allows only fetching-topic-ids
      await serveNew(ids(3));
      spyOnExport(scoringPipeline, 'getPipelineStatus').mockRejectedValueOnce(new Error('pipeline exploded'));
      const rec = recordMachine();

      await expect(run()).rejects.toThrow('pipeline exploded');

      expect(feedSyncMachine.state).toBe('failed');
      expect(rec.published).toEqual(['failed']); // published once, not skipped and not doubled
      expect(await loadMachineSnapshot()).toEqual(expect.objectContaining({ state: 'failed' }));
      rec.stop();
    });

    it('the next run starts clean after a failed one', async () => {
      await serveNew(ids(3));
      spyOnExport(steps, 'stepFetchTopicIds').mockRejectedValueOnce(new Error('step error'));
      await expect(run()).rejects.toThrow('step error');
      expect(feedSyncMachine.state).toBe('failed');

      await run();

      expect(feedSyncMachine.state).toBe('done');
    });
  });

  describe('an invalid transition', () => {
    it('throws InvalidTransitionError for the run that owns the machine', () => {
      // No seam reaches a bad pair on purpose: the live run's transitions are linear. The only way
      // to stage one is to put the singleton in a state its own run would never leave it in.
      const machine = feedSyncMachine as unknown as { _state: string; _runSeq: number; _transitionTo(next: string, runId: number): void };
      machine._state = 'done';

      expect(() => machine._transitionTo('diffing', machine._runSeq)).toThrow(InvalidTransitionError);
      machine._state = 'idle';
    });
  });

  describe('an abort', () => {
    it('before the run starts: no request goes out, the job is marked a no-op, nothing is captured', async () => {
      await serveNew(ids(3));
      const t = makeCtx();
      t.abort();
      const sent = recordOps();

      await expect(run(t)).resolves.toBeUndefined();

      expect(await sent.count('GetArticleIdsForPersona')).toBe(0);
      expect(t.markNoOp).toHaveBeenCalled();
      expect(captured()).toEqual([]);
      expect(store().syncStatusMessage).toBeNull();
    });

    it('during fetching-topic-ids, before the step resolves: ends cleanly before the diff and hydrates nothing', async () => {
      await serveNew(ids(3));
      const held = gate();
      const fetch = fetchStep().hold(held.held, { after: true }); // the step has its answer, but has not returned it
      const t = makeCtx();
      const sent = recordOps();
      const running = startMachine(t);
      await fetch.reached(1);
      await waitFor(async () => (await sent.count('GetArticleIdsForPersona')) >= 1, 'the persona request');

      t.abort();
      held.release();
      await expect(advanceUntilDone(running)).resolves.toBeUndefined();

      expect(await sent.count('GetArticlesForTopicsByIds')).toBe(0);
      expect(await rowsById()).toEqual(new Map());
      expect(t.markNoOp).toHaveBeenCalled();
      expect(captured()).toEqual([]);
      expect(store().syncStatusMessage).toBeNull();
      expect(feedSyncMachine.state).not.toBe('failed');
    });

    // More chunks than hydrate workers, so a worker loops again after the abort and meets the
    // step's own signal check, not only the machine's check after the step returns.
    it('during hydrating: ends cleanly, scoring never starts, nothing is published as a failure', async () => {
      const hold = gate();
      const served = await serveNew(ids(HYDRATE_CHUNK_SIZE * (HYDRATE_CONCURRENCY + 2)), { gate: () => hold.held });
      const t = makeCtx();
      const running = startMachine(t);
      await waitFor(() => served.stats.requests.length >= HYDRATE_CONCURRENCY, 'the hydrate workers to be in flight');

      t.abort();
      hold.release();
      await expect(advanceUntilDone(running)).resolves.toBeUndefined();

      expect(t.markNoOp).toHaveBeenCalled();
      expect(captured()).toEqual([]);
      expect(feedSyncMachine.state).not.toBe('failed');
      expect(store().syncStatusMessage?.state).not.toBe('failed');
      expect(await loadMachineSnapshot()).not.toEqual(expect.objectContaining({ state: 'failed' }));
    });

    // The diff is a local read, so the only way to land an abort between the diff and the next stage
    // is to delay its return (race ordering, R23b): the real step runs, then the spy holds the answer.
    async function abortWhileDiffing({ quiet }: { quiet: boolean }) {
      const all = ids(3);
      await serveNew(all);
      if (quiet) {
        const setup = makeCtx();
        const { diff } = await advanceUntilDone(fetchAndDiff(setup));
        await advanceUntilDone(hydrate(diff, setup));
        await batchMarkExcluded(all);
      }
      const held = gate();
      const original = steps.stepDiff;
      spyOnExport(steps, 'stepDiff').mockImplementation(async (fetched, ctx) => {
        const diff = await original(fetched, ctx);
        await held.held;
        return diff;
      });
      const t = makeCtx();
      const sent = recordOps();
      const running = startMachine(t);
      await waitFor(() => feedSyncMachine.state === 'diffing', 'the diff to start');

      t.abort();
      held.release();
      await expect(advanceUntilDone(running)).resolves.toBeUndefined();
      return { t, sent };
    }

    it('during the diff of a quiet poll: ends before scoring starts and does not claim a finished run', async () => {
      const { t } = await abortWhileDiffing({ quiet: true });

      expect(scoreEntries).toEqual([]);
      expect(t.markNoOp).toHaveBeenCalled();
      expect(store().lastProcessingRunFinishedAt).toBeNull();
      expect(captured()).toEqual([]);
    });

    it('during the diff of a run with new articles: ends before anything is hydrated', async () => {
      const { t, sent } = await abortWhileDiffing({ quiet: false });

      expect(await sent.count('GetArticlesForTopicsByIds')).toBe(0);
      expect(t.markNoOp).toHaveBeenCalled();
      expect(captured()).toEqual([]);
    });

    // DATA-U6b-2. An aborted run returns from wherever it was and walks the machine back to idle,
    // so the singleton does not keep a mid-run state with nothing in flight.
    describe('DATA-U6b-2: once an aborted run has returned', () => {
      test('DA16: isRunning() is false, since no run is in flight', async () => {
        await abortWhileDiffing({ quiet: true });

        expect(feedSyncMachine.isRunning()).toBe(false);
      });
    });

    it('after the hydrate returns: the rows stay and scoring never starts', async () => {
      const all = ids(4);
      const hold = gate();
      const served = await serveNew(all, { gate: () => hold.held });
      const t = makeCtx();
      const running = startMachine(t);
      await waitFor(() => served.stats.requests.length >= 1, 'the hydrate to be in flight');

      t.abort();
      hold.release();
      await expect(advanceUntilDone(running)).resolves.toBeUndefined();

      expect([...(await rowsById()).keys()].sort()).toEqual(all);
      expect(t.markNoOp).toHaveBeenCalled();
      expect(captured()).toEqual([]);
      expect(feedSyncMachine.state).not.toBe('done');
    });
  });

  describe('resuming from persisted state', () => {
    it('says so when a valid, non-idle snapshot is waiting, and runs fresh anyway', async () => {
      await serveNew(ids(3));
      await persistence.saveMachineSnapshot({ state: 'hydrating', startedAt: Date.now() - 1_000 });

      await run();

      expect(infoLog()).toContain('[FeedSyncMachine] resuming from persisted state: hydrating');
      expect(feedSyncMachine.state).toBe('done');
      expect(await loadMachineSnapshot()).toBeNull();
    });

    it('does not say so for an idle snapshot', async () => {
      await serveNew(ids(3));
      await persistence.saveMachineSnapshot({ state: 'idle', startedAt: Date.now() - 1_000 });

      await run();

      expect(infoLog().some((m) => m.includes('resuming from persisted state'))).toBe(false);
    });

    it('starts fresh, without resuming, when the snapshot is older than the stale age', async () => {
      await serveNew(ids(3));
      await persistence.saveMachineSnapshot({ state: 'hydrating', startedAt: Date.now() - STALE_MACHINE_AGE_MS - 1_000 });

      await run();

      expect(infoLog().some((m) => m.includes('resuming from persisted state'))).toBe(false);
      expect(feedSyncMachine.state).toBe('done');
    });

    it('still resumes a snapshot that is just inside the stale age', async () => {
      await serveNew(ids(3));
      await persistence.saveMachineSnapshot({ state: 'scoring', startedAt: Date.now() - STALE_MACHINE_AGE_MS + 60_000 });

      await run();

      expect(infoLog()).toContain('[FeedSyncMachine] resuming from persisted state: scoring');
    });
  });
});
