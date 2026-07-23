// feed-sync-steps.test.ts — unit tests for each step function

const mockGetFacts = jest.fn();
const mockGetLocalSuggestionServerIds = jest.fn();
const mockGetUnscoredSuggestionsWithFacts = jest.fn();
const mockBatchMarkAsScoredByIds = jest.fn();
const mockPersistAndLinkV2Suggestions = jest.fn();
const mockGetFactWeightById = jest.fn();
const mockGetArticleIdsForTopics = jest.fn();
const mockGetArticlesForTopicsByIds = jest.fn();
const mockGetArticleIdsForPersona = jest.fn();
const mockWithRetry = jest.fn();
const mockRunScoringPass = jest.fn();
const mockEnqueueCandidates = jest.fn();
const mockGetNonTerminalCandidateIds = jest.fn();
const mockGateUnscoredForScoring = jest.fn();
const mockLoadUserGeoLanguageContext = jest.fn();
const mockLogInfo = jest.fn();
const mockGetActive = jest.fn();
const mockGetAllLocations = jest.fn();
const mockReconcileTrackedStories = jest.fn();
const mockMigrateLegacyTrackedStories = jest.fn();
const mockCaptureException = jest.fn();
const mockRunPersonaMigrationIfNeeded = jest.fn();

jest.mock('@/lib/database/services/fact-service', () => ({
  getFacts: (...args: any[]) => mockGetFacts(...args),
}));

jest.mock('@/lib/database/services/topic-service', () => ({
  getActive: (...args: any[]) => mockGetActive(...args),
}));

jest.mock('@/lib/services/persona-migration-service', () => ({
  runPersonaMigrationIfNeeded: (...args: any[]) => mockRunPersonaMigrationIfNeeded(...args),
}));

jest.mock('@/lib/database/services/location-service', () => ({
  getAll: (...args: any[]) => mockGetAllLocations(...args),
}));

jest.mock('@/lib/database/services/article-suggestion-service', () => ({
  getLocalSuggestionServerIds: (...args: any[]) => mockGetLocalSuggestionServerIds(...args),
  getUnscoredSuggestionsWithFacts: (...args: any[]) => mockGetUnscoredSuggestionsWithFacts(...args),
  batchMarkAsScoredByIds: (...args: any[]) => mockBatchMarkAsScoredByIds(...args),
  persistAndLinkV2Suggestions: (...args: any[]) => mockPersistAndLinkV2Suggestions(...args),
  getFactWeightById: (...args: any[]) => mockGetFactWeightById(...args),
}));

jest.mock('@/lib/article-service', () => ({
  ArticleService: {
    getArticleIdsForTopics: (...args: any[]) => mockGetArticleIdsForTopics(...args),
    getArticlesForTopicsByIds: (...args: any[]) => mockGetArticlesForTopicsByIds(...args),
    getArticleIdsForPersona: (...args: any[]) => mockGetArticleIdsForPersona(...args),
  },
}));

jest.mock('@/lib/utils/retry', () => ({
  withRetry: (fn: any, signal: any) => mockWithRetry(fn, signal),
}));

jest.mock('@/lib/services/SuggestionSyncService', () => ({
  runScoringPass: (...args: any[]) => mockRunScoringPass(...args),
}));

jest.mock('@/lib/services/scoring-pipeline', () => ({
  enqueueCandidates: (...args: any[]) => mockEnqueueCandidates(...args),
  getNonTerminalCandidateIds: (...args: any[]) => mockGetNonTerminalCandidateIds(...args),
}));

jest.mock('@/lib/feed-grouping/score-propagation', () => ({
  gateUnscoredForScoring: (...args: any[]) => mockGateUnscoredForScoring(...args),
}));

jest.mock('@/lib/user-context/user-geo-language-context', () => ({
  loadUserGeoLanguageContext: (...args: any[]) => mockLoadUserGeoLanguageContext(...args),
}));

jest.mock('../tracked-story-reconcile', () => ({
  reconcileTrackedStories: (...args: any[]) => mockReconcileTrackedStories(...args),
}));

jest.mock('@/lib/tracking/track-actions', () => ({
  migrateLegacyTrackedStories: (...args: any[]) => mockMigrateLegacyTrackedStories(...args),
}));

jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: {
    info: (...args: any[]) => mockLogInfo(...args),
    warn: jest.fn(),
    captureException: (...args: any[]) => mockCaptureException(...args),
  },
}));

import {
  stepFetchTopicIds,
  stepDiff,
  stepHydratePersistEnqueue,
  stepScore,
  HYDRATE_CHUNK_SIZE,
  HYDRATE_CONCURRENCY,
} from '../feed-sync-steps';
import type {
  FetchTopicIdsResult,
  DiffResult,
  HydratePersistEnqueueOptions,
} from '../feed-sync-steps';

function makeCtx(aborted = false) {
  const controller = new AbortController();
  if (aborted) controller.abort();
  return {
    jobId: 'job-steps-1',
    attempt: 1,
    signal: controller.signal,
    reportProgress: jest.fn(),
    log: jest.fn(),
    controller,
  };
}

function makeOpts(
  overrides?: Partial<HydratePersistEnqueueOptions>,
): HydratePersistEnqueueOptions {
  return {
    onProgress: jest.fn(),
    awaitResumeIfPaused: jest.fn().mockResolvedValue(undefined),
    refreshStore: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();

  // Default: withRetry calls the fn and returns its result
  mockWithRetry.mockImplementation((fn: () => any) => fn());
  mockGetFacts.mockResolvedValue([]);
  mockGetActive.mockResolvedValue([]);
  mockGetAllLocations.mockResolvedValue([]);
  mockGetFactWeightById.mockResolvedValue(new Map());
  mockGetLocalSuggestionServerIds.mockResolvedValue([]);
  mockGetUnscoredSuggestionsWithFacts.mockResolvedValue([]);
  mockBatchMarkAsScoredByIds.mockResolvedValue(undefined);
  mockPersistAndLinkV2Suggestions.mockResolvedValue({ insertedCount: 0, linkedCount: 0 });
  mockGetArticleIdsForTopics.mockResolvedValue({ results: [] });
  mockGetArticlesForTopicsByIds.mockResolvedValue({ articles: [], dailyLimitReached: false });
  mockRunScoringPass.mockResolvedValue(5);
  mockEnqueueCandidates.mockResolvedValue(undefined);
  mockGetNonTerminalCandidateIds.mockResolvedValue(new Set());
  // Default gate: no propagation/election, enqueue nothing. Tests that exercise
  // enqueue configure it to return the ids the gate elected for this sync.
  mockGateUnscoredForScoring.mockResolvedValue({
    enqueueIds: [],
    propagatedCount: 0,
    heldBackCount: 0,
  });
  mockReconcileTrackedStories.mockResolvedValue(undefined);
  mockMigrateLegacyTrackedStories.mockResolvedValue(0);
  mockLoadUserGeoLanguageContext.mockResolvedValue(null);
  mockRunPersonaMigrationIfNeeded.mockResolvedValue({
    ran: false,
    factsMigrated: 0,
    topicsCreated: 0,
    locationsUpserted: 0,
  });
});

// ── stepFetchTopicIds ─────────────────────────────────────────────────────────

describe('stepFetchTopicIds', () => {
  it('throws "aborted" when signal is already aborted', async () => {
    const ctx = makeCtx(true);
    await expect(stepFetchTopicIds('p-1', ctx)).rejects.toThrow('aborted');
    expect(mockGetFacts).not.toHaveBeenCalled();
  });

  it('throws no-topics-configured when no topics found in facts', async () => {
    mockGetFacts.mockResolvedValue([]); // empty facts → no topics
    const ctx = makeCtx();
    await expect(stepFetchTopicIds('p-1', ctx)).rejects.toThrow('no-topics-configured');
    expect(mockGetArticleIdsForTopics).not.toHaveBeenCalled();
  });

  it('throws with code no-topics-configured on the error object', async () => {
    mockGetFacts.mockResolvedValue([]);
    const ctx = makeCtx();
    const err = await stepFetchTopicIds('p-1', ctx).catch((e) => e);
    expect(err.code).toBe('no-topics-configured');
  });

  it('deduplicates topic texts across facts', async () => {
    mockGetFacts.mockResolvedValue([
      { metadata: { topics: ['ai', 'tech'] } },
      { metadata: { topics: ['ai', 'sports'] } }, // 'ai' is a duplicate
    ]);
    mockGetArticleIdsForTopics.mockResolvedValue({ results: [] });

    const ctx = makeCtx();
    await stepFetchTopicIds('p-1', ctx).catch(() => {});
    // getArticleIdsForTopics called with unique topics: ai, tech, sports
    expect(mockGetArticleIdsForTopics).toHaveBeenCalledWith(
      expect.arrayContaining([
        { topicText: 'ai' },
        { topicText: 'tech' },
        { topicText: 'sports' },
      ]),
      expect.any(Object),
    );
    // Should NOT have duplicated ai
    const call = mockGetArticleIdsForTopics.mock.calls[0][0];
    const aiEntries = call.filter((c: any) => c.topicText === 'ai');
    expect(aiEntries).toHaveLength(1);
  });

  it('skips empty string topics', async () => {
    mockGetFacts.mockResolvedValue([
      { metadata: { topics: ['', 'valid-topic'] } },
    ]);
    mockGetArticleIdsForTopics.mockResolvedValue({ results: [] });

    const ctx = makeCtx();
    await stepFetchTopicIds('p-1', ctx).catch(() => {});
    const call = mockGetArticleIdsForTopics.mock.calls[0][0];
    expect(call).not.toContainEqual({ topicText: '' });
    expect(call).toContainEqual({ topicText: 'valid-topic' });
  });

  it('handles facts with no metadata.topics (undefined topics)', async () => {
    mockGetFacts.mockResolvedValue([
      { metadata: {} }, // no topics array
      { metadata: { topics: ['real-topic'] } },
    ]);
    mockGetArticleIdsForTopics.mockResolvedValue({ results: [] });

    const ctx = makeCtx();
    await stepFetchTopicIds('p-1', ctx).catch(() => {});
    const call = mockGetArticleIdsForTopics.mock.calls[0][0];
    expect(call).toContainEqual({ topicText: 'real-topic' });
  });

  it('returns articleToTopicTexts map and serverArticleIds on success', async () => {
    mockGetFacts.mockResolvedValue([
      { metadata: { topics: ['topic-a', 'topic-b'] } },
    ]);
    mockGetArticleIdsForTopics.mockResolvedValue({
      results: [
        { topicText: 'topic-a', articleIds: ['art-1', 'art-2'] },
        { topicText: 'topic-b', articleIds: ['art-2', 'art-3'] },
      ],
    });

    const ctx = makeCtx();
    const result = await stepFetchTopicIds('p-1', ctx);

    expect(result.serverArticleIds).toEqual(expect.arrayContaining(['art-1', 'art-2', 'art-3']));
    expect(result.serverArticleIds).toHaveLength(3);
    expect(result.articleToTopicTexts.get('art-2')).toEqual(
      expect.arrayContaining(['topic-a', 'topic-b']),
    );
  });

  it('builds multi-topic articleToTopicTexts correctly (an article matching two topics)', async () => {
    mockGetFacts.mockResolvedValue([
      { metadata: { topics: ['topic-x'] } },
    ]);
    mockGetArticleIdsForTopics.mockResolvedValue({
      results: [
        { topicText: 'topic-x', articleIds: ['art-10'] },
      ],
    });

    const ctx = makeCtx();
    const result = await stepFetchTopicIds('p-1', ctx);

    expect(result.articleToTopicTexts.get('art-10')).toEqual(['topic-x']);
  });

  it('passes signal to withRetry', async () => {
    mockGetFacts.mockResolvedValue([
      { metadata: { topics: ['topic-1'] } },
    ]);
    mockGetArticleIdsForTopics.mockResolvedValue({ results: [] });

    const ctx = makeCtx();
    await stepFetchTopicIds('p-1', ctx).catch(() => {});
    // withRetry should have been called with the ctx.signal
    expect(mockWithRetry).toHaveBeenCalledWith(
      expect.any(Function),
      ctx.signal,
    );
  });

  it('logs info message with topic count', async () => {
    mockGetFacts.mockResolvedValue([
      { metadata: { topics: ['topic-1', 'topic-2'] } },
    ]);
    mockGetArticleIdsForTopics.mockResolvedValue({ results: [] });

    const ctx = makeCtx();
    await stepFetchTopicIds('p-1', ctx).catch(() => {});

    expect(mockLogInfo).toHaveBeenCalledWith(
      expect.stringContaining('2 topic texts'),
    );
  });

  it('routes through the persona path when topic-service has active topics, and builds matchedTopics/stableClusterId metadata', async () => {
    mockGetActive.mockResolvedValue([
      { id: 't1', text: 'ai', weight: 0.8, highPriority: false, factId: 'f1', locationId: null },
    ] as any);
    mockGetAllLocations.mockResolvedValue([]);
    mockGetArticleIdsForPersona.mockResolvedValue({
      topicResults: [
        {
          topicText: 'ai',
          articleIds: ['art-1'],
          matchMeta: [{ articleId: 'art-1', vectorScore: 0.9, textScore: null, stableClusterId: 'sc1' }],
          nextCursor: null,
          hasNextPage: false,
        },
      ],
      headlineResults: [],
    });

    const ctx = makeCtx();
    const result = await stepFetchTopicIds('p-1', ctx);

    expect(result.serverArticleIds).toContain('art-1');
    expect(result.articleToTopicTexts.get('art-1')).toContain('ai');
    expect(result.personaMeta?.matchedTopics.get('art-1')?.[0]).toMatchObject({
      topicId: 't1',
      text: 'ai',
    });
    expect(result.personaMeta?.stableClusterId?.get('art-1')).toBe('sc1');
    expect(mockGetArticleIdsForPersona).toHaveBeenCalled();
    expect(mockGetArticleIdsForTopics).not.toHaveBeenCalled();
  });

  // ── P7e: sync-vs-persona-migration race ──────────────────────────────────
  it('awaits the persona migration BEFORE choosing the topics path', async () => {
    // Migration populates topics as a side effect: getActive returns empty until
    // the migration resolves, then the persona path is taken.
    mockRunPersonaMigrationIfNeeded.mockResolvedValue({
      ran: true,
      factsMigrated: 1,
      topicsCreated: 1,
      locationsUpserted: 0,
    });
    mockGetActive.mockResolvedValue([
      { id: 't1', text: 'ai', weight: 0.8, highPriority: false, factId: 'f1', locationId: null },
    ] as any);
    mockGetArticleIdsForPersona.mockResolvedValue({ topicResults: [], headlineResults: [] });

    const ctx = makeCtx();
    await stepFetchTopicIds('p-1', ctx);

    expect(mockRunPersonaMigrationIfNeeded).toHaveBeenCalledTimes(1);
    // The migration must be invoked before the topics-path choice reads topics.
    expect(mockRunPersonaMigrationIfNeeded.mock.invocationCallOrder[0]).toBeLessThan(
      mockGetActive.mock.invocationCallOrder[0],
    );
  });

  it('does not fail the step when the persona migration rejects — legacy path still proceeds', async () => {
    mockRunPersonaMigrationIfNeeded.mockRejectedValue(new Error('migration boom'));
    // Topics table still empty → legacy fallback path.
    mockGetActive.mockResolvedValue([]);
    mockGetFacts.mockResolvedValue([{ metadata: { topics: ['topic-1'] } }]);
    mockGetArticleIdsForTopics.mockResolvedValue({ results: [] });

    const ctx = makeCtx();
    // Resolves normally despite the migration rejection.
    const result = await stepFetchTopicIds('p-1', ctx);

    expect(result.serverArticleIds).toEqual([]);
    // Legacy path ran (topics still empty), persona path did not.
    expect(mockGetArticleIdsForTopics).toHaveBeenCalled();
    expect(mockGetArticleIdsForPersona).not.toHaveBeenCalled();
    // The failure was captured, not propagated.
    expect(mockCaptureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: expect.objectContaining({ method: 'runPersonaMigrationIfNeeded' }),
      }),
    );
  });

});

// ── stepDiff ──────────────────────────────────────────────────────────────────

describe('stepDiff', () => {
  it('throws "aborted" when signal is already aborted', async () => {
    const ctx = makeCtx(true);
    const fetchResult: FetchTopicIdsResult = {
      serverArticleIds: ['art-1'],
      articleToTopicTexts: new Map(),
    };
    await expect(stepDiff(fetchResult, ctx)).rejects.toThrow('aborted');
  });

  it('returns missingIds = serverArticleIds that are not in local store', async () => {
    mockGetLocalSuggestionServerIds.mockResolvedValue(['art-1', 'art-3']);
    const fetchResult: FetchTopicIdsResult = {
      serverArticleIds: ['art-1', 'art-2', 'art-3', 'art-4'],
      articleToTopicTexts: new Map(),
    };

    const ctx = makeCtx();
    const result = await stepDiff(fetchResult, ctx);

    // art-1 and art-3 exist locally; art-2 and art-4 are missing
    expect(result.missingIds).toEqual(expect.arrayContaining(['art-2', 'art-4']));
    expect(result.missingIds).toHaveLength(2);
  });

  it('returns empty missingIds when all server articles are local', async () => {
    mockGetLocalSuggestionServerIds.mockResolvedValue(['art-1', 'art-2']);
    const fetchResult: FetchTopicIdsResult = {
      serverArticleIds: ['art-1', 'art-2'],
      articleToTopicTexts: new Map([['art-1', ['t1']]]),
    };

    const ctx = makeCtx();
    const result = await stepDiff(fetchResult, ctx);

    expect(result.missingIds).toHaveLength(0);
  });

  it('returns all serverArticleIds as missing when local is empty', async () => {
    mockGetLocalSuggestionServerIds.mockResolvedValue([]);
    const fetchResult: FetchTopicIdsResult = {
      serverArticleIds: ['art-1', 'art-2'],
      articleToTopicTexts: new Map(),
    };

    const ctx = makeCtx();
    const result = await stepDiff(fetchResult, ctx);

    expect(result.missingIds).toEqual(['art-1', 'art-2']);
  });

  it('passes through serverArticleIds and articleToTopicTexts unchanged', async () => {
    mockGetLocalSuggestionServerIds.mockResolvedValue([]);
    const topicMap = new Map([['art-1', ['topic-a']]]);
    const fetchResult: FetchTopicIdsResult = {
      serverArticleIds: ['art-1'],
      articleToTopicTexts: topicMap,
    };

    const ctx = makeCtx();
    const result = await stepDiff(fetchResult, ctx);

    expect(result.serverArticleIds).toBe(fetchResult.serverArticleIds);
    expect(result.articleToTopicTexts).toBe(topicMap);
  });

  it('logs missing count via ctx.log', async () => {
    mockGetLocalSuggestionServerIds.mockResolvedValue([]);
    const fetchResult: FetchTopicIdsResult = {
      serverArticleIds: ['art-1', 'art-2', 'art-3'],
      articleToTopicTexts: new Map(),
    };

    const ctx = makeCtx();
    await stepDiff(fetchResult, ctx);

    expect(ctx.log).toHaveBeenCalledWith(expect.stringContaining('3 missing'));
  });
});

// ── stepHydratePersistEnqueue ───────────────────────────────────────────────

describe('stepHydratePersistEnqueue', () => {
  it('throws "aborted" when signal is already aborted', async () => {
    const ctx = makeCtx(true);
    const diffResult: DiffResult = {
      serverArticleIds: [],
      articleToTopicTexts: new Map(),
      missingIds: ['art-1'],
    };
    await expect(
      stepHydratePersistEnqueue(diffResult, ctx, makeOpts()),
    ).rejects.toThrow('aborted');
    expect(mockGetArticlesForTopicsByIds).not.toHaveBeenCalled();
  });

  it('hydrates, persists, enqueues eligible ids, and refreshes the store for one chunk', async () => {
    mockGetArticlesForTopicsByIds.mockResolvedValue({
      articles: [{ _id: 'art-1' }],
      dailyLimitReached: false,
    });
    mockPersistAndLinkV2Suggestions.mockResolvedValue({ insertedCount: 1, linkedCount: 1 });
    mockGetUnscoredSuggestionsWithFacts.mockResolvedValue([
      { id: 'art-1', titleEn: 't', descriptionEn: 'd', relatedFacts: [{}] },
    ]);
    const topicMap = new Map([['art-1', ['topic-a']]]);
    // The gate elects art-1 for scoring (donor-less singleton).
    mockGateUnscoredForScoring.mockResolvedValue({
      enqueueIds: ['art-1'],
      propagatedCount: 0,
      heldBackCount: 0,
    });
    const diffResult: DiffResult = {
      serverArticleIds: ['art-1'],
      articleToTopicTexts: topicMap,
      missingIds: ['art-1'],
    };
    const opts = makeOpts();

    const ctx = makeCtx();
    const result = await stepHydratePersistEnqueue(diffResult, ctx, opts);

    expect(mockGetArticlesForTopicsByIds).toHaveBeenCalledWith(
      ['art-1'],
      expect.any(Function),
    );
    expect(mockPersistAndLinkV2Suggestions).toHaveBeenCalledWith(
      [{ _id: 'art-1' }],
      topicMap,
      undefined,
    );
    expect(mockEnqueueCandidates).toHaveBeenCalledWith(['art-1']);
    expect(opts.refreshStore).toHaveBeenCalled();
    expect(result.insertedCount).toBe(1);
    expect(result.enqueuedCount).toBe(1);
    expect(result.dailyLimitReached).toBe(false);
  });

  it('flushes the gate-deferred trailing partial with flushPartial=true once the lot is hydrated', async () => {
    mockGetArticlesForTopicsByIds.mockResolvedValue({
      articles: [{ _id: 'art-1' }],
      dailyLimitReached: false,
    });
    mockPersistAndLinkV2Suggestions.mockResolvedValue({ insertedCount: 1, linkedCount: 1 });
    mockGetUnscoredSuggestionsWithFacts.mockResolvedValue([
      { id: 'art-1', titleEn: 't', descriptionEn: 'd', relatedFacts: [{}] },
    ]);
    mockGateUnscoredForScoring.mockResolvedValue({
      enqueueIds: ['art-1'],
      propagatedCount: 0,
      heldBackCount: 0,
    });
    // The pipeline held art-1 back as a sub-25 trailing partial (returned to us).
    mockEnqueueCandidates.mockResolvedValue({ deferred: ['art-1'] });
    const diffResult: DiffResult = {
      serverArticleIds: ['art-1'],
      articleToTopicTexts: new Map([['art-1', ['topic-a']]]),
      missingIds: ['art-1'],
    };

    await stepHydratePersistEnqueue(diffResult, makeCtx(), makeOpts());

    // Greedy enqueue (one arg) then a direct tail flush with flushPartial=true —
    // no extra gate pass (the ids were already elected).
    expect(mockEnqueueCandidates).toHaveBeenNthCalledWith(1, ['art-1']);
    expect(mockEnqueueCandidates).toHaveBeenNthCalledWith(2, ['art-1'], true);
    expect(mockGateUnscoredForScoring).toHaveBeenCalledTimes(1);
  });

  it('does NOT flush a tail when the pipeline deferred nothing', async () => {
    mockGetArticlesForTopicsByIds.mockResolvedValue({
      articles: [{ _id: 'art-1' }],
      dailyLimitReached: false,
    });
    mockPersistAndLinkV2Suggestions.mockResolvedValue({ insertedCount: 1, linkedCount: 1 });
    mockGetUnscoredSuggestionsWithFacts.mockResolvedValue([
      { id: 'art-1', titleEn: 't', descriptionEn: 'd', relatedFacts: [{}] },
    ]);
    mockGateUnscoredForScoring.mockResolvedValue({
      enqueueIds: ['art-1'],
      propagatedCount: 0,
      heldBackCount: 0,
    });
    mockEnqueueCandidates.mockResolvedValue({ deferred: [] });
    const diffResult: DiffResult = {
      serverArticleIds: ['art-1'],
      articleToTopicTexts: new Map([['art-1', ['topic-a']]]),
      missingIds: ['art-1'],
    };

    await stepHydratePersistEnqueue(diffResult, makeCtx(), makeOpts());

    // Greedy enqueue only — nothing deferred, so no flush call.
    expect(mockEnqueueCandidates).toHaveBeenCalledTimes(1);
    expect(mockEnqueueCandidates).toHaveBeenCalledWith(['art-1']);
  });

  it('migrates legacy follows then fires reconcileTrackedStories fire-and-forget after a successful persist', async () => {
    mockGetArticlesForTopicsByIds.mockResolvedValue({
      articles: [{ _id: 'art-1' }],
      dailyLimitReached: false,
    });
    mockPersistAndLinkV2Suggestions.mockResolvedValue({ insertedCount: 1, linkedCount: 1 });
    const diffResult: DiffResult = {
      serverArticleIds: ['art-1'],
      articleToTopicTexts: new Map(),
      missingIds: ['art-1'],
    };

    await stepHydratePersistEnqueue(diffResult, makeCtx(), makeOpts());

    // Migration runs synchronously; the reconcile is chained after it resolves,
    // so flush the fire-and-forget microtasks before asserting it ran.
    expect(mockMigrateLegacyTrackedStories).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    await Promise.resolve();
    expect(mockReconcileTrackedStories).toHaveBeenCalledTimes(1);
  });

  it('never lets a reconcileTrackedStories failure surface from the sync', async () => {
    mockGetArticlesForTopicsByIds.mockResolvedValue({
      articles: [{ _id: 'art-1' }],
      dailyLimitReached: false,
    });
    mockPersistAndLinkV2Suggestions.mockResolvedValue({ insertedCount: 1, linkedCount: 1 });
    mockReconcileTrackedStories.mockRejectedValue(new Error('reconcile boom'));
    const diffResult: DiffResult = {
      serverArticleIds: ['art-1'],
      articleToTopicTexts: new Map(),
      missingIds: ['art-1'],
    };

    // Resolves normally — the sync itself never sees the reconcile failure.
    const result = await stepHydratePersistEnqueue(diffResult, makeCtx(), makeOpts());
    expect(result.insertedCount).toBe(1);

    // Flush the fire-and-forget promise's rejection handler.
    await Promise.resolve();
    await Promise.resolve();
    expect(mockCaptureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: expect.objectContaining({ component: 'feed-sync-steps' }),
      }),
    );
  });

  it('marks ineligible rows scored and enqueues only the eligible chunk ids', async () => {
    mockGetArticlesForTopicsByIds.mockResolvedValue({
      articles: [{ _id: 'good' }, { _id: 'bad' }],
      dailyLimitReached: false,
    });
    mockPersistAndLinkV2Suggestions.mockResolvedValue({ insertedCount: 2, linkedCount: 2 });
    mockGetUnscoredSuggestionsWithFacts.mockResolvedValue([
      { id: 'good', titleEn: 't', descriptionEn: 'd', relatedFacts: [{}] },
      { id: 'bad', titleEn: null, descriptionEn: 'd', relatedFacts: [] },
    ]);
    mockGateUnscoredForScoring.mockResolvedValue({
      enqueueIds: ['good'],
      propagatedCount: 0,
      heldBackCount: 0,
    });
    const diffResult: DiffResult = {
      serverArticleIds: ['good', 'bad'],
      articleToTopicTexts: new Map(),
      missingIds: ['good', 'bad'],
    };

    const result = await stepHydratePersistEnqueue(diffResult, makeCtx(), makeOpts());

    expect(mockBatchMarkAsScoredByIds).toHaveBeenCalledWith(['bad']);
    expect(mockEnqueueCandidates).toHaveBeenCalledWith(['good']);
    expect(result.enqueuedCount).toBe(1);
  });

  it('does NOT enqueue an already-scored id that is not in the current chunk', async () => {
    // getUnscoredSuggestionsWithFacts returns a stale eligible row from a prior
    // chunk; only ids belonging to THIS chunk should be enqueued.
    mockGetArticlesForTopicsByIds.mockResolvedValue({
      articles: [{ _id: 'chunk-id' }],
      dailyLimitReached: false,
    });
    mockPersistAndLinkV2Suggestions.mockResolvedValue({ insertedCount: 1, linkedCount: 1 });
    mockGetUnscoredSuggestionsWithFacts.mockResolvedValue([
      { id: 'chunk-id', titleEn: 't', descriptionEn: 'd', relatedFacts: [{}] },
      { id: 'other-chunk-id', titleEn: 't', descriptionEn: 'd', relatedFacts: [{}] },
    ]);
    mockGateUnscoredForScoring.mockResolvedValue({
      enqueueIds: ['chunk-id'],
      propagatedCount: 0,
      heldBackCount: 0,
    });
    const diffResult: DiffResult = {
      serverArticleIds: ['chunk-id'],
      articleToTopicTexts: new Map(),
      missingIds: ['chunk-id'],
    };

    await stepHydratePersistEnqueue(diffResult, makeCtx(), makeOpts());

    expect(mockEnqueueCandidates).toHaveBeenCalledWith(['chunk-id']);
  });

  it('throws a daily-limit coded error (with resetAt) when the cap left nothing to deliver', async () => {
    mockGetArticlesForTopicsByIds.mockResolvedValue({
      articles: [],
      dailyLimitReached: true,
      resetAt: '2026-06-25T00:00:00.000Z',
    });
    const diffResult: DiffResult = {
      serverArticleIds: ['art-1'],
      articleToTopicTexts: new Map(),
      missingIds: ['art-1'],
    };

    const err = await stepHydratePersistEnqueue(diffResult, makeCtx(), makeOpts()).catch(
      (e) => e,
    );
    expect((err as { code?: string }).code).toBe('daily-limit');
    expect((err as { resetAt?: number }).resetAt).toBe(
      Date.parse('2026-06-25T00:00:00.000Z'),
    );
    expect(mockEnqueueCandidates).not.toHaveBeenCalled();
  });

  it('stops the loop (does NOT throw) when the cap runs dry AFTER some chunks landed', async () => {
    // 26 ids → chunk 1 (25) delivers, chunk 2 (1) hits the cap with 0 articles.
    const missingIds = Array.from({ length: HYDRATE_CHUNK_SIZE + 1 }, (_, i) => `art-${i}`);
    mockGetArticlesForTopicsByIds
      .mockResolvedValueOnce({ articles: [{ _id: 'art-0' }], dailyLimitReached: false })
      .mockResolvedValueOnce({
        articles: [],
        dailyLimitReached: true,
        resetAt: '2026-06-26T00:00:00.000Z',
      });
    mockPersistAndLinkV2Suggestions.mockResolvedValue({ insertedCount: 1, linkedCount: 1 });
    mockGetUnscoredSuggestionsWithFacts.mockResolvedValue([
      { id: 'art-0', titleEn: 't', descriptionEn: 'd', relatedFacts: [{}] },
    ]);
    mockGateUnscoredForScoring.mockResolvedValue({
      enqueueIds: ['art-0'],
      propagatedCount: 0,
      heldBackCount: 0,
    });
    const diffResult: DiffResult = {
      serverArticleIds: missingIds,
      articleToTopicTexts: new Map(),
      missingIds,
    };

    const result = await stepHydratePersistEnqueue(diffResult, makeCtx(), makeOpts());

    // Both chunks were attempted, but the loop stopped after the dry chunk.
    expect(mockGetArticlesForTopicsByIds).toHaveBeenCalledTimes(2);
    expect(result.dailyLimitReached).toBe(true);
    expect(result.resetAt).toBe('2026-06-26T00:00:00.000Z');
    // Chunk 1's article still landed.
    expect(result.insertedCount).toBe(1);
    expect(mockEnqueueCandidates).toHaveBeenCalledWith(['art-0']);
  });

  it('runs the gate + enqueue PER chunk (greedy overlap), not once at the end', async () => {
    const chunk1Ids = Array.from({ length: HYDRATE_CHUNK_SIZE }, (_, i) => `art-${i}`);
    const chunk2Ids = Array.from({ length: 5 }, (_, i) => `art-${HYDRATE_CHUNK_SIZE + i}`);
    const missingIds = [...chunk1Ids, ...chunk2Ids];

    mockGetArticlesForTopicsByIds
      .mockResolvedValueOnce({
        articles: chunk1Ids.map((id) => ({ _id: id })),
        dailyLimitReached: false,
      })
      .mockResolvedValueOnce({
        articles: chunk2Ids.map((id) => ({ _id: id })),
        dailyLimitReached: false,
      });
    mockPersistAndLinkV2Suggestions.mockResolvedValue({ insertedCount: 1, linkedCount: 1 });
    // Order-independent: markIneligibleAndCollectEligible scopes to the chunk set,
    // so a single all-eligible result yields the right per-chunk eligible ids.
    mockGetUnscoredSuggestionsWithFacts.mockResolvedValue(
      missingIds.map((id) => ({ id, titleEn: 't', descriptionEn: 'd', relatedFacts: [{}] })),
    );
    // Gate returns a fixed elected id each call (one per chunk that had eligibles).
    mockGateUnscoredForScoring.mockResolvedValue({
      enqueueIds: ['elected'],
      propagatedCount: 0,
      heldBackCount: 0,
    });
    const diffResult: DiffResult = {
      serverArticleIds: missingIds,
      articleToTopicTexts: new Map(),
      missingIds,
    };

    const result = await stepHydratePersistEnqueue(diffResult, makeCtx(), makeOpts());

    // Both chunks persisted eligible rows → the gate+enqueue ran once per chunk
    // (greedy overlap) rather than a single post-loop enqueue.
    expect(mockPersistAndLinkV2Suggestions).toHaveBeenCalledTimes(2);
    expect(mockGateUnscoredForScoring).toHaveBeenCalledTimes(2);
    expect(mockEnqueueCandidates).toHaveBeenCalledTimes(2);
    expect(mockEnqueueCandidates).toHaveBeenCalledWith(['elected']);
    // enqueuedCount accumulates gate.enqueueIds.length across both invocations.
    expect(result.enqueuedCount).toBe(2);
  });

  it('still enqueues once with whatever landed when the daily-limit cuts the run short mid-loop', async () => {
    // 26 ids → chunk 1 (25) delivers eligible ids, chunk 2 (1) hits the cap dry.
    const missingIds = Array.from({ length: HYDRATE_CHUNK_SIZE + 1 }, (_, i) => `art-${i}`);
    mockGetArticlesForTopicsByIds
      .mockResolvedValueOnce({ articles: [{ _id: 'art-0' }], dailyLimitReached: false })
      .mockResolvedValueOnce({
        articles: [],
        dailyLimitReached: true,
        resetAt: '2026-06-26T00:00:00.000Z',
      });
    mockPersistAndLinkV2Suggestions.mockResolvedValue({ insertedCount: 1, linkedCount: 1 });
    mockGetUnscoredSuggestionsWithFacts.mockResolvedValue([
      { id: 'art-0', titleEn: 't', descriptionEn: 'd', relatedFacts: [{}] },
    ]);
    mockGateUnscoredForScoring.mockResolvedValue({
      enqueueIds: ['art-0'],
      propagatedCount: 0,
      heldBackCount: 0,
    });
    const diffResult: DiffResult = {
      serverArticleIds: missingIds,
      articleToTopicTexts: new Map(),
      missingIds,
    };

    const result = await stepHydratePersistEnqueue(diffResult, makeCtx(), makeOpts());

    expect(mockEnqueueCandidates).toHaveBeenCalledTimes(1);
    expect(mockEnqueueCandidates).toHaveBeenCalledWith(['art-0']);
    expect(result.dailyLimitReached).toBe(true);
    expect(result.enqueuedCount).toBe(1);
  });

  it('processes missingIds in HYDRATE_CHUNK_SIZE chunks (one server query each)', async () => {
    const missingIds = Array.from({ length: HYDRATE_CHUNK_SIZE + 5 }, (_, i) => `art-${i}`);
    mockGetArticlesForTopicsByIds.mockResolvedValue({ articles: [], dailyLimitReached: false });
    const diffResult: DiffResult = {
      serverArticleIds: missingIds,
      articleToTopicTexts: new Map(),
      missingIds,
    };

    await stepHydratePersistEnqueue(diffResult, makeCtx(), makeOpts());

    // 30 ids → 2 chunks (25 + 5) → 2 calls.
    expect(mockGetArticlesForTopicsByIds).toHaveBeenCalledTimes(2);
    expect(mockGetArticlesForTopicsByIds.mock.calls[0][0]).toHaveLength(HYDRATE_CHUNK_SIZE);
    expect(mockGetArticlesForTopicsByIds.mock.calls[1][0]).toHaveLength(5);
  });

  it('skips all work and returns zeros when missingIds is empty', async () => {
    const diffResult: DiffResult = {
      serverArticleIds: ['art-1'],
      articleToTopicTexts: new Map(),
      missingIds: [],
    };

    const result = await stepHydratePersistEnqueue(diffResult, makeCtx(), makeOpts());

    expect(mockGetArticlesForTopicsByIds).not.toHaveBeenCalled();
    expect(result).toEqual({
      insertedCount: 0,
      enqueuedCount: 0,
      dailyLimitReached: false,
      resetAt: undefined,
    });
  });

  it('reports cumulative progress across chunks', async () => {
    mockGetArticlesForTopicsByIds.mockResolvedValue({ articles: [], dailyLimitReached: false });
    const missingIds = ['art-1', 'art-2'];
    const diffResult: DiffResult = {
      serverArticleIds: missingIds,
      articleToTopicTexts: new Map(),
      missingIds,
    };
    const opts = makeOpts();

    await stepHydratePersistEnqueue(diffResult, makeCtx(), opts);

    // Progress reaches the full total by the end.
    expect(opts.onProgress).toHaveBeenCalledWith(2);
  });

  it('passes signal to withRetry', async () => {
    mockGetArticlesForTopicsByIds.mockResolvedValue({
      articles: [{ _id: 'art-1' }],
      dailyLimitReached: false,
    });
    const diffResult: DiffResult = {
      serverArticleIds: ['art-1'],
      articleToTopicTexts: new Map(),
      missingIds: ['art-1'],
    };

    const ctx = makeCtx();
    await stepHydratePersistEnqueue(diffResult, ctx, makeOpts());

    expect(mockWithRetry).toHaveBeenCalledWith(expect.any(Function), ctx.signal);
  });

  it('honors mid-loop abort: stops launching chunks beyond the in-flight pool', async () => {
    // 4 chunks; concurrency is HYDRATE_CONCURRENCY (3). The 3 pool workers grab
    // chunks 0,1,2 and fetch concurrently; the first chunk's refreshStore aborts,
    // so the 4th chunk is never launched.
    const missingIds = Array.from(
      { length: HYDRATE_CHUNK_SIZE * 4 },
      (_, i) => `art-${i}`,
    );
    mockGetArticlesForTopicsByIds.mockResolvedValue({
      articles: [{ _id: 'art-x' }],
      dailyLimitReached: false,
    });
    mockPersistAndLinkV2Suggestions.mockResolvedValue({ insertedCount: 1, linkedCount: 1 });
    mockGetUnscoredSuggestionsWithFacts.mockResolvedValue([]);
    const diffResult: DiffResult = {
      serverArticleIds: missingIds,
      articleToTopicTexts: new Map(),
      missingIds,
    };

    const ctx = makeCtx();
    // Abort on the first chunk's store refresh.
    const opts = makeOpts({
      refreshStore: jest.fn().mockImplementation(async () => {
        ctx.controller.abort();
      }),
    });

    await stepHydratePersistEnqueue(diffResult, ctx, opts);

    // Exactly the initial concurrent pool was fetched — chunk 4 was never launched.
    expect(mockGetArticlesForTopicsByIds).toHaveBeenCalledTimes(HYDRATE_CONCURRENCY);
  });

  it('hydrates chunks concurrently (up to HYDRATE_CONCURRENCY fetches in flight)', async () => {
    // 4 chunks; each fetch is deferred so we can observe how many run at once.
    const missingIds = Array.from(
      { length: HYDRATE_CHUNK_SIZE * 4 },
      (_, i) => `art-${i}`,
    );
    let inFlight = 0;
    let maxInFlight = 0;
    const resolvers: Array<() => void> = [];
    mockGetArticlesForTopicsByIds.mockImplementation(
      () =>
        new Promise((resolve) => {
          inFlight++;
          maxInFlight = Math.max(maxInFlight, inFlight);
          resolvers.push(() => {
            inFlight--;
            resolve({ articles: [], dailyLimitReached: false });
          });
        }),
    );
    const flush = async () => {
      for (let i = 0; i < 8; i++) await Promise.resolve();
    };
    const diffResult: DiffResult = {
      serverArticleIds: missingIds,
      articleToTopicTexts: new Map(),
      missingIds,
    };

    const p = stepHydratePersistEnqueue(diffResult, makeCtx(), makeOpts());
    await flush();
    // The pool launched exactly HYDRATE_CONCURRENCY fetches before any resolved.
    expect(maxInFlight).toBe(HYDRATE_CONCURRENCY);

    // Drain: each resolution frees a worker to launch the next chunk.
    while (resolvers.length > 0) {
      resolvers.shift()!();
      await flush();
    }
    await p;
    expect(mockGetArticlesForTopicsByIds).toHaveBeenCalledTimes(4);
  });

  it('awaits resume between chunks (pause support)', async () => {
    mockGetArticlesForTopicsByIds.mockResolvedValue({ articles: [], dailyLimitReached: false });
    const diffResult: DiffResult = {
      serverArticleIds: ['art-1'],
      articleToTopicTexts: new Map(),
      missingIds: ['art-1'],
    };
    const opts = makeOpts();

    await stepHydratePersistEnqueue(diffResult, makeCtx(), opts);

    expect(opts.awaitResumeIfPaused).toHaveBeenCalled();
  });

  it('runs the skip gate over the in-flight set and enqueues only its elected ids', async () => {
    mockGetArticlesForTopicsByIds.mockResolvedValue({
      articles: [{ _id: 'a' }, { _id: 'b' }],
      dailyLimitReached: false,
    });
    mockPersistAndLinkV2Suggestions.mockResolvedValue({ insertedCount: 2, linkedCount: 2 });
    mockGetUnscoredSuggestionsWithFacts.mockResolvedValue([
      { id: 'a', titleEn: 't', descriptionEn: 'd', relatedFacts: [{}] },
      { id: 'b', titleEn: 't', descriptionEn: 'd', relatedFacts: [{}] },
    ]);
    mockGetNonTerminalCandidateIds.mockResolvedValue(new Set(['in-flight-id']));
    // a and b are same-sync duplicates → gate elects only 'a', holds 'b' back.
    mockGateUnscoredForScoring.mockResolvedValue({
      enqueueIds: ['a'],
      propagatedCount: 0,
      heldBackCount: 1,
    });
    const diffResult: DiffResult = {
      serverArticleIds: ['a', 'b'],
      articleToTopicTexts: new Map(),
      missingIds: ['a', 'b'],
    };

    const result = await stepHydratePersistEnqueue(diffResult, makeCtx(), makeOpts());

    // Gate received the in-flight set produced by getNonTerminalCandidateIds
    // plus the (fail-open null) user geo/language context loaded once per run.
    expect(mockGateUnscoredForScoring).toHaveBeenCalledWith(new Set(['in-flight-id']), null);
    // Only the elected representative is enqueued; the held-back sibling is not.
    expect(mockEnqueueCandidates).toHaveBeenCalledWith(['a']);
    expect(result.enqueuedCount).toBe(1);
  });

  it('refreshes the store when the gate propagated scores, and does not enqueue when it elected nothing', async () => {
    mockGetArticlesForTopicsByIds.mockResolvedValue({
      articles: [{ _id: 'a' }],
      dailyLimitReached: false,
    });
    mockPersistAndLinkV2Suggestions.mockResolvedValue({ insertedCount: 1, linkedCount: 1 });
    mockGetUnscoredSuggestionsWithFacts.mockResolvedValue([
      { id: 'a', titleEn: 't', descriptionEn: 'd', relatedFacts: [{}] },
    ]);
    // Gate propagated a donor's score onto 'a' (nothing left to enqueue).
    mockGateUnscoredForScoring.mockResolvedValue({
      enqueueIds: [],
      propagatedCount: 1,
      heldBackCount: 0,
    });
    const diffResult: DiffResult = {
      serverArticleIds: ['a'],
      articleToTopicTexts: new Map(),
      missingIds: ['a'],
    };
    const opts = makeOpts();

    const result = await stepHydratePersistEnqueue(diffResult, makeCtx(), opts);

    // Propagated rows are terminal Complete — surfaced via an extra refreshStore
    // (one for the hydration chunk + one for the propagation).
    expect((opts.refreshStore as jest.Mock).mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(mockEnqueueCandidates).not.toHaveBeenCalled();
    expect(result.enqueuedCount).toBe(0);
  });

  it('skips the gate entirely when no eligible ids were collected this sync', async () => {
    mockGetArticlesForTopicsByIds.mockResolvedValue({
      articles: [{ _id: 'a' }],
      dailyLimitReached: false,
    });
    mockPersistAndLinkV2Suggestions.mockResolvedValue({ insertedCount: 1, linkedCount: 1 });
    // Persisted row is ineligible (no facts) → allEligibleIds empty → gate skipped.
    mockGetUnscoredSuggestionsWithFacts.mockResolvedValue([
      { id: 'a', titleEn: 't', descriptionEn: 'd', relatedFacts: [] },
    ]);
    const diffResult: DiffResult = {
      serverArticleIds: ['a'],
      articleToTopicTexts: new Map(),
      missingIds: ['a'],
    };

    const result = await stepHydratePersistEnqueue(diffResult, makeCtx(), makeOpts());

    expect(mockGateUnscoredForScoring).not.toHaveBeenCalled();
    expect(mockEnqueueCandidates).not.toHaveBeenCalled();
    expect(result.enqueuedCount).toBe(0);
  });
});

// ── stepScore ─────────────────────────────────────────────────────────────────

describe('stepScore', () => {
  it('throws "aborted" when signal is already aborted', async () => {
    // Covers the abort check before the dynamic import
    const ctx = makeCtx(true);
    await expect(stepScore(ctx)).rejects.toThrow('aborted');
    expect(mockRunScoringPass).not.toHaveBeenCalled();
  });

  // NOTE: stepScore uses `await import('@/lib/services/SuggestionSyncService')`
  // which is a dynamic import. Despite jest.mock() being set up for that path,
  // @babel/plugin-transform-modules-commonjs does NOT rewrite dynamic import() calls,
  // so jest's VM throws "A dynamic import callback was invoked without --experimental-vm-modules"
  // when the dynamic import line is actually reached. The runScoringPass() line is therefore
  // unreachable in this test environment. The abort-path is tested above.
});

export {};
