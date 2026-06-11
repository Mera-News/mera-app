// Mock apollo-client BEFORE any imports that transitively load it.
const mockQuery = jest.fn();
const mockMutate = jest.fn();
const mockCacheReset = jest.fn(async (..._a: any[]) => {});

jest.mock('@/lib/apollo-client', () => ({
    __esModule: true,
    default: {
        query: (...a: any[]) => mockQuery(...a),
        mutate: (...a: any[]) => mockMutate(...a),
        cache: { reset: (...a: any[]) => mockCacheReset(...a) },
    },
}));

jest.mock('@/lib/logger', () => ({
    __esModule: true,
    default: {
        captureException: jest.fn(),
        captureMessage: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
        info: jest.fn(),
    },
}));

import ArticleService from '../article-service';
import logger from '@/lib/logger';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeArticle(overrides: Record<string, unknown> = {}) {
    return {
        _id: 'art-1',
        title: 'Test Article',
        title_en_internal_only: 'Test Article EN',
        description: 'A description',
        description_en_internal_only: 'A description EN',
        pubDate: '2024-01-01T00:00:00Z',
        article_url: 'https://example.com/1',
        image_url: null,
        creator: null,
        source_uri: 'https://example.com',
        original_language_code: 'en',
        publicationSource: { _id: 'pub-1', publication_name: 'Test Pub' },
        ...overrides,
    };
}

function makeArticleWithClusters(id: string) {
    return {
        _id: id,
        clusters: [{ clusterId: 'c-1', confidence: 0.9 }],
        title_en: `Article ${id}`,
        title: `Article ${id}`,
        description_en: null,
        article_url: `https://example.com/${id}`,
        image_url: null,
        country_code: 'US',
        publication_name: 'Pub',
        language_code: 'en',
        pubDate: '2024-01-01T00:00:00Z',
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// getFloorOfHour / getFlooredDateHoursAgo — pure helpers
// ─────────────────────────────────────────────────────────────────────────────

describe('ArticleService.getFloorOfHour', () => {
    beforeEach(() => jest.clearAllMocks());

    it('returns a date with minutes, seconds, and ms zeroed out', () => {
        const input = new Date('2024-06-15T14:37:45.123Z');
        const result = ArticleService.getFloorOfHour(input);
        expect(result.getMinutes()).toBe(0);
        expect(result.getSeconds()).toBe(0);
        expect(result.getMilliseconds()).toBe(0);
    });

    it('preserves the same hour and date', () => {
        const input = new Date('2024-06-15T14:37:45.123Z');
        const result = ArticleService.getFloorOfHour(input);
        expect(result.getUTCHours()).toBe(input.getUTCHours());
        expect(result.getUTCDate()).toBe(input.getUTCDate());
    });

    it('does not mutate the input date', () => {
        const input = new Date('2024-06-15T14:37:45.123Z');
        const originalMs = input.getTime();
        ArticleService.getFloorOfHour(input);
        expect(input.getTime()).toBe(originalMs);
    });

    it('defaults to now when called without arguments', () => {
        const before = Date.now();
        const result = ArticleService.getFloorOfHour();
        const after = Date.now();
        // result must be within the same hour window
        expect(result.getTime()).toBeGreaterThanOrEqual(before - 60 * 60 * 1000);
        expect(result.getTime()).toBeLessThanOrEqual(after);
    });

    it('handles midnight boundary correctly', () => {
        const midnight = new Date('2024-06-15T00:00:00.000Z');
        const result = ArticleService.getFloorOfHour(midnight);
        expect(result.getTime()).toBe(midnight.getTime());
    });
});

describe('ArticleService.getFlooredDateHoursAgo', () => {
    beforeEach(() => jest.clearAllMocks());

    it('returns an ISO string approximately N hours ago (within one hour window)', () => {
        const before = Date.now();
        const result = ArticleService.getFlooredDateHoursAgo(24);
        const after = Date.now();
        const resultMs = new Date(result).getTime();
        // The floor operation zeros out minutes/seconds/ms, so the result can be
        // up to 59m59s earlier than the unflooredvalue, hence the extra hour of tolerance.
        const lowerBound = before - 24 * 60 * 60 * 1000 - 60 * 60 * 1000;
        const upperBound = after - 24 * 60 * 60 * 1000 + 60 * 1000;
        expect(resultMs).toBeGreaterThanOrEqual(lowerBound);
        expect(resultMs).toBeLessThanOrEqual(upperBound);
    });

    it('returns an ISO string with minutes/seconds/ms zeroed', () => {
        const result = ArticleService.getFlooredDateHoursAgo(1);
        const date = new Date(result);
        expect(date.getMinutes()).toBe(0);
        expect(date.getSeconds()).toBe(0);
        expect(date.getMilliseconds()).toBe(0);
    });

    it('returns a valid ISO string', () => {
        const result = ArticleService.getFlooredDateHoursAgo(6);
        expect(() => new Date(result)).not.toThrow();
        expect(typeof result).toBe('string');
        expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// getRecentArticleCount
// ─────────────────────────────────────────────────────────────────────────────

describe('ArticleService.getRecentArticleCount', () => {
    beforeEach(() => jest.clearAllMocks());

    it('returns the count from server', async () => {
        mockQuery.mockResolvedValueOnce({ data: { recentArticleCount: 42 } });
        const result = await ArticleService.getRecentArticleCount();
        expect(result).toBe(42);
        expect(mockQuery).toHaveBeenCalledTimes(1);
        expect(mockQuery).toHaveBeenCalledWith(
            expect.objectContaining({ fetchPolicy: 'no-cache' }),
        );
    });

    it('returns 0 when data is null', async () => {
        mockQuery.mockResolvedValueOnce({ data: null });
        const result = await ArticleService.getRecentArticleCount();
        expect(result).toBe(0);
    });

    it('returns 0 when recentArticleCount is missing from data', async () => {
        mockQuery.mockResolvedValueOnce({ data: {} });
        const result = await ArticleService.getRecentArticleCount();
        expect(result).toBe(0);
    });

    it('swallows errors and returns 0', async () => {
        mockQuery.mockRejectedValueOnce(new Error('network failure'));
        const result = await ArticleService.getRecentArticleCount();
        expect(result).toBe(0);
        expect((logger.captureException as jest.Mock)).toHaveBeenCalledWith(
            expect.any(Error),
            expect.objectContaining({
                tags: { service: 'article-service', method: 'getRecentArticleCount' },
            }),
        );
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// getArticleIdsForTopics
// ─────────────────────────────────────────────────────────────────────────────

describe('ArticleService.getArticleIdsForTopics', () => {
    beforeEach(() => jest.clearAllMocks());

    it('returns results from server', async () => {
        const mockResponse = {
            results: [{ topicText: 'AI', articleIds: ['a1', 'a2'], hasNextPage: false, nextCursor: null }],
        };
        mockQuery.mockResolvedValueOnce({ data: { articleIdsForTopics: mockResponse } });

        const result = await ArticleService.getArticleIdsForTopics([{ topicText: 'AI', cursor: null } as any]);
        expect(result).toEqual(mockResponse);
    });

    it('passes default limitPerTopic of 20', async () => {
        mockQuery.mockResolvedValueOnce({ data: { articleIdsForTopics: { results: [] } } });

        await ArticleService.getArticleIdsForTopics([{ topicText: 'Tech', cursor: null } as any]);
        expect(mockQuery).toHaveBeenCalledWith(
            expect.objectContaining({
                variables: expect.objectContaining({ limitPerTopic: 20 }),
            }),
        );
    });

    it('respects custom limitPerTopic option', async () => {
        mockQuery.mockResolvedValueOnce({ data: { articleIdsForTopics: { results: [] } } });

        await ArticleService.getArticleIdsForTopics([{ topicText: 'Tech', cursor: null } as any], { limitPerTopic: 5 });
        expect(mockQuery).toHaveBeenCalledWith(
            expect.objectContaining({
                variables: expect.objectContaining({ limitPerTopic: 5 }),
            }),
        );
    });

    it('returns empty results when data is null/undefined', async () => {
        mockQuery.mockResolvedValueOnce({ data: null });
        const result = await ArticleService.getArticleIdsForTopics([]);
        expect(result).toEqual({ results: [] });
    });

    it('re-throws on error and logs warn + captureException', async () => {
        const err = new Error('getArticleIdsForTopics failed');
        mockQuery.mockRejectedValueOnce(err);

        await expect(
            ArticleService.getArticleIdsForTopics([{ topicText: 'AI', cursor: null } as any]),
        ).rejects.toThrow('getArticleIdsForTopics failed');

        expect((logger.warn as jest.Mock)).toHaveBeenCalledWith(
            expect.stringContaining('getArticleIdsForTopics FAILED'),
            expect.any(Object),
        );
        expect((logger.captureException as jest.Mock)).toHaveBeenCalledWith(
            err,
            expect.objectContaining({
                tags: { service: 'article-service', method: 'getArticleIdsForTopics' },
            }),
        );
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// getArticlesForTopicsByIds — chunking + concurrency + progress
// ─────────────────────────────────────────────────────────────────────────────

describe('ArticleService.getArticlesForTopicsByIds', () => {
    beforeEach(() => jest.clearAllMocks());

    it('returns empty array for empty input without calling query', async () => {
        const result = await ArticleService.getArticlesForTopicsByIds([]);
        expect(result).toEqual([]);
        expect(mockQuery).not.toHaveBeenCalled();
    });

    it('returns articles for a single chunk (< 50)', async () => {
        const articles = ['id1', 'id2', 'id3'].map(makeArticleWithClusters);
        mockQuery.mockResolvedValueOnce({ data: { articlesForTopicsByIds: articles } });

        const result = await ArticleService.getArticlesForTopicsByIds(['id1', 'id2', 'id3']);
        expect(result).toHaveLength(3);
        expect(mockQuery).toHaveBeenCalledTimes(1);
    });

    it('splits exactly 50 ids into one chunk', async () => {
        const ids = Array.from({ length: 50 }, (_, i) => `id-${i}`);
        const articles = ids.map(makeArticleWithClusters);
        mockQuery.mockResolvedValueOnce({ data: { articlesForTopicsByIds: articles } });

        const result = await ArticleService.getArticlesForTopicsByIds(ids);
        expect(mockQuery).toHaveBeenCalledTimes(1);
        expect(result).toHaveLength(50);
    });

    it('splits 51 ids into exactly 2 chunks', async () => {
        const ids = Array.from({ length: 51 }, (_, i) => `id-${i}`);
        mockQuery.mockResolvedValueOnce({ data: { articlesForTopicsByIds: ids.slice(0, 50).map(makeArticleWithClusters) } });
        mockQuery.mockResolvedValueOnce({ data: { articlesForTopicsByIds: ids.slice(50).map(makeArticleWithClusters) } });

        const result = await ArticleService.getArticlesForTopicsByIds(ids);
        expect(mockQuery).toHaveBeenCalledTimes(2);
        expect(result).toHaveLength(51);
    });

    it('splits 150 ids into exactly 3 chunks of 50', async () => {
        const ids = Array.from({ length: 150 }, (_, i) => `id-${i}`);
        // All 3 batches resolve
        for (let i = 0; i < 3; i++) {
            const slice = ids.slice(i * 50, (i + 1) * 50);
            mockQuery.mockResolvedValueOnce({
                data: { articlesForTopicsByIds: slice.map(makeArticleWithClusters) },
            });
        }

        const result = await ArticleService.getArticlesForTopicsByIds(ids);
        expect(mockQuery).toHaveBeenCalledTimes(3);
        expect(result).toHaveLength(150);
    });

    it('sends correct chunk boundaries as variables', async () => {
        const ids = Array.from({ length: 60 }, (_, i) => `id-${i}`);
        mockQuery.mockResolvedValue({ data: { articlesForTopicsByIds: [] } });

        await ArticleService.getArticlesForTopicsByIds(ids);
        const calls = (mockQuery as jest.Mock).mock.calls;
        const firstCallIds: string[] = calls[0][0].variables.articleIds;
        const secondCallIds: string[] = calls[1][0].variables.articleIds;
        expect(firstCallIds).toHaveLength(50);
        expect(secondCallIds).toHaveLength(10);
        expect(firstCallIds[0]).toBe('id-0');
        expect(secondCallIds[0]).toBe('id-50');
    });

    it('fires onProgress(0, total) at start and updates as batches complete', async () => {
        const ids = Array.from({ length: 100 }, (_, i) => `id-${i}`);
        mockQuery.mockResolvedValue({ data: { articlesForTopicsByIds: [] } });

        const progressCalls: [number, number][] = [];
        await ArticleService.getArticlesForTopicsByIds(ids, (completed, total) => {
            progressCalls.push([completed, total]);
        });

        // First call is (0, 100)
        expect(progressCalls[0]).toEqual([0, 100]);
        // Total is always 100 in every callback
        progressCalls.forEach(([, total]) => expect(total).toBe(100));
        // Last call reflects all 100 ids processed
        const lastCompleted = progressCalls[progressCalls.length - 1][0];
        expect(lastCompleted).toBe(100);
    });

    it('handles null/undefined articlesForTopicsByIds gracefully', async () => {
        mockQuery.mockResolvedValueOnce({ data: { articlesForTopicsByIds: null } });
        const result = await ArticleService.getArticlesForTopicsByIds(['id1']);
        expect(result).toEqual([]);
    });

    it('re-throws on error and logs', async () => {
        const err = new Error('batch fetch error');
        mockQuery.mockRejectedValueOnce(err);

        await expect(
            ArticleService.getArticlesForTopicsByIds(['id1']),
        ).rejects.toThrow('batch fetch error');

        expect((logger.error as jest.Mock)).toHaveBeenCalledWith(
            expect.stringContaining('getArticlesForTopicsByIds FAILED'),
            err,
        );
        expect((logger.captureException as jest.Mock)).toHaveBeenCalledWith(
            err,
            expect.objectContaining({
                tags: { service: 'article-service', method: 'getArticlesForTopicsByIds' },
            }),
        );
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// getRelatedArticles
// ─────────────────────────────────────────────────────────────────────────────

describe('ArticleService.getRelatedArticles', () => {
    beforeEach(() => jest.clearAllMocks());

    it('returns related articles on success', async () => {
        const articles = [
            { _id: 'r1', title_en: 'Related 1', description_en: null, article_url: 'https://x.com/1', image_url: null, country_code: 'US', publication_name: 'Pub', language_code: 'en', pubDate: '2024-01-01' },
        ];
        mockQuery.mockResolvedValueOnce({ data: { relatedArticles: articles } });
        const result = await ArticleService.getRelatedArticles('art-1');
        expect(result).toEqual(articles);
    });

    it('returns empty array when data.relatedArticles is null/undefined', async () => {
        mockQuery.mockResolvedValueOnce({ data: { relatedArticles: null } });
        const result = await ArticleService.getRelatedArticles('art-1');
        expect(result).toEqual([]);
    });

    it('passes articleId as variable', async () => {
        mockQuery.mockResolvedValueOnce({ data: { relatedArticles: [] } });
        await ArticleService.getRelatedArticles('the-article-id');
        expect(mockQuery).toHaveBeenCalledWith(
            expect.objectContaining({ variables: { articleId: 'the-article-id' } }),
        );
    });

    it('re-throws on error and logs captureException', async () => {
        const err = new Error('related articles failed');
        mockQuery.mockRejectedValueOnce(err);

        await expect(ArticleService.getRelatedArticles('art-1')).rejects.toThrow('related articles failed');
        expect((logger.captureException as jest.Mock)).toHaveBeenCalledWith(
            err,
            expect.objectContaining({
                tags: { service: 'article-service', method: 'getRelatedArticles' },
                extra: { articleId: 'art-1' },
            }),
        );
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// getArticleById
// ─────────────────────────────────────────────────────────────────────────────

describe('ArticleService.getArticleById', () => {
    beforeEach(() => jest.clearAllMocks());

    it('returns the article on success', async () => {
        const article = makeArticle();
        mockQuery.mockResolvedValueOnce({ data: { articleById: article } });
        const result = await ArticleService.getArticleById('art-1');
        expect(result).toEqual(article);
    });

    it('returns null when articleById is null (TTL expired)', async () => {
        mockQuery.mockResolvedValueOnce({ data: { articleById: null } });
        const result = await ArticleService.getArticleById('art-1');
        expect(result).toBeNull();
    });

    it('returns null when data itself is null', async () => {
        mockQuery.mockResolvedValueOnce({ data: null });
        const result = await ArticleService.getArticleById('art-1');
        expect(result).toBeNull();
    });

    it('passes id as variable with no-cache policy', async () => {
        mockQuery.mockResolvedValueOnce({ data: { articleById: null } });
        await ArticleService.getArticleById('specific-id');
        expect(mockQuery).toHaveBeenCalledWith(
            expect.objectContaining({
                variables: { id: 'specific-id' },
                fetchPolicy: 'no-cache',
            }),
        );
    });

    it('re-throws on error and logs with articleId', async () => {
        const err = new Error('article not found');
        mockQuery.mockRejectedValueOnce(err);

        await expect(ArticleService.getArticleById('art-x')).rejects.toThrow('article not found');
        expect((logger.captureException as jest.Mock)).toHaveBeenCalledWith(
            err,
            expect.objectContaining({
                tags: { service: 'article-service', method: 'getArticleById' },
                extra: { articleId: 'art-x' },
            }),
        );
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// getArticlesForCluster
// ─────────────────────────────────────────────────────────────────────────────

describe('ArticleService.getArticlesForCluster', () => {
    beforeEach(() => jest.clearAllMocks());

    it('returns articles on success', async () => {
        const articles = [makeArticle(), makeArticle({ _id: 'art-2' })];
        mockQuery.mockResolvedValueOnce({ data: { articlesForCluster: articles } });
        const result = await ArticleService.getArticlesForCluster('cluster-1');
        expect(result).toEqual(articles);
    });

    it('returns empty array when data is falsy', async () => {
        mockQuery.mockResolvedValueOnce({ data: { articlesForCluster: null } });
        const result = await ArticleService.getArticlesForCluster('cluster-1');
        expect(result).toEqual([]);
    });

    it('passes clusterId and articleIdsToExclude', async () => {
        mockQuery.mockResolvedValueOnce({ data: { articlesForCluster: [] } });
        await ArticleService.getArticlesForCluster('c-1', ['excl-1', 'excl-2']);
        expect(mockQuery).toHaveBeenCalledWith(
            expect.objectContaining({
                variables: { clusterId: 'c-1', articleIdsToExclude: ['excl-1', 'excl-2'] },
            }),
        );
    });

    it('passes undefined for articleIdsToExclude when not provided', async () => {
        mockQuery.mockResolvedValueOnce({ data: { articlesForCluster: [] } });
        await ArticleService.getArticlesForCluster('c-1');
        expect(mockQuery).toHaveBeenCalledWith(
            expect.objectContaining({
                variables: { clusterId: 'c-1', articleIdsToExclude: undefined },
            }),
        );
    });

    it('uses cache-first fetchPolicy', async () => {
        mockQuery.mockResolvedValueOnce({ data: { articlesForCluster: [] } });
        await ArticleService.getArticlesForCluster('c-1');
        expect(mockQuery).toHaveBeenCalledWith(
            expect.objectContaining({ fetchPolicy: 'cache-first' }),
        );
    });

    it('re-throws on error', async () => {
        const err = new Error('cluster query failed');
        mockQuery.mockRejectedValueOnce(err);
        await expect(ArticleService.getArticlesForCluster('c-bad')).rejects.toThrow('cluster query failed');
        expect((logger.captureException as jest.Mock)).toHaveBeenCalledWith(
            err,
            expect.objectContaining({
                tags: { service: 'article-service', method: 'getArticlesForCluster' },
            }),
        );
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// getArticlesForPublicationSource
// ─────────────────────────────────────────────────────────────────────────────

describe('ArticleService.getArticlesForPublicationSource', () => {
    beforeEach(() => jest.clearAllMocks());

    it('returns data on success', async () => {
        const serverResp = {
            articles: [makeArticle()],
            pageInfo: { endCursor: 'cursor-1', hasNextPage: true, pageSize: 20 },
        };
        mockQuery.mockResolvedValueOnce({ data: { articlesForPublicationSource: serverResp } });

        const result = await ArticleService.getArticlesForPublicationSource('pub-1');
        expect(result).toEqual(serverResp);
    });

    it('returns default empty structure on null data', async () => {
        mockQuery.mockResolvedValueOnce({ data: { articlesForPublicationSource: null } });
        const result = await ArticleService.getArticlesForPublicationSource('pub-1');
        expect(result.articles).toEqual([]);
        expect(result.pageInfo.hasNextPage).toBe(false);
    });

    it('passes default first=20', async () => {
        mockQuery.mockResolvedValueOnce({ data: { articlesForPublicationSource: null } });
        await ArticleService.getArticlesForPublicationSource('pub-1');
        expect(mockQuery).toHaveBeenCalledWith(
            expect.objectContaining({ variables: expect.objectContaining({ first: 20 }) }),
        );
    });

    it('respects custom first and after options', async () => {
        mockQuery.mockResolvedValueOnce({ data: { articlesForPublicationSource: null } });
        await ArticleService.getArticlesForPublicationSource('pub-1', { first: 10, after: 'cur' });
        expect(mockQuery).toHaveBeenCalledWith(
            expect.objectContaining({
                variables: expect.objectContaining({ first: 10, after: 'cur' }),
            }),
        );
    });

    it('default pageSize in fallback matches options.first', async () => {
        mockQuery.mockResolvedValueOnce({ data: { articlesForPublicationSource: null } });
        const result = await ArticleService.getArticlesForPublicationSource('pub-1', { first: 5 });
        expect(result.pageInfo.pageSize).toBe(5);
    });

    it('re-throws on error', async () => {
        const err = new Error('pub source error');
        mockQuery.mockRejectedValueOnce(err);
        await expect(ArticleService.getArticlesForPublicationSource('pub-1')).rejects.toThrow('pub source error');
        expect((logger.captureException as jest.Mock)).toHaveBeenCalled();
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// getNewsClusters
// ─────────────────────────────────────────────────────────────────────────────

describe('ArticleService.getNewsClusters', () => {
    beforeEach(() => jest.clearAllMocks());

    it('returns clusters on success', async () => {
        const serverResp = {
            newsClusters: [{ _id: 'cl-1', createdAt: '', updatedAt: '', topicConfidence: 0.8, articles: { articles: [], pageInfo: { endCursor: null, hasNextPage: false, pageSize: 1 } } }],
            pageInfo: { endCursor: null, hasNextPage: false, pageSize: 20 },
        };
        mockQuery.mockResolvedValueOnce({ data: { newsClusters: serverResp } });
        const result = await ArticleService.getNewsClusters();
        expect(result).toEqual(serverResp);
    });

    it('returns default empty structure on null data', async () => {
        mockQuery.mockResolvedValueOnce({ data: { newsClusters: null } });
        const result = await ArticleService.getNewsClusters();
        expect(result.newsClusters).toEqual([]);
        expect(result.pageInfo.hasNextPage).toBe(false);
        expect(result.pageInfo.pageSize).toBe(20);
    });

    it('passes userTopicId and countryCodes as variables', async () => {
        mockQuery.mockResolvedValueOnce({ data: { newsClusters: null } });
        await ArticleService.getNewsClusters({ userTopicId: 'ut-1', countryCodes: ['US', 'UK'] });
        expect(mockQuery).toHaveBeenCalledWith(
            expect.objectContaining({
                variables: expect.objectContaining({ userTopicId: 'ut-1', countryCodes: ['US', 'UK'] }),
            }),
        );
    });

    it('passes default first=20', async () => {
        mockQuery.mockResolvedValueOnce({ data: { newsClusters: null } });
        await ArticleService.getNewsClusters();
        expect(mockQuery).toHaveBeenCalledWith(
            expect.objectContaining({ variables: expect.objectContaining({ first: 20 }) }),
        );
    });

    it('respects custom first and after', async () => {
        mockQuery.mockResolvedValueOnce({ data: { newsClusters: null } });
        await ArticleService.getNewsClusters({ first: 5, after: 'cursor-x' });
        expect(mockQuery).toHaveBeenCalledWith(
            expect.objectContaining({
                variables: expect.objectContaining({ first: 5, after: 'cursor-x' }),
            }),
        );
    });

    it('default pageSize in fallback matches options.first', async () => {
        mockQuery.mockResolvedValueOnce({ data: { newsClusters: null } });
        const result = await ArticleService.getNewsClusters({ first: 7 });
        expect(result.pageInfo.pageSize).toBe(7);
    });

    it('re-throws on error', async () => {
        const err = new Error('clusters error');
        mockQuery.mockRejectedValueOnce(err);
        await expect(ArticleService.getNewsClusters()).rejects.toThrow('clusters error');
        expect((logger.captureException as jest.Mock)).toHaveBeenCalled();
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// getNewsClustersForTopicText
// ─────────────────────────────────────────────────────────────────────────────

describe('ArticleService.getNewsClustersForTopicText', () => {
    beforeEach(() => jest.clearAllMocks());

    it('returns clusters for a topic text', async () => {
        const serverResp = {
            newsClusters: [{ _id: 'cl-2', createdAt: '', updatedAt: '', topicConfidence: 0.7, articles: { articles: [], pageInfo: { endCursor: null, hasNextPage: false, pageSize: 1 } } }],
            pageInfo: { endCursor: null, hasNextPage: false, pageSize: 20 },
        };
        mockQuery.mockResolvedValueOnce({ data: { newsClustersForTopicText: serverResp } });
        const result = await ArticleService.getNewsClustersForTopicText('AI research');
        expect(result).toEqual(serverResp);
    });

    it('passes topicText as variable', async () => {
        mockQuery.mockResolvedValueOnce({ data: { newsClustersForTopicText: null } });
        await ArticleService.getNewsClustersForTopicText('climate change');
        expect(mockQuery).toHaveBeenCalledWith(
            expect.objectContaining({
                variables: expect.objectContaining({ topicText: 'climate change' }),
            }),
        );
    });

    it('returns empty structure on null data', async () => {
        mockQuery.mockResolvedValueOnce({ data: { newsClustersForTopicText: null } });
        const result = await ArticleService.getNewsClustersForTopicText('topic');
        expect(result.newsClusters).toEqual([]);
        expect(result.pageInfo.hasNextPage).toBe(false);
        expect(result.pageInfo.pageSize).toBe(20);
    });

    it('default pageSize matches options.first', async () => {
        mockQuery.mockResolvedValueOnce({ data: { newsClustersForTopicText: null } });
        const result = await ArticleService.getNewsClustersForTopicText('topic', { first: 3 });
        expect(result.pageInfo.pageSize).toBe(3);
    });

    it('re-throws on error', async () => {
        const err = new Error('topic text error');
        mockQuery.mockRejectedValueOnce(err);
        await expect(ArticleService.getNewsClustersForTopicText('bad topic')).rejects.toThrow('topic text error');
        expect((logger.captureException as jest.Mock)).toHaveBeenCalledWith(
            err,
            expect.objectContaining({
                tags: { service: 'article-service', method: 'getNewsClustersForTopicText' },
            }),
        );
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// getNewsClusterForUser
// ─────────────────────────────────────────────────────────────────────────────

describe('ArticleService.getNewsClusterForUser', () => {
    beforeEach(() => jest.clearAllMocks());

    it('returns the cluster on success', async () => {
        const cluster = {
            _id: 'cl-1',
            createdAt: '2024-01-01',
            updatedAt: '2024-01-02',
            articles: { articles: [makeArticle()], pageInfo: { endCursor: null, hasNextPage: false, pageSize: 10 } },
        };
        mockQuery.mockResolvedValueOnce({ data: { newsClusterForUser: cluster } });
        const result = await ArticleService.getNewsClusterForUser('cl-1');
        expect(result).toEqual(cluster);
    });

    it('passes clusterId and default first=10', async () => {
        mockQuery.mockResolvedValueOnce({ data: { newsClusterForUser: { _id: 'cl-1', articles: { articles: [], pageInfo: {} } } } });
        await ArticleService.getNewsClusterForUser('cl-1');
        expect(mockQuery).toHaveBeenCalledWith(
            expect.objectContaining({
                variables: expect.objectContaining({ clusterId: 'cl-1', first: 10 }),
            }),
        );
    });

    it('respects custom first and after options', async () => {
        mockQuery.mockResolvedValueOnce({ data: { newsClusterForUser: { _id: 'cl-1', articles: { articles: [], pageInfo: {} } } } });
        await ArticleService.getNewsClusterForUser('cl-1', { first: 5, after: 'page-2' });
        expect(mockQuery).toHaveBeenCalledWith(
            expect.objectContaining({
                variables: expect.objectContaining({ first: 5, after: 'page-2' }),
            }),
        );
    });

    it('throws "News cluster not found" when data is null', async () => {
        mockQuery.mockResolvedValueOnce({ data: { newsClusterForUser: null } });
        await expect(ArticleService.getNewsClusterForUser('cl-missing')).rejects.toThrow('News cluster not found');
        expect((logger.captureException as jest.Mock)).toHaveBeenCalled();
    });

    it('throws "News cluster not found" when data itself is null', async () => {
        mockQuery.mockResolvedValueOnce({ data: null });
        await expect(ArticleService.getNewsClusterForUser('cl-missing')).rejects.toThrow('News cluster not found');
    });

    it('re-throws network errors', async () => {
        const err = new Error('network down');
        mockQuery.mockRejectedValueOnce(err);
        await expect(ArticleService.getNewsClusterForUser('cl-1')).rejects.toThrow('network down');
        expect((logger.captureException as jest.Mock)).toHaveBeenCalledWith(
            err,
            expect.objectContaining({
                tags: { service: 'article-service', method: 'getNewsClusterForUser' },
            }),
        );
    });
});
