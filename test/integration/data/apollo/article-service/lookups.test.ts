// ArticleService's single-article and list reads: related coverage (behind the N10 switch), one
// article, a country's articles, and the cluster reads. Real Apollo client against MSW.
import ArticleService, { RELATED_FILTERS_LIVE } from '@/lib/article-service';
import { __resetRelatedOriginalSupport } from '@/lib/article-service';
import { mockGql, mockGqlError, server } from '@/test/helpers';
import { ARTICLE_IDS } from '@/test/mock-backend/fixtures/articles';
import { expectNoServiceCapture, recordOps, resetServiceState, sentOf, spyLogger } from './kit';

beforeEach(() => {
    resetServiceState();
    __resetRelatedOriginalSupport();
});

const emptyPage = { articles: [], pageInfo: { endCursor: null, hasNextPage: false, pageSize: 0 }, restarted: false };

describe('getRelatedArticlesPage', () => {
    it('ships with the N10 filters on, behind the unsupported-server latch', () => {
        expect(RELATED_FILTERS_LIVE).toBe(true);
    });

    // The default document is what a latched or switched-off session sends: `false` is the injected switch.
    const defaultDoc = (input: Parameters<typeof ArticleService.getRelatedArticlesPage>[0]) =>
        ArticleService.getRelatedArticlesPage(input, false);

    it('returns the served page with facets null: the default document does not ask for them', async () => {
        const sent = recordOps();
        const result = await defaultDoc({ articleId: ARTICLE_IDS[0] });
        expect(result.articles.length).toBeGreaterThan(0);
        expect(result.articles.map((a) => a._id)).not.toContain(ARTICLE_IDS[0]);
        expect(result.restarted).toBe(false);
        expect(result.facets).toBeNull();
        const [call] = await sentOf(sent, 'GetRelatedArticlesPage');
        expect(call.query).not.toMatch(/facets/);
    });

    it('returns an empty CLOSED page when the field is null', async () => {
        server.use(mockGql('GetRelatedArticlesPage', { relatedArticlesPage: null }));
        const result = await defaultDoc({ articleId: 'art-1' });
        // hasNextPage false matters more than the empty array: a caller that kept paging on a null
        // response would loop.
        expect(result).toEqual({ ...emptyPage, facets: null });
    });

    it('surfaces the restarted flag so the caller can replace instead of append', async () => {
        server.use(mockGql('GetRelatedArticlesPage', { relatedArticlesPage: { ...emptyPage, restarted: true } }));
        const result = await defaultDoc({ articleId: 'art-1', after: 'a-dead-cursor' });
        expect(result.restarted).toBe(true);
    });

    it('sends every paging variable, nulling the ones not supplied', async () => {
        const sent = recordOps();
        await defaultDoc({
            articleId: 'the-article-id',
            stableClusterId: 'stable-1',
            first: 10,
            after: 'cursor-1',
            excludeIds: ['local-1'],
        });
        expect((await sentOf(sent, 'GetRelatedArticlesPage'))[0].variables).toEqual({
            articleId: 'the-article-id',
            stableClusterId: 'stable-1',
            sortMode: null,
            context: null,
            excludeIds: ['local-1'],
            first: 10,
            after: 'cursor-1',
        });
    });

    it('while the switch is off, never sends the filter arguments or asks for facets, even when asked', async () => {
        const sent = recordOps();
        const result = await defaultDoc({
            articleId: 'art-1',
            filter: { countries: ['DEU'], languages: ['de'] },
        });
        const calls = await sentOf(sent);
        expect(calls.map((c) => c.op)).toEqual(['GetRelatedArticlesPage']);
        expect(calls[0].query).not.toMatch(/countries|languages|facets/);
        expect(calls[0].variables).not.toHaveProperty('countries');
        expect(calls[0].variables).not.toHaveProperty('languages');
        expect(result.facets).toBeNull();
    });

    it('while live (the second argument), sends the filtered document with the chosen filters and returns facets', async () => {
        const facets = { countries: [{ code: 'DEU', count: 4 }], languages: [{ code: 'de', count: 4 }] };
        server.use(mockGql('GetRelatedArticlesPageFiltered', { relatedArticlesPage: { ...emptyPage, facets } }));
        const sent = recordOps();
        const result = await ArticleService.getRelatedArticlesPage(
            { articleId: 'art-1', filter: { countries: ['DEU'], languages: ['de'] } },
            true,
        );
        const [call] = await sentOf(sent, 'GetRelatedArticlesPageFiltered');
        expect(call.query).toMatch(/countries: \$countries/);
        expect(call.query).toMatch(/facets/);
        expect(call.variables).toMatchObject({ countries: ['DEU'], languages: ['de'] });
        expect(result.facets).toEqual(facets);
    });

    it('while live with an empty filter, still asks for facets and sends null filters ("All")', async () => {
        const sent = recordOps();
        const result = await ArticleService.getRelatedArticlesPage({ articleId: 'art-1', filter: { countries: [] } }, true);
        const [call] = await sentOf(sent, 'GetRelatedArticlesPageFiltered');
        expect(call.query).toMatch(/facets/);
        expect(call.variables).toMatchObject({ countries: null, languages: null });
        expect(result.facets).not.toBeNull();
    });

        it('sends the filtered document by default and asks for the same article fields as the default one', async () => {
        const sent = recordOps();
        const result = await ArticleService.getRelatedArticlesPage({ articleId: ARTICLE_IDS[0] });
        const [call] = await sentOf(sent, 'GetRelatedArticlesPageFiltered');
        expect(call.query).toMatch(/facets/);
        expect(call.query).toMatch(/title_original/);
        expect(result.facets).not.toBeNull();
    });

    describe('on a server without the filters (400 graphql-response+json)', () => {
        const reject = () =>
            mockGqlError('GetRelatedArticlesPageFiltered', 'GRAPHQL_VALIDATION_FAILED', {
                httpStatus: 400,
                headers: { 'Content-Type': 'application/graphql-response+json' },
            });

        it('latches for the session: retries the default document once, then never sends the filtered one again', async () => {
            const logs = spyLogger();
            server.use(reject());
            const sent = recordOps();
            const first = await ArticleService.getRelatedArticlesPage({ articleId: ARTICLE_IDS[0] });
            await ArticleService.getRelatedArticlesPage({ articleId: ARTICLE_IDS[0] });
            expect((await sentOf(sent)).map((c) => c.op)).toEqual([
                'GetRelatedArticlesPageFiltered',
                'GetRelatedArticlesPage',
                'GetRelatedArticlesPage',
            ]);
            expect(first.facets).toBeNull();
            expect(first.articles.length).toBeGreaterThan(0);
            expectNoServiceCapture(logs.capture, 0);
        });

        it('any other error is rethrown and does not latch', async () => {
            server.use(mockGqlError('GetRelatedArticlesPageFiltered', 'INTERNAL_SERVER_ERROR'));
            await expect(ArticleService.getRelatedArticlesPage({ articleId: 'art-1' })).rejects.toThrow();
            server.resetHandlers();
            const sent = recordOps();
            await ArticleService.getRelatedArticlesPage({ articleId: 'art-1' });
            expect((await sentOf(sent)).map((c) => c.op)).toEqual(['GetRelatedArticlesPageFiltered']);
        });
    });

it('rethrows with a breadcrumb that names the article, and no capture of its own', async () => {
        const logs = spyLogger();
        server.use(mockGqlError('GetRelatedArticlesPage', 'INTERNAL_SERVER_ERROR', { message: 'related articles failed' }));
        await expect(defaultDoc({ articleId: 'art-1' })).rejects.toThrow(
            'related articles failed',
        );
        expectNoServiceCapture(logs.capture);
        expect(logs.crumb).toHaveBeenCalledWith(
            expect.stringContaining('getRelatedArticlesPage failed'),
            'article-service',
            expect.objectContaining({ method: 'getRelatedArticlesPage', articleId: 'art-1' }),
            'warning',
        );
    });
});

describe('getArticleById', () => {
    it('returns the served article and asks again on every call (no-cache)', async () => {
        const sent = recordOps();
        const first = await ArticleService.getArticleById(ARTICLE_IDS[0]);
        await ArticleService.getArticleById(ARTICLE_IDS[0]);
        expect(first?._id).toBe(ARTICLE_IDS[0]);
        const calls = await sentOf(sent, 'GetArticleById');
        expect(calls).toHaveLength(2);
        expect(calls[0].variables).toEqual({ id: ARTICLE_IDS[0] });
    });

    it('returns null when the server has no such article (TTL expired)', async () => {
        expect(await ArticleService.getArticleById('not-a-fixture-id')).toBeNull();
        server.use(mockGql('GetArticleById', { articleById: null }));
        expect(await ArticleService.getArticleById('art-1')).toBeNull();
    });

    it('returns null when the whole response is { data: null }', async () => {
        server.use(mockGql('GetArticleById', null));
        expect(await ArticleService.getArticleById('art-1')).toBeNull();
    });

    // A check is shown only to the device that asked for it (navx): the article query must never
    // carry one another reader asked for.
    it('never selects a fact check on the article', async () => {
        const sent = recordOps();
        await ArticleService.getArticleById(ARTICLE_IDS[0]);
        const [call] = await sentOf(sent, 'GetArticleById');
        expect(call.query).not.toContain('factCheck');
    });

    it('rethrows with a breadcrumb that names the article, and no capture of its own', async () => {
        const logs = spyLogger();
        server.use(mockGqlError('GetArticleById', 'INTERNAL_SERVER_ERROR', { message: 'article not found' }));
        await expect(ArticleService.getArticleById('art-x')).rejects.toThrow('article not found');
        expectNoServiceCapture(logs.capture);
        expect(logs.crumb).toHaveBeenCalledWith(
            expect.stringContaining('getArticleById failed'),
            'article-service',
            expect.objectContaining({ method: 'getArticleById', articleId: 'art-x' }),
            'warning',
        );
    });
});

// getArticlesForCountry had no legacy test; its GLOBAL mapping and defaults are pinned here.
describe('getArticlesForCountry', () => {
    it('maps the GLOBAL sentinel to a null countryCode and defaults first to 20', async () => {
        const sent = recordOps();
        const result = await ArticleService.getArticlesForCountry('GLOBAL');
        expect(result.articles.length).toBeGreaterThan(0);
        expect((await sentOf(sent, 'GetArticlesForCountry'))[0].variables).toMatchObject({ countryCode: null, first: 20 });
    });

    it('sends a country code, first and after as given', async () => {
        const sent = recordOps();
        await ArticleService.getArticlesForCountry('NLD', { first: 5, after: 'cur' });
        expect((await sentOf(sent, 'GetArticlesForCountry'))[0].variables).toEqual({
            countryCode: 'NLD',
            first: 5,
            after: 'cur',
        });
    });

    it('falls back to an empty closed page of the requested size when the field is null', async () => {
        server.use(mockGql('GetArticlesForCountry', { articlesForCountry: null }));
        const result = await ArticleService.getArticlesForCountry('NLD', { first: 7 });
        expect(result).toEqual({ articles: [], pageInfo: { endCursor: null, hasNextPage: false, pageSize: 7 } });
    });

    it('rethrows with a breadcrumb that names the country, and no capture of its own', async () => {
        const logs = spyLogger();
        server.use(mockGqlError('GetArticlesForCountry', 'INTERNAL_SERVER_ERROR', { message: 'country failed' }));
        await expect(ArticleService.getArticlesForCountry('NLD')).rejects.toThrow('country failed');
        expectNoServiceCapture(logs.capture);
        expect(logs.crumb).toHaveBeenCalledWith(
            expect.stringContaining('getArticlesForCountry failed'),
            'article-service',
            expect.objectContaining({ countryCode: 'NLD' }),
            'warning',
        );
    });
});

const closedPage = (pageSize: number) => ({ endCursor: null, hasNextPage: false, pageSize });

describe('getNewsClusters', () => {
    it('returns the served clusters', async () => {
        const result = await ArticleService.getNewsClusters();
        expect(result.newsClusters.length).toBeGreaterThan(0);
        expect(result.newsClusters[0]._id).toEqual(expect.any(String));
    });

    it('sends countryCodes, and first defaulting to 20', async () => {
        const sent = recordOps();
        await ArticleService.getNewsClusters({ countryCodes: ['USA', 'GBR'] });
        expect((await sentOf(sent, 'GetNewsClusters'))[0].variables).toMatchObject({
            countryCodes: ['USA', 'GBR'],
            first: 20,
        });
    });

    it('sends a custom first and after', async () => {
        const sent = recordOps();
        await ArticleService.getNewsClusters({ first: 5, after: 'cursor-x' });
        expect((await sentOf(sent, 'GetNewsClusters'))[0].variables).toMatchObject({ first: 5, after: 'cursor-x' });
    });

    it('falls back to an empty closed page of the requested size when the field is null', async () => {
        server.use(mockGql('GetNewsClusters', { newsClusters: null }));
        expect(await ArticleService.getNewsClusters()).toEqual({ newsClusters: [], pageInfo: closedPage(20) });
        expect((await ArticleService.getNewsClusters({ first: 7 })).pageInfo.pageSize).toBe(7);
    });

    it('rethrows with a breadcrumb and no capture of its own', async () => {
        const logs = spyLogger();
        server.use(mockGqlError('GetNewsClusters', 'INTERNAL_SERVER_ERROR', { message: 'clusters error' }));
        await expect(ArticleService.getNewsClusters()).rejects.toThrow('clusters error');
        expectNoServiceCapture(logs.capture);
        expect(logs.crumb).toHaveBeenCalledWith(
            expect.stringContaining('getNewsClusters failed'),
            'article-service',
            expect.objectContaining({ method: 'getNewsClusters' }),
            'warning',
        );
    });
});

describe('getNewsClustersForTopicText', () => {
    it('returns the served clusters and sends the topic text with first defaulting to 20', async () => {
        const sent = recordOps();
        const result = await ArticleService.getNewsClustersForTopicText('climate change');
        expect(result.newsClusters.length).toBeGreaterThan(0);
        expect((await sentOf(sent, 'GetNewsClustersForTopicText'))[0].variables).toMatchObject({
            topicText: 'climate change',
            first: 20,
        });
    });

    it('falls back to an empty closed page of the requested size when the field is null', async () => {
        server.use(mockGql('GetNewsClustersForTopicText', { newsClustersForTopicText: null }));
        expect(await ArticleService.getNewsClustersForTopicText('topic')).toEqual({
            newsClusters: [],
            pageInfo: closedPage(20),
        });
        expect((await ArticleService.getNewsClustersForTopicText('topic', { first: 3 })).pageInfo.pageSize).toBe(3);
    });

    it('rethrows with a breadcrumb and no capture of its own', async () => {
        const logs = spyLogger();
        server.use(mockGqlError('GetNewsClustersForTopicText', 'INTERNAL_SERVER_ERROR', { message: 'topic text error' }));
        await expect(ArticleService.getNewsClustersForTopicText('bad topic')).rejects.toThrow('topic text error');
        expectNoServiceCapture(logs.capture);
        expect(logs.crumb).toHaveBeenCalledWith(
            expect.stringContaining('getNewsClustersForTopicText failed'),
            'article-service',
            expect.objectContaining({ method: 'getNewsClustersForTopicText' }),
            'warning',
        );
    });
});

describe('getNewsClusterForArticle', () => {
    it('returns the live cluster and sends the article id with first defaulting to 10', async () => {
        const sent = recordOps();
        const result = await ArticleService.getNewsClusterForArticle(ARTICLE_IDS[0]);
        expect(result?._id).toEqual(expect.any(String));
        expect((await sentOf(sent, 'GetNewsClusterForArticle'))[0].variables).toMatchObject({
            articleId: ARTICLE_IDS[0],
            first: 10,
        });
    });

    it('sends a custom first and after', async () => {
        const sent = recordOps();
        await ArticleService.getNewsClusterForArticle(ARTICLE_IDS[0], { first: 5, after: 'page-2' });
        expect((await sentOf(sent, 'GetNewsClusterForArticle'))[0].variables).toMatchObject({
            first: 5,
            after: 'page-2',
        });
    });

    it('returns null when the article is unclustered', async () => {
        expect(await ArticleService.getNewsClusterForArticle('not-a-fixture-id')).toBeNull();
        server.use(mockGql('GetNewsClusterForArticle', { newsClusterForArticle: null }));
        expect(await ArticleService.getNewsClusterForArticle(ARTICLE_IDS[0])).toBeNull();
    });

    it('returns null when the whole response is { data: null }', async () => {
        server.use(mockGql('GetNewsClusterForArticle', null));
        expect(await ArticleService.getNewsClusterForArticle('art-1')).toBeNull();
    });

    it('rethrows with a breadcrumb and no capture of its own', async () => {
        const logs = spyLogger();
        server.use(mockGqlError('GetNewsClusterForArticle', 'INTERNAL_SERVER_ERROR', { message: 'cluster for article failed' }));
        await expect(ArticleService.getNewsClusterForArticle('art-1')).rejects.toThrow('cluster for article failed');
        expectNoServiceCapture(logs.capture);
        expect(logs.crumb).toHaveBeenCalledWith(
            expect.stringContaining('getNewsClusterForArticle failed'),
            'article-service',
            expect.objectContaining({ method: 'getNewsClusterForArticle' }),
            'warning',
        );
    });
});
