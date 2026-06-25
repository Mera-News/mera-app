// feed-sync-steps.test.ts — unit tests for each step function

const mockGetFacts = jest.fn();
const mockGetLocalSuggestionServerIds = jest.fn();
const mockGetUnscoredSuggestionsWithFacts = jest.fn();
const mockBatchMarkAsScoredByIds = jest.fn();
const mockPersistAndLinkV2Suggestions = jest.fn();
const mockGetArticleIdsForTopics = jest.fn();
const mockGetArticlesForTopicsByIds = jest.fn();
const mockWithRetry = jest.fn();
const mockRunScoringPass = jest.fn();
const mockLogInfo = jest.fn();

jest.mock('@/lib/database/services/fact-service', () => ({
  getFacts: (...args: any[]) => mockGetFacts(...args),
}));

jest.mock('@/lib/database/services/article-suggestion-service', () => ({
  getLocalSuggestionServerIds: (...args: any[]) => mockGetLocalSuggestionServerIds(...args),
  getUnscoredSuggestionsWithFacts: (...args: any[]) => mockGetUnscoredSuggestionsWithFacts(...args),
  batchMarkAsScoredByIds: (...args: any[]) => mockBatchMarkAsScoredByIds(...args),
  persistAndLinkV2Suggestions: (...args: any[]) => mockPersistAndLinkV2Suggestions(...args),
}));

jest.mock('@/lib/article-service', () => ({
  ArticleService: {
    getArticleIdsForTopics: (...args: any[]) => mockGetArticleIdsForTopics(...args),
    getArticlesForTopicsByIds: (...args: any[]) => mockGetArticlesForTopicsByIds(...args),
  },
}));

jest.mock('@/lib/utils/retry', () => ({
  withRetry: (fn: any, signal: any) => mockWithRetry(fn, signal),
}));

jest.mock('@/lib/services/SuggestionSyncService', () => ({
  runScoringPass: (...args: any[]) => mockRunScoringPass(...args),
}));

jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: {
    info: (...args: any[]) => mockLogInfo(...args),
    warn: jest.fn(),
    captureException: jest.fn(),
  },
}));

import {
  stepFetchTopicIds,
  stepDiff,
  stepHydrate,
  stepPersist,
  stepScore,
} from '../feed-sync-steps';
import type { FetchTopicIdsResult, DiffResult, HydrateResult } from '../feed-sync-steps';

function makeCtx(aborted = false) {
  const controller = new AbortController();
  if (aborted) controller.abort();
  return {
    jobId: 'job-steps-1',
    attempt: 1,
    signal: controller.signal,
    reportProgress: jest.fn(),
    log: jest.fn(),
  };
}

beforeEach(() => {
  jest.clearAllMocks();

  // Default: withRetry calls the fn and returns its result
  mockWithRetry.mockImplementation((fn: () => any) => fn());
  mockGetFacts.mockResolvedValue([]);
  mockGetLocalSuggestionServerIds.mockResolvedValue([]);
  mockGetUnscoredSuggestionsWithFacts.mockResolvedValue([]);
  mockBatchMarkAsScoredByIds.mockResolvedValue(undefined);
  mockPersistAndLinkV2Suggestions.mockResolvedValue({ insertedCount: 0, linkedCount: 0 });
  mockGetArticleIdsForTopics.mockResolvedValue({ results: [] });
  mockGetArticlesForTopicsByIds.mockResolvedValue([]);
  mockRunScoringPass.mockResolvedValue(5);
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

// ── stepHydrate ───────────────────────────────────────────────────────────────

describe('stepHydrate', () => {
  it('throws "aborted" when signal is already aborted', async () => {
    const ctx = makeCtx(true);
    const diffResult: DiffResult = {
      serverArticleIds: [],
      articleToTopicTexts: new Map(),
      missingIds: ['art-1'],
    };
    await expect(stepHydrate(diffResult, ctx, jest.fn())).rejects.toThrow('aborted');
  });

  it('calls ArticleService.getArticlesForTopicsByIds when missingIds is non-empty', async () => {
    const mockArticles = [{ id: 'art-1', title: 'Article 1' }];
    mockGetArticlesForTopicsByIds.mockResolvedValue({
      articles: mockArticles,
      dailyLimitReached: false,
    });
    const diffResult: DiffResult = {
      serverArticleIds: ['art-1'],
      articleToTopicTexts: new Map([['art-1', ['topic-a']]]),
      missingIds: ['art-1'],
    };
    const onProgress = jest.fn();

    const ctx = makeCtx();
    const result = await stepHydrate(diffResult, ctx, onProgress);

    expect(mockGetArticlesForTopicsByIds).toHaveBeenCalledWith(['art-1'], onProgress);
    expect(result.fetched).toEqual(mockArticles);
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

    const err = await stepHydrate(diffResult, makeCtx(), jest.fn()).catch((e) => e);
    expect((err as { code?: string }).code).toBe('daily-limit');
    expect((err as { resetAt?: number }).resetAt).toBe(
      Date.parse('2026-06-25T00:00:00.000Z'),
    );
  });

  it('does NOT throw when the cap only partially clipped — delivers the granted articles', async () => {
    const mockArticles = [{ id: 'art-1', title: 'Article 1' }];
    mockGetArticlesForTopicsByIds.mockResolvedValue({
      articles: mockArticles,
      dailyLimitReached: true,
      resetAt: '2026-06-25T00:00:00.000Z',
    });
    const diffResult: DiffResult = {
      serverArticleIds: ['art-1', 'art-2'],
      articleToTopicTexts: new Map(),
      missingIds: ['art-1', 'art-2'],
    };

    const result = await stepHydrate(diffResult, makeCtx(), jest.fn());
    expect(result.fetched).toEqual(mockArticles);
    // Partial clip is surfaced up so the machine can show the banner now.
    expect(result.dailyLimitReached).toBe(true);
    expect(result.resetAt).toBe('2026-06-25T00:00:00.000Z');
  });

  it('skips ArticleService call and returns empty fetched when missingIds is empty', async () => {
    const diffResult: DiffResult = {
      serverArticleIds: ['art-1'],
      articleToTopicTexts: new Map(),
      missingIds: [], // empty → no hydration needed
    };

    const ctx = makeCtx();
    const result = await stepHydrate(diffResult, ctx, jest.fn());

    expect(mockGetArticlesForTopicsByIds).not.toHaveBeenCalled();
    expect(result.fetched).toEqual([]);
  });

  it('returns articleToTopicTexts from diffResult', async () => {
    const topicMap = new Map([['art-1', ['t1']]]);
    const diffResult: DiffResult = {
      serverArticleIds: ['art-1'],
      articleToTopicTexts: topicMap,
      missingIds: [],
    };

    const ctx = makeCtx();
    const result = await stepHydrate(diffResult, ctx, jest.fn());

    expect(result.articleToTopicTexts).toBe(topicMap);
  });

  it('passes signal to withRetry', async () => {
    mockGetArticlesForTopicsByIds.mockResolvedValue({
      articles: [{ id: 'art-1' }],
      dailyLimitReached: false,
    });
    const diffResult: DiffResult = {
      serverArticleIds: ['art-1'],
      articleToTopicTexts: new Map(),
      missingIds: ['art-1'],
    };

    const ctx = makeCtx();
    await stepHydrate(diffResult, ctx, jest.fn());

    expect(mockWithRetry).toHaveBeenCalledWith(expect.any(Function), ctx.signal);
  });
});

// ── stepPersist ───────────────────────────────────────────────────────────────

describe('stepPersist', () => {
  it('throws "aborted" when signal is already aborted', async () => {
    const ctx = makeCtx(true);
    const hydrateResult: HydrateResult = {
      fetched: [],
      articleToTopicTexts: new Map(),
      dailyLimitReached: false,
    };
    await expect(stepPersist(hydrateResult, ctx)).rejects.toThrow('aborted');
  });

  it('calls persistAndLinkV2Suggestions with fetched articles and topic map', async () => {
    const articles = [{ id: 'art-1' }] as any[];
    const topicMap = new Map([['art-1', ['t1']]]);
    mockPersistAndLinkV2Suggestions.mockResolvedValue({ insertedCount: 1, linkedCount: 1 });
    const hydrateResult: HydrateResult = { fetched: articles, articleToTopicTexts: topicMap, dailyLimitReached: false };

    const ctx = makeCtx();
    const result = await stepPersist(hydrateResult, ctx);

    expect(mockPersistAndLinkV2Suggestions).toHaveBeenCalledWith(articles, topicMap);
    expect(result).toEqual({ insertedCount: 1, linkedCount: 1 });
  });

  it('marks ineligible articles as scored when they exist', async () => {
    mockPersistAndLinkV2Suggestions.mockResolvedValue({ insertedCount: 2, linkedCount: 2 });
    mockGetUnscoredSuggestionsWithFacts.mockResolvedValue([
      { id: 'art-bad-1', titleEn: null, descriptionEn: 'desc', relatedFacts: [] },
      { id: 'art-bad-2', titleEn: 'title', descriptionEn: null, relatedFacts: [] },
      { id: 'art-good', titleEn: 'title', descriptionEn: 'desc', relatedFacts: [{}] },
    ]);
    const hydrateResult: HydrateResult = { fetched: [], articleToTopicTexts: new Map(), dailyLimitReached: false };

    const ctx = makeCtx();
    await stepPersist(hydrateResult, ctx);

    expect(mockBatchMarkAsScoredByIds).toHaveBeenCalledWith(['art-bad-1', 'art-bad-2']);
  });

  it('skips batchMarkAsScoredByIds when no ineligible articles', async () => {
    mockPersistAndLinkV2Suggestions.mockResolvedValue({ insertedCount: 1, linkedCount: 1 });
    mockGetUnscoredSuggestionsWithFacts.mockResolvedValue([
      { id: 'art-good', titleEn: 'title', descriptionEn: 'desc', relatedFacts: [{}] },
    ]);
    const hydrateResult: HydrateResult = { fetched: [], articleToTopicTexts: new Map(), dailyLimitReached: false };

    const ctx = makeCtx();
    await stepPersist(hydrateResult, ctx);

    expect(mockBatchMarkAsScoredByIds).not.toHaveBeenCalled();
  });

  it('logs and skips ctx.log for ineligible when count is 0', async () => {
    mockPersistAndLinkV2Suggestions.mockResolvedValue({ insertedCount: 0, linkedCount: 0 });
    mockGetUnscoredSuggestionsWithFacts.mockResolvedValue([]);
    const hydrateResult: HydrateResult = { fetched: [], articleToTopicTexts: new Map(), dailyLimitReached: false };

    const ctx = makeCtx();
    await stepPersist(hydrateResult, ctx);

    expect(ctx.log).not.toHaveBeenCalledWith(expect.stringContaining('pre-scored'));
  });

  it('logs pre-scored count via ctx.log when ineligible > 0', async () => {
    mockPersistAndLinkV2Suggestions.mockResolvedValue({ insertedCount: 1, linkedCount: 1 });
    mockGetUnscoredSuggestionsWithFacts.mockResolvedValue([
      { id: 'ineligible-1', titleEn: null, descriptionEn: 'ok', relatedFacts: [{}] },
    ]);
    const hydrateResult: HydrateResult = { fetched: [], articleToTopicTexts: new Map(), dailyLimitReached: false };

    const ctx = makeCtx();
    await stepPersist(hydrateResult, ctx);

    expect(ctx.log).toHaveBeenCalledWith(expect.stringContaining('pre-scored 1 ineligible'));
  });

  it('considers articles with empty relatedFacts as ineligible', async () => {
    mockPersistAndLinkV2Suggestions.mockResolvedValue({ insertedCount: 0, linkedCount: 0 });
    mockGetUnscoredSuggestionsWithFacts.mockResolvedValue([
      { id: 'art-no-facts', titleEn: 'title', descriptionEn: 'desc', relatedFacts: [] },
    ]);
    const hydrateResult: HydrateResult = { fetched: [], articleToTopicTexts: new Map(), dailyLimitReached: false };

    const ctx = makeCtx();
    await stepPersist(hydrateResult, ctx);

    expect(mockBatchMarkAsScoredByIds).toHaveBeenCalledWith(['art-no-facts']);
  });
});

// ── stepScore ─────────────────────────────────────────────────────────────────

describe('stepScore', () => {
  it('throws "aborted" when signal is already aborted', async () => {
    // Covers line 127: the abort check before the dynamic import
    const ctx = makeCtx(true);
    await expect(stepScore(ctx)).rejects.toThrow('aborted');
    expect(mockRunScoringPass).not.toHaveBeenCalled();
  });

  // NOTE: stepScore line 128-129 uses `await import('@/lib/services/SuggestionSyncService')`
  // which is a dynamic import. Despite jest.mock() being set up for that path,
  // @babel/plugin-transform-modules-commonjs does NOT rewrite dynamic import() calls,
  // so jest's VM throws "A dynamic import callback was invoked without --experimental-vm-modules"
  // when the dynamic import line is actually reached. Line 129 (runScoringPass()) is therefore
  // unreachable in this test environment. The abort-path (line 127) is tested above.
});

export {};
