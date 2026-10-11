// Seam tests for the FeedSyncMachine mutants the legacy suites killed and the seam suites left
// alive (Stryker G19/G37): the foreground store flush in the finally, the
// `suppressEnqueue` expression of the hydrate call, and the background `onHydrated` hook.
// Public API only: the machine, the for-you store, the scoring pipeline's status, the MSW edge.
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

import * as realTimers from 'node:timers';
import { getPipeline } from '@/lib/database/services/scoring-pipeline-store';
import { getPipelineStatus, MIN_DISPATCH } from '@/lib/services/scoring-pipeline';
import { useForYouStore } from '@/lib/stores/for-you-store';
import { advanceUntilDone, assertNoGatewayViolations, gatewayCalls, graphql, HttpResponse, server } from '@/test/helpers';
import { cleanupFeedSync, ids, resetFeedSyncMemory, resetScoringWorld, rowsById, seedInterest, serveHydrate, servePersona } from '../steps/support';
import { backgroundHooks, buildRunningPipeline, oid, serveNew, settleMachine, startMachine, watchScoring } from './support';

jest.setTimeout(60_000);

const store = () => useForYouStore.getState();
const jobPosts = () => gatewayCalls('job').length;
const batchCount = async () => (await getPipeline())?.run.batches.length ?? 0;
// node:timers is not touched by the fake clock, so this is a real 5 ms wait
const tickReal = () => new Promise<void>((resolve) => realTimers.setTimeout(resolve, 5));

/** Lets the machine and the fake clock move until `cond` holds or `maxMs` of fake time passes; never throws. */
async function until(cond: () => boolean | Promise<boolean>, maxMs = 3000): Promise<boolean> {
  for (let elapsed = 0; elapsed < maxMs; elapsed += 50) {
    if (await cond()) return true;
    await jest.advanceTimersByTimeAsync(50);
    await tickReal();
  }
  return cond();
}

/**
 * Runs `promise` to its end while moving the fake clock by nothing: only timers already due (the
 * zero-delay yields) fire, so a coalesced refresh timer 1.5s away never comes due. Returns its outcome.
 */
async function driveWithoutTime<T>(promise: Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
  let outcome: { ok: true; value: T } | { ok: false; error: unknown } | undefined;
  promise.then(
    (value) => (outcome = { ok: true, value }),
    (error) => (outcome = { ok: false, error }),
  );
  for (let i = 0; i < 4000 && !outcome; i++) {
    await jest.advanceTimersByTimeAsync(0);
    await tickReal();
  }
  if (!outcome) throw new Error('the run did not settle');
  return outcome;
}

describe('FeedSyncMachine: mutants only the legacy suites killed (G19/G37)', () => {
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

  describe('the foreground store flush in the finally', () => {
    it('a run that throws after persisted chunks leaves the store showing every row the DB holds, without any clock moving afterwards', async () => {
      // 3 chunks of 25: the first persists and refreshes at once, the second's refresh is coalesced into
      // a trailing timer, the third's request is refused for good. Only the finally's flush can land the second.
      await serveNew(ids(75, 'f'));
      let arrivals = 0;
      server.use(
        graphql.query('GetArticlesForTopicsByIds', async () => {
          arrivals += 1;
          if (arrivals !== 3) return undefined; // falls through to the default hydrate handler
          // wait in real time only: the fake clock must not reach the coalesced refresh timer
          for (let i = 0; i < 2000 && (await rowsById()).size < 50; i++) await tickReal();
          return HttpResponse.json({
            data: null,
            errors: [{ message: 'refused', extensions: { code: 'BAD_USER_INPUT' } }],
          });
        }),
      );

      const outcome = await driveWithoutTime(startMachine());

      expect(outcome.ok).toBe(false);

      const held = [...(await rowsById()).keys()].sort();
      expect(held.length).toBeGreaterThanOrEqual(50);
      expect(store().suggestions.map((s) => s.articleId).sort()).toEqual(held);
    });
  });

  describe('what the hydrate call is told about enqueueing', () => {
    it('a background run enqueues nothing in the hydrate: no job is posted and the pipeline stays idle', async () => {
      const fresh = Array.from({ length: MIN_DISPATCH * 3 }, (_, i) => oid(i + 1));
      await seedInterest('I follow racing', ['formula 1']);
      const served = serveHydrate();
      server.use(servePersona({ topics: { 'formula 1': fresh } }), ...served.handlers);
      const hooks = backgroundHooks({ submit: false });

      await advanceUntilDone(startMachine(undefined, { background: hooks.hooks }));

      expect((await rowsById()).size).toBe(fresh.length);
      expect(jobPosts()).toBe(0);
      expect(await getPipelineStatus()).toBe('idle');
    });

    it('a foreground run beside a scoring run in flight posts no new job and leaves the new rows unscored', async () => {
      await buildRunningPipeline();
      const postsBefore = jobPosts();
      const fresh = ids(MIN_DISPATCH * 3, 'n');
      await serveNew([...ids(6, 'p'), ...fresh]);

      await advanceUntilDone(startMachine());

      expect(jobPosts()).toBe(postsBefore);
      const handed = new Set((await getPipeline())!.run.batches.flatMap((b) => b.candidateIds));
      expect(fresh.filter((id) => handed.has(id))).toEqual([]); // the live run was handed none of them
      const rows = await rowsById();
      expect(fresh.map((id) => rows.get(id)?.status)).toEqual(fresh.map(() => 'unscored'));
    });

    it('a foreground run with nothing in flight hands its first batch to the pipeline before the last chunk is requested', async () => {
      const all = ids(50, 'g'); // two chunks of 25, far over the dispatch floor in the first
      await serveNew(all);
      let arrivals = 0;
      let batchesAtLastRequest = -1;
      server.use(
        graphql.query('GetArticlesForTopicsByIds', async () => {
          arrivals += 1;
          if (arrivals < 2) return undefined;
          // the second (last) request waits for the first chunk's greedy dispatch (a batch in the pipeline run), up to 20s of fake time
          await until(async () => (await batchCount()) > 0, 20_000);
          batchesAtLastRequest = await batchCount();
          return undefined;
        }),
      );

      await advanceUntilDone(startMachine());

      expect(batchesAtLastRequest).toBeGreaterThan(0);
    });
  });

  describe('the background hydrate result reaches the hook', () => {
    it('calls onHydrated once with the metered count and the cap flag of the hydrate', async () => {
      const fresh = Array.from({ length: 6 }, (_, i) => oid(i + 1));
      await seedInterest('I follow racing', ['formula 1']);
      const served = serveHydrate();
      server.use(servePersona({ topics: { 'formula 1': fresh } }), ...served.handlers);
      const hooks = backgroundHooks();
      const onHydrated = jest.fn(hooks.hooks.onHydrated);

      await advanceUntilDone(startMachine(undefined, { background: { ...hooks.hooks, onHydrated } }));

      expect(onHydrated).toHaveBeenCalledTimes(1);
      expect(onHydrated).toHaveBeenCalledWith({ meteredDelivered: 6, dailyLimitReached: false });
    });
  });
});
