// for-you-store against the real article_suggestions rows (landed by a real feed sync: interest,
// persona ids, hydrate, persist) and the real `feed_metadata` row. The pipeline half of
// hydrateMetadataFromDb, which needs a scoring run in flight, is for-you-store-pipeline.test.ts.
// The `await import('@/lib/services/scoring-pipeline')` inside hydrateMetadataFromDb is a REAL branch
// here: the success cases assert restored values AND that the call site never reported a failure.
// Replaces lib/stores/__tests__/for-you-store.test.ts (which mocked article-suggestion-service and
// scoring-pipeline, so hydrateMetadataFromDb only ever ran its catch).
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

import logger from '@/lib/logger';
import { ArticleSuggestionStatus } from '@/lib/database/article-suggestion-status';
import {
  batchMarkExcluded,
  loadFeedMetadata,
  loadSuggestions,
  persistFeedMetadata,
  saveScoringResult,
  type FeedMetadata,
} from '@/lib/database/services/article-suggestion-service';
import { getFacts, removeFactMetadataTopics } from '@/lib/database/services/fact-service';
import { getSetting, setSetting } from '@/lib/database/services/setting-service';
import { batchMarkAlreadyRead } from '@/lib/feed-grouping/read-story-filter';
import { useForYouStore, type ForYouSuggestion } from '@/lib/stores/for-you-store';
import { server, useStrictClock } from '@/test/helpers';
import {
  cleanupFeedSync,
  fetchAndDiff,
  hydrate,
  ids,
  makeCtx,
  resetFeedSyncMemory,
  seedInterest,
  servePersona,
  serveHydrate,
} from '../../feed-sync/steps/support';
import { drainWrites, failSettingRead, failSettingWrite, failTableQuery, resetStore, restoreFaults, settle, until, watchWrites } from './support';

jest.setTimeout(30_000);

const NOW = Date.parse('2026-10-09T10:00:00.000Z');
const META_KEY = 'feed_metadata';
const store = () => useForYouStore.getState();

/** Lands unscored `article_suggestions` rows the way a sync does: topic ids, diff, hydrate, persist. */
async function land(topics: Record<string, string[]>) {
  const t = makeCtx();
  for (const text of Object.keys(topics)) await seedInterest(`I follow ${text}`, [text]);
  server.use(servePersona({ topics }), ...serveHydrate().handlers);
  const { diff } = await fetchAndDiff(t);
  await hydrate(diff, t);
}

/** Drops `text` from its fact's metadata topics: the rows it retrieved are now orphans. */
async function dropTopic(text: string) {
  const fact = (await getFacts()).find((f) => f.statement === `I follow ${text}`)!;
  await removeFactMetadataTopics(fact.id, [text]);
}

const scored = (relevance: number) => ({ relevance, reason: '', reasonSkipped: true });

/** A suggestion for the store-only cases (the store takes whatever the sync hands it). */
function suggestion(id: string, over: Partial<ForYouSuggestion> = {}): ForYouSuggestion {
  return {
    _id: id,
    articleId: `art-${id}`,
    clusters: [],
    relevance: 0.9,
    reason: '',
    status: ArticleSuggestionStatus.Complete,
    country_code: null,
    language_code: 'en',
    publication_name: 'Pub',
    title_en: `Story ${id}`,
    title_original: `Story ${id}`,
    description_en: null,
    article_url: null,
    image_url: null,
    userTopicIds: [],
    createdAt: new Date(NOW).toISOString(),
    firstPubDate: new Date(NOW).toISOString(),
    rawScore: null,
    eventType: null,
    headlineScope: null,
    matchedTopics: [],
    ...over,
  };
}

const SEED: FeedMetadata = {
  articleCount: 11,
  relevantArticleCount: 7,
  hasGeneratedTopics: false,
  lastProcessingRunFinishedAt: 5000,
  lastNewArticlesAt: 4321,
};

/** Metadata on disk, loaded into the store through the real boot path. */
async function bootWith(meta: FeedMetadata = SEED) {
  await persistFeedMetadata(meta);
  await store().hydrateMetadataFromDb();
}

/** Waits for the row to differ from `before`, then returns it parsed. */
async function metaChangedFrom(before: string | null): Promise<FeedMetadata> {
  await until(async () => (await getSetting(META_KEY)) !== before, 'feed_metadata to change');
  return (await loadFeedMetadata()) as FeedMetadata;
}

const reportedFor = (method: string) =>
  (logger.captureException as jest.Mock).mock.calls.filter((c) => c[1]?.tags?.method === method);

describe('useForYouStore', () => {
  beforeEach(() => {
    resetFeedSyncMemory();
  });
  afterEach(async () => {
    restoreFaults();
    cleanupFeedSync();
    await drainWrites();
  });

  describe('state setters', () => {
    it('starts empty, idle and unhydrated', () => {
      expect(store()).toMatchObject({
        suggestions: [],
        articleCount: 0,
        relevantArticleCount: 0,
        hasGeneratedTopics: true,
        unscoredCount: 0,
        asyncJobPhase: 'idle',
        batchProgress: null,
        chunkStates: null,
        suggestionsHydrated: false,
        lastProcessingRunFinishedAt: null,
        lastNewArticlesAt: null,
        dailyLimitResetAt: null,
      });
      expect(store().reasonsInFlightIds.size).toBe(0);
    });

    it('setSuggestions replaces everything and resets the cursor', () => {
      store().setPagination('old', false);
      store().setSuggestions([suggestion('s1'), suggestion('s2')]);
      store().setSuggestions([suggestion('s3')]);
      expect(store().suggestions.map((s) => s._id)).toEqual(['s3']);
      expect(store().endCursor).toBeNull();
      expect(store().hasNextPage).toBe(true);
    });

    it('appendSuggestions appends with the new pagination, also onto an empty list', () => {
      store().appendSuggestions([suggestion('s1')], null, false);
      expect(store().suggestions.map((s) => s._id)).toEqual(['s1']);
      store().appendSuggestions([suggestion('s2')], 'cursor-abc', false);
      expect(store().suggestions.map((s) => s._id)).toEqual(['s1', 's2']);
      expect(store().endCursor).toBe('cursor-abc');
      expect(store().hasNextPage).toBe(false);
    });

    it('setPagination and setUnscoredCount set their fields', () => {
      store().setPagination('cursor-xyz', false);
      store().setUnscoredCount(7);
      expect(store()).toMatchObject({ endCursor: 'cursor-xyz', hasNextPage: false, unscoredCount: 7 });
    });

    it('device processing: start, progress ratio, a larger total expands, zero total is safe, finish', () => {
      store().startDeviceProcessing(100);
      expect(store()).toMatchObject({ isDeviceProcessing: true, deviceTotalCount: 100, deviceProcessProgress: 0, deviceProcessedCount: 0 });

      store().updateDeviceProgress(25);
      expect(store().deviceProcessedCount).toBe(25);
      expect(store().deviceProcessProgress).toBeCloseTo(0.25);

      store().updateDeviceProgress(5, 200); // a larger total expands the denominator
      expect(store().deviceTotalCount).toBe(200);
      expect(store().deviceProcessProgress).toBeCloseTo(0.025);

      store().updateDeviceProgress(300); // processed past the total expands it too
      expect(store().deviceTotalCount).toBe(300);
      expect(store().deviceProcessProgress).toBe(1);

      store().finishDeviceProcessing();
      expect(store()).toMatchObject({ isDeviceProcessing: false, deviceProcessProgress: 1, deviceProcessedCount: 300 });
    });

    it('updateDeviceProgress with a zero total divides by nothing', () => {
      store().updateDeviceProgress(0, 0);
      expect(store().deviceProcessProgress).toBe(0);
    });

    it('setAsyncJobPhase: idle zeroes the counts, a phase with counts sets them, a phase without keeps them', () => {
      store().setAsyncJobPhase('relevance', 3, 100);
      expect(store()).toMatchObject({ asyncJobPhase: 'relevance', asyncJobProcessedCount: 3, asyncJobTotalCount: 100 });

      store().setAsyncJobPhase('reasons');
      expect(store()).toMatchObject({ asyncJobPhase: 'reasons', asyncJobProcessedCount: 3, asyncJobTotalCount: 100 });

      store().setAsyncJobPhase('idle');
      expect(store()).toMatchObject({ asyncJobPhase: 'idle', asyncJobProcessedCount: 0, asyncJobTotalCount: 0 });
    });

    it('setAsyncJobProgress, setBatchProgress, setChunkStates and setReasonsInFlightIds set their fields', () => {
      store().setAsyncJobProgress(42, 200);
      store().setBatchProgress({ done: 3, total: 9 });
      store().setChunkStates({ chunks: ['ready', 'in-flight'], ready: 1, total: 2 });
      const inFlight = new Set(['r1', 'r2']);
      store().setReasonsInFlightIds(inFlight);

      expect(store()).toMatchObject({
        asyncJobProcessedCount: 42,
        asyncJobTotalCount: 200,
        batchProgress: { done: 3, total: 9 },
        chunkStates: { chunks: ['ready', 'in-flight'], ready: 1, total: 2 },
      });
      expect(store().reasonsInFlightIds).toBe(inFlight);
    });

    it('sync status, last sync, scoring error and daily limit are stored and cleared', () => {
      const msg = { state: 'scoring' as const, headlineKey: 'key', isRecoverable: false };
      store().setSyncStatusMessage(msg as never);
      expect(store().syncStatusMessage).toEqual(msg);
      store().setSyncStatusMessage(null);
      expect(store().syncStatusMessage).toBeNull();

      store().setLastSyncAt(1234567890);
      expect(store().lastSyncAt).toBe(1234567890);

      store().setScoringError('server');
      expect(store().scoringError).toBe('server');
      store().setScoringError(null);
      expect(store().scoringError).toBeNull();

      store().setDailyLimitResetAt(NOW + 3_600_000);
      expect(store().dailyLimitResetAt).toBe(NOW + 3_600_000);
      store().setDailyLimitResetAt(null);
      expect(store().dailyLimitResetAt).toBeNull();
    });

    it('hydration progress sets both fields and resets both', () => {
      store().setHydrationProgress(10, 100);
      expect(store()).toMatchObject({ hydrationCompleted: 10, hydrationTotal: 100 });
      store().resetHydrationProgress();
      expect(store()).toMatchObject({ hydrationCompleted: 0, hydrationTotal: 0 });
    });

    it('none of these setters writes anything to disk', async () => {
      store().setSuggestions([suggestion('s1')]);
      store().setUnscoredCount(3);
      store().setSyncStatusMessage(null);
      store().setLastSyncAt(1);
      store().setDailyLimitResetAt(5);
      store().setAsyncJobPhase('relevance', 1, 2);
      await settle();
      expect(await getSetting(META_KEY)).toBeNull();
    });
  });

  describe('setters that persist, through metaFromState', () => {
    beforeEach(() => useStrictClock(NOW));

    const WRITERS: [string, () => void, Partial<FeedMetadata>][] = [
      ['setCounts', () => store().setCounts(3, 1), { articleCount: 3, relevantArticleCount: 1 }],
      ['setHasGeneratedTopics', () => store().setHasGeneratedTopics(true), { hasGeneratedTopics: true }],
      ['markProcessingRunFinished', () => store().markProcessingRunFinished(), { lastProcessingRunFinishedAt: NOW }],
      ['markNewArticlesArrived', () => store().markNewArticlesArrived(9999), { lastNewArticlesAt: 9999 }],
      [
        'removeSuggestion',
        () => {
          store().setSuggestions([suggestion('s1')]);
          store().removeSuggestion('s1');
        },
        { relevantArticleCount: 6 },
      ],
    ];

    it.each(WRITERS)('%s writes its field and erases none of the others', async (_name, write, changes) => {
      await bootWith();
      expect(store()).toMatchObject(SEED);
      const before = await getSetting(META_KEY);

      write();

      expect(await metaChangedFrom(before)).toEqual({ ...SEED, ...changes });
    });

    it.each(WRITERS)('%s reports a failed write under its own method tag, and the state still changes', async (name, write) => {
      const err = new Error(`write failed for ${name}`);
      failSettingWrite(META_KEY, err);

      write();

      await until(() => reportedFor(name).length > 0, `${name} to report`);
      expect(logger.captureException).toHaveBeenCalledWith(err, { tags: { store: 'for-you-store', method: name } });
    });

    it('markNewArticlesArrived stamps the clock when given no time, and markProcessingRunFinished leaves it alone', async () => {
      store().markNewArticlesArrived();
      expect(store().lastNewArticlesAt).toBe(NOW);
      store().markProcessingRunFinished();
      expect(store().lastNewArticlesAt).toBe(NOW);
      expect(store().lastProcessingRunFinishedAt).toBe(NOW);
      await until(async () => {
        const m = await loadFeedMetadata();
        return m?.lastProcessingRunFinishedAt === NOW && m?.lastNewArticlesAt === NOW;
      }, 'both stamps on disk');
    });

    describe('removeSuggestion', () => {
      it('removes the target by id and leaves the rest', () => {
        store().setSuggestions([suggestion('s1'), suggestion('s2')]);
        store().removeSuggestion('s1');
        expect(store().suggestions.map((s) => s._id)).toEqual(['s2']);
      });

      it('is a no-op for an unknown id, writing nothing', async () => {
        store().setSuggestions([suggestion('s1')]);
        const writes = watchWrites(META_KEY);
        store().removeSuggestion('nope');
        await settle();
        expect(store().suggestions).toHaveLength(1);
        expect(writes()).toBe(0);
      });

      it('decrements relevantArticleCount for a scored row that passes the render gate', () => {
        store().setCounts(5, 3);
        store().setSuggestions([suggestion('s1', { relevance: 0.8 })]);
        store().removeSuggestion('s1');
        expect(store().relevantArticleCount).toBe(2);
      });

      it.each([
        ['a scored row below the gate', suggestion('s1', { relevance: 0.1 })],
        ['an unscored row, whatever its relevance', suggestion('s1', { relevance: 0.9, status: ArticleSuggestionStatus.Unscored })],
      ])('does NOT decrement for %s', (_label, row) => {
        store().setCounts(5, 3);
        store().setSuggestions([row]);
        store().removeSuggestion('s1');
        expect(store().relevantArticleCount).toBe(3);
      });

      it('clamps relevantArticleCount at zero', () => {
        store().setCounts(1, 0);
        store().setSuggestions([suggestion('s1', { relevance: 0.9 })]);
        store().removeSuggestion('s1');
        expect(store().relevantArticleCount).toBe(0);
      });
    });
  });

  describe('hydrateSuggestionsFromDb', () => {
    it('loads the landed rows, sorts scored rows by relevance and unscored rows last, and counts the unscored', async () => {
      await land({ 'formula 1': ids(4) });
      await saveScoringResult('a000', scored(0.5));
      await saveScoringResult('a001', scored(0.9));
      await saveScoringResult('a002', { relevance: 0.2, reason: '', reasonSkipped: false }); // reason_pending

      await store().hydrateSuggestionsFromDb();

      const rows = store().suggestions;
      expect(rows.slice(0, 3).map((s) => s._id)).toEqual(['a001', 'a000', 'a002']);
      expect(rows[3]._id).toBe('a003');
      expect(rows.map((s) => s.status)).toEqual(['complete', 'complete', 'reason_pending', 'unscored']);
      expect(store().unscoredCount).toBe(1);
      expect(store().suggestionsHydrated).toBe(true);
    });

    it('carries the same rows the service itself loads', async () => {
      await land({ 'formula 1': ids(3) });
      await store().hydrateSuggestionsFromDb();
      expect(store().suggestions.map((s) => s._id).sort()).toEqual((await loadSuggestions()).map((s) => s._id).sort());
      expect(store().unscoredCount).toBe(3);
    });

    it('two unscored rows both survive the sort', async () => {
      await land({ 'formula 1': ids(2) });
      await store().hydrateSuggestionsFromDb();
      expect(store().suggestions.map((s) => s._id).sort()).toEqual(['a000', 'a001']);
    });

    it('an empty database hydrates to an empty list', async () => {
      await store().hydrateSuggestionsFromDb();
      expect(store().suggestions).toEqual([]);
      expect(store().unscoredCount).toBe(0);
      expect(store().suggestionsHydrated).toBe(true);
    });

    it('a Feed warm-up waits on suggestionsHydrated: false while the read is pending, true once it finishes', async () => {
      const pending = store().hydrateSuggestionsFromDb();
      expect(store().suggestionsHydrated).toBe(false);
      await pending;
      expect(store().suggestionsHydrated).toBe(true);
    });

    it('a failed read leaves the list empty, reports it with its method tag, and still marks hydrated', async () => {
      await land({ 'formula 1': ids(2) });
      const err = new Error('db error');
      failTableQuery('article_suggestions', err);

      await store().hydrateSuggestionsFromDb();

      expect(store().suggestions).toEqual([]);
      expect(store().suggestionsHydrated).toBe(true);
      expect(logger.captureException).toHaveBeenCalledWith(err, {
        tags: { store: 'for-you-store', method: 'hydrateSuggestionsFromDb' },
      });
    });

    it('a data clear does not send the Feed back to warming up', async () => {
      await store().hydrateSuggestionsFromDb();
      expect(store().suggestionsHydrated).toBe(true);
      await store().clearData();
      expect(store().suggestionsHydrated).toBe(true);
    });

    // The fact page's Not impactful list reads these from the store: dropping them before 48h empties it.
    it('keeps terminal rows inside 48h in the store: excluded, already_read and complete-below-the-gate', async () => {
      await land({ 'formula 1': ids(4) });
      await batchMarkAlreadyRead(['a002']);
      await batchMarkExcluded(['a000']);
      await saveScoringResult('a001', scored(0.1)); // complete, below the gate

      await store().hydrateSuggestionsFromDb();

      const status = Object.fromEntries(store().suggestions.map((s) => [s._id, s.status]));
      expect(status).toEqual({
        a000: ArticleSuggestionStatus.Excluded,
        a001: ArticleSuggestionStatus.Complete,
        a002: ArticleSuggestionStatus.AlreadyRead,
        a003: ArticleSuggestionStatus.Unscored,
      });
      // only a row still waiting for a score counts as unscored
      expect(store().unscoredCount).toBe(1);
    });
  });

  describe('hydrateMetadataFromDb', () => {
    it('restores every persisted field and reads idle when no scoring run exists', async () => {
      await persistFeedMetadata(SEED);

      await store().hydrateMetadataFromDb();

      expect(store()).toMatchObject({
        articleCount: 11,
        relevantArticleCount: 7,
        hasGeneratedTopics: false,
        lastProcessingRunFinishedAt: 5000,
        lastNewArticlesAt: 4321,
        asyncJobPhase: 'idle',
        asyncJobProcessedCount: 0,
        asyncJobTotalCount: 0,
        batchProgress: null,
        chunkStates: null,
      });
      expect(store().reasonsInFlightIds.size).toBe(0);
      // the dynamic import ran: a failed import would have landed in the catch and reported
      expect(reportedFor('hydrateMetadataFromDb')).toHaveLength(0);
    });

    it('a blob written before lastNewArticlesAt existed reads it as null', async () => {
      await setSetting(
        META_KEY,
        JSON.stringify({ articleCount: 4, relevantArticleCount: 2, hasGeneratedTopics: true, lastProcessingRunFinishedAt: 77 }),
      );
      await store().hydrateMetadataFromDb();
      expect(store()).toMatchObject({ articleCount: 4, lastProcessingRunFinishedAt: 77, lastNewArticlesAt: null });
    });

    it('with no row, the counts come from the rows in the store and the timestamps stay null', async () => {
      await land({ 'formula 1': ids(3) });
      await saveScoringResult('a000', scored(0.9));
      await saveScoringResult('a001', scored(0.1));
      await store().hydrateSuggestionsFromDb(); // a000 impactful, a001 below the gate, a002 unscored

      await store().hydrateMetadataFromDb();

      expect(store()).toMatchObject({
        articleCount: 3,
        relevantArticleCount: 1,
        hasGeneratedTopics: true,
        lastProcessingRunFinishedAt: null,
        lastNewArticlesAt: null,
        asyncJobPhase: 'idle',
      });
    });

    it('a corrupt row reads as no row', async () => {
      await setSetting(META_KEY, '{not json');
      await store().hydrateMetadataFromDb();
      expect(store()).toMatchObject({ articleCount: 0, hasGeneratedTopics: true, lastNewArticlesAt: null });
      expect(reportedFor('hydrateMetadataFromDb')).toHaveLength(0);
    });

    it('a failed row read leaves the defaults and what the store already held, reports its method tag, and does not throw', async () => {
      store().setSuggestions([suggestion('s1')]);
      useForYouStore.setState({ articleCount: 5, relevantArticleCount: 3 });
      const err = new Error('read failed');
      failSettingRead(META_KEY, err);

      await expect(store().hydrateMetadataFromDb()).resolves.toBeUndefined();

      expect(store()).toMatchObject({ articleCount: 5, relevantArticleCount: 3 });
      expect(logger.captureException).toHaveBeenCalledWith(err, {
        tags: { store: 'for-you-store', method: 'hydrateMetadataFromDb' },
      });
    });
  });

  describe('clearData', () => {
    it('empties the rows and the state, keeps hasGeneratedTopics and the hydrated flag, and persists the zeros', async () => {
      await land({ 'formula 1': ids(2) });
      await store().hydrateSuggestionsFromDb();
      store().setCounts(5, 3);
      store().setHasGeneratedTopics(false);
      store().markNewArticlesArrived(4321);

      await store().clearData();

      expect(await loadSuggestions()).toEqual([]);
      expect(store()).toMatchObject({
        suggestions: [],
        articleCount: 0,
        relevantArticleCount: 0,
        hasGeneratedTopics: false, // clearing the cache does not remove the reader's interests
        lastProcessingRunFinishedAt: null,
        lastNewArticlesAt: null,
        suggestionsHydrated: true,
      });
      expect(await loadFeedMetadata()).toEqual({
        articleCount: 0,
        relevantArticleCount: 0,
        hasGeneratedTopics: false,
        lastProcessingRunFinishedAt: null,
        lastNewArticlesAt: null,
      });
    });

    it('logs and does not throw when the database fails', async () => {
      await land({ 'formula 1': ids(1) });
      const err = new Error('db error');
      failTableQuery('article_suggestions', err);

      await expect(store().clearData()).resolves.toBeUndefined();

      expect(logger.captureException).toHaveBeenCalledWith(err, { tags: { store: 'for-you-store', method: 'clearData' } });
    });
  });

  describe('pruneOrphanedData', () => {
    /** Two interests landed; `formula 1` is then dropped from its fact's metadata topics, orphaning its rows. */
    async function orphanFormulaOne() {
      await land({ 'formula 1': ['f000', 'f001'], chess: ['c000'] });
      await saveScoringResult('c000', scored(0.9));
      await dropTopic('formula 1');
    }

    it('with rows whose topics are gone: reloads, sorts, recounts, keeps the published count and persists', async () => {
      await orphanFormulaOne();
      await store().hydrateSuggestionsFromDb();
      useForYouStore.setState({ articleCount: 269317 });

      await store().pruneOrphanedData();

      expect(store().suggestions.map((s) => s._id)).toEqual(['c000']);
      // the published count is the server's: pruning local rows never rewrites it
      expect(store().articleCount).toBe(269317);
      expect(store().relevantArticleCount).toBe(1);
      await until(async () => (await loadFeedMetadata())?.relevantArticleCount === 1, 'the recount on disk');
      expect(await loadFeedMetadata()).toMatchObject({ articleCount: 269317, relevantArticleCount: 1 });
    });

    it('with no active topics left: clears the rows but keeps the published count and hasGeneratedTopics', async () => {
      await land({ 'formula 1': ids(2) });
      await dropTopic('formula 1');
      await store().hydrateSuggestionsFromDb();
      useForYouStore.setState({ articleCount: 5, hasGeneratedTopics: false });

      await store().pruneOrphanedData();

      expect(store().suggestions).toEqual([]);
      expect(store().articleCount).toBe(5); // the server's count, not a count of local rows
      expect(store().hasGeneratedTopics).toBe(false);
      expect(await loadSuggestions()).toEqual([]);
      await until(async () => (await loadFeedMetadata())?.articleCount === 5, 'the full-clear metadata on disk');
      expect(await loadFeedMetadata()).toMatchObject({ articleCount: 5, hasGeneratedTopics: false });
    });

    it('with nothing orphaned: changes nothing and writes nothing', async () => {
      await land({ 'formula 1': ids(2) });
      await store().hydrateSuggestionsFromDb();
      const writes = watchWrites(META_KEY);
      const before = store().suggestions;

      await store().pruneOrphanedData();
      await settle();

      expect(store().suggestions).toBe(before);
      expect(writes()).toBe(0);
    });

    it('reports a failed persist on the reload path under its own tag', async () => {
      await orphanFormulaOne();
      await store().hydrateSuggestionsFromDb();
      const err = new Error('db');
      failSettingWrite(META_KEY, err);

      await store().pruneOrphanedData();

      await until(() => reportedFor('pruneOrphanedData:reload').length > 0, 'the reload failure to report');
      expect(logger.captureException).toHaveBeenCalledWith(err, {
        tags: { store: 'for-you-store', method: 'pruneOrphanedData:reload' },
      });
    });

    it('reports a failed persist on the full-clear path under its own tag, without throwing', async () => {
      await land({ 'formula 1': ids(1) });
      await dropTopic('formula 1');
      const err = new Error('db');
      failSettingWrite(META_KEY, err);

      await expect(store().pruneOrphanedData()).resolves.toBeUndefined();

      expect(logger.captureException).toHaveBeenCalledWith(err, {
        tags: { store: 'for-you-store', method: 'pruneOrphanedData:fullClear' },
      });
    });
  });
});
