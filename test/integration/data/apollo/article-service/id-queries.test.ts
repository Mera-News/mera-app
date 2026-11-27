// ArticleService's id queries and hydration against the real Apollo client and MSW: the recent
// count, per-topic ids, persona ids (both chunked at 150 topics), and the two hydration reads
// (quota-charged and quota-exempt), chunked at 50 ids.
import ArticleService from '@/lib/article-service';
import { useForYouStore } from '@/lib/stores/for-you-store';
import type { PersonaQueryInput } from '@/lib/generated/graphql-types';
import { advanceUntilDone, mockGql, mockGqlError, server, useFakeClock } from '@/test/helpers';
import {
    ARTICLE_IDS,
} from '@/test/mock-backend/fixtures/articles';
import {
    expectNoServiceCapture,
    failOp,
    recordOps,
    resetServiceState,
    sentOf,
    spyLogger,
} from './kit';

beforeEach(resetServiceState);

const crumbOf = (crumb: jest.SpyInstance, text: string) => crumb.mock.calls.find((c) => String(c[0]).includes(text));

describe('getRecentArticleCount', () => {

    it('returns null when the whole response is { data: null }', async () => {
        const logs = spyLogger();
        server.use(mockGql('GetRecentArticleCount', null));
        expect(await ArticleService.getRecentArticleCount()).toBeNull();
        // The null comes from the `?? null`, not from the catch: Apollo resolved, nothing was thrown.
        expect(logs.crumb).not.toHaveBeenCalledWith(expect.stringContaining('failed'), 'article-service', expect.anything(), expect.anything());
    });

    it('swallows a server error, returns null, and leaves a breadcrumb with no capture of its own', async () => {
        const logs = spyLogger();
        server.use(mockGqlError('GetRecentArticleCount', 'INTERNAL_SERVER_ERROR'));
        await expect(ArticleService.getRecentArticleCount()).resolves.toBeNull();
        expectNoServiceCapture(logs.capture);
        expect(logs.crumb).toHaveBeenCalledWith(
            expect.stringContaining('getRecentArticleCount failed'),
            'article-service',
            expect.objectContaining({ method: 'getRecentArticleCount' }),
            'warning',
        );
    });

    it('swallows a transport failure the same way, after the link has retried', async () => {
        const logs = spyLogger();
        useFakeClock(Date.now());
        server.use(failOp('GetRecentArticleCount'));
        await expect(advanceUntilDone(ArticleService.getRecentArticleCount())).resolves.toBeNull();
        expect(crumbOf(logs.crumb, 'getRecentArticleCount failed')).toBeDefined();
        expectNoServiceCapture(logs.capture);
    });
});

const personaTopics = (n: number, offset = 0) => Array.from({ length: n }, (_, i) => ({ text: `t${i + offset}` }));
const personaQuery = (over: Record<string, unknown>) => over as unknown as PersonaQueryInput;

describe('getArticleIdsForPersona', () => {

    it('rethrows with a breadcrumb and no capture of its own', async () => {
        const logs = spyLogger();
        server.use(mockGqlError(/^GetArticleIdsForPersona/, 'INTERNAL_SERVER_ERROR', { message: 'persona query failed' }));
        await expect(
            ArticleService.getArticleIdsForPersona(personaQuery({ topics: personaTopics(1) })),
        ).rejects.toThrow('persona query failed');
        expectNoServiceCapture(logs.capture);
        expect(logs.crumb).toHaveBeenCalledWith(
            expect.stringContaining('getArticleIdsForPersona FAILED'),
            'article-service',
            expect.objectContaining({ topicCount: 1, method: 'getArticleIdsForPersona' }),
            'warning',
        );
    });
});

// A server without ArticleWithClusters.story_key (so without readingScore too) answers the real
// graphql-response+json 400 to the scored and the story_key documents.
describe.each([
    ['getArticlesForTopicsByIds', 'GetArticlesForTopicsByIds'],
    ['getArticlesForStories', 'GetArticlesForStories'],
] as const)('%s on a server without story_key', (method, op) => {
    const reject = (name: string) =>
        mockGqlError(name, 'GRAPHQL_VALIDATION_FAILED', {
            httpStatus: 400,
            headers: { 'Content-Type': 'application/graphql-response+json' },
        });

    it('falls back to the Legacy document once, latches, and neither captures nor raises the sync banner', async () => {
        const logs = spyLogger();
        server.use(reject(`${op}Scored`), reject(op));
        const sent = recordOps();
        const wanted = ARTICLE_IDS.slice(0, 2);
        const result = await ArticleService[method]([...wanted]);
        await ArticleService[method]([...wanted]);
        expect((await sentOf(sent)).map((c) => c.op)).toEqual([`${op}Scored`, op, `${op}Legacy`, `${op}Legacy`]);
        expect(result.articles.map((a) => a._id).sort()).toEqual([...wanted].sort());
        expect(logs.capture).not.toHaveBeenCalled();
        expect(useForYouStore.getState().syncStatusMessage).toBeNull();
    });
});

describe('getArticlesForTopicsByIds', () => {

    it('rethrows with an error-level breadcrumb and no capture of its own', async () => {
        const logs = spyLogger();
        server.use(mockGqlError(/^GetArticlesForTopicsByIds/, 'INTERNAL_SERVER_ERROR', { message: 'batch fetch error' }));
        await expect(ArticleService.getArticlesForTopicsByIds(['id1'])).rejects.toThrow('batch fetch error');
        expectNoServiceCapture(logs.capture);
        expect(logs.crumb).toHaveBeenCalledWith(
            expect.stringContaining('getArticlesForTopicsByIds FAILED'),
            'article-service',
            expect.objectContaining({ idCount: 1, method: 'getArticlesForTopicsByIds' }),
            'error',
        );
    });
});

// The quota-exempt sibling the legacy suite never covered: same chunking, no cap fields.
describe('getArticlesForStories', () => {

    it('rethrows with an error-level breadcrumb and no capture of its own', async () => {
        const logs = spyLogger();
        server.use(mockGqlError(/^GetArticlesForStories/, 'INTERNAL_SERVER_ERROR', { message: 'stories failed' }));
        await expect(ArticleService.getArticlesForStories(['id1'])).rejects.toThrow('stories failed');
        expectNoServiceCapture(logs.capture);
        expect(logs.crumb).toHaveBeenCalledWith(
            expect.stringContaining('getArticlesForStories FAILED'),
            'article-service',
            expect.objectContaining({ idCount: 1, method: 'getArticlesForStories' }),
            'error',
        );
    });
});
