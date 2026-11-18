// ArticleService's single-article and list reads: related coverage (behind the N10 switch), one
// article, a country's articles, and the cluster reads. Real Apollo client against MSW.
import ArticleService from '@/lib/article-service';
import { __resetRelatedOriginalSupport } from '@/lib/article-service';
import { mockGqlError, server } from '@/test/helpers';
import { ARTICLE_IDS } from '@/test/mock-backend/fixtures/articles';
import { expectNoServiceCapture, recordOps, resetServiceState, sentOf, spyLogger } from './kit';

beforeEach(() => {
    resetServiceState();
    __resetRelatedOriginalSupport();
});

describe('getRelatedArticlesPage', () => {

    // The default document is what a latched or switched-off session sends: `false` is the injected switch.
    const defaultDoc = (input: Parameters<typeof ArticleService.getRelatedArticlesPage>[0]) =>
        ArticleService.getRelatedArticlesPage(input, false);

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

describe('getNewsClusterForArticle', () => {

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
