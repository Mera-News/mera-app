// ArticleService's id queries and hydration against the real Apollo client and MSW: the recent
// count, per-topic ids, persona ids (both chunked at 150 topics), and the two hydration reads
// (quota-charged and quota-exempt), chunked at 50 ids.
import ArticleService from '@/lib/article-service';
import type { PersonaQueryInput, TopicPaginationInput } from '@/lib/generated/graphql-types';
import { advanceUntilDone, mockGql, mockGqlError, server, setScenario, useFakeClock } from '@/test/helpers';
import {
    ARTICLE_IDS,
    COUNTRY_HEADLINE_IDS,
    GLOBAL_HEADLINE_IDS,
    TOPIC_ARTICLE_IDS,
} from '@/test/mock-backend/fixtures/articles';
import {
    articleWithClusters,
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
    it('returns the count the server sends, and asks again every time (no-cache)', async () => {
        server.use(mockGql('GetRecentArticleCount', { recentArticleCount: 42 }));
        const sent = recordOps();
        expect(await ArticleService.getRecentArticleCount()).toBe(42);
        expect(await ArticleService.getRecentArticleCount()).toBe(42);
        expect(await sentOf(sent, 'GetRecentArticleCount')).toHaveLength(2);
    });

    it('serves the default fixture count', async () => {
        expect(await ArticleService.getRecentArticleCount()).toBe(ARTICLE_IDS.length);
    });

    it('returns null when the whole response is { data: null }', async () => {
        const logs = spyLogger();
        server.use(mockGql('GetRecentArticleCount', null));
        expect(await ArticleService.getRecentArticleCount()).toBeNull();
        // The null comes from the `?? null`, not from the catch: Apollo resolved, nothing was thrown.
        expect(logs.crumb).not.toHaveBeenCalledWith(expect.stringContaining('failed'), 'article-service', expect.anything(), expect.anything());
    });

    it('returns null when the field is null (a failure: recentArticleCount is Int!)', async () => {
        server.use(mockGql('GetRecentArticleCount', { recentArticleCount: null }));
        expect(await ArticleService.getRecentArticleCount()).toBeNull();
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

const topic = (topicText: string): TopicPaginationInput => ({ topicText });
const topics = (n: number, offset = 0) => Array.from({ length: n }, (_, i) => topic(`t${i + offset}`));
const idsResult = (topicText: string, articleIds: string[] = [`a-${topicText}`]) => ({
    __typename: 'TopicArticleIdsResult',
    topicText,
    articleIds,
    hasNextPage: false,
    nextCursor: null,
});

describe('getArticleIdsForTopics', () => {
    it('sends the topics with the default limitPerTopic of 20 and maps the served results', async () => {
        const sent = recordOps();
        const result = await ArticleService.getArticleIdsForTopics([topic('AI'), topic('Tech')]);
        expect(result.results.map((r) => r.topicText)).toEqual(['AI', 'Tech']);
        expect(result.results.flatMap((r) => r.articleIds).sort()).toEqual([...ARTICLE_IDS].sort());
        const [call] = await sentOf(sent, 'GetArticleIdsForTopics');
        expect(call.variables).toEqual({ topics: [{ topicText: 'AI' }, { topicText: 'Tech' }], limitPerTopic: 20 });
    });

    it('sends a custom limitPerTopic', async () => {
        const sent = recordOps();
        await ArticleService.getArticleIdsForTopics([topic('Tech')], { limitPerTopic: 5 });
        expect((await sentOf(sent, 'GetArticleIdsForTopics'))[0].variables.limitPerTopic).toBe(5);
    });

    it('returns an empty result when the whole response is { data: null }', async () => {
        server.use(mockGql('GetArticleIdsForTopics', null));
        expect(await ArticleService.getArticleIdsForTopics([])).toEqual({ results: [] });
    });

    it('returns an empty result when the server sends none or a null field', async () => {
        expect((await ArticleService.getArticleIdsForTopics([])).results).toEqual([]);
        server.use(mockGql('GetArticleIdsForTopics', { articleIdsForTopics: null }));
        expect(await ArticleService.getArticleIdsForTopics([topic('x')])).toEqual({ results: [] });
    });

    it('rethrows with a breadcrumb and no capture of its own', async () => {
        const logs = spyLogger();
        server.use(mockGqlError('GetArticleIdsForTopics', 'INTERNAL_SERVER_ERROR', { message: 'ids failed' }));
        await expect(ArticleService.getArticleIdsForTopics([topic('AI')])).rejects.toThrow('ids failed');
        expectNoServiceCapture(logs.capture);
        expect(logs.crumb).toHaveBeenCalledWith(
            expect.stringContaining('getArticleIdsForTopics FAILED'),
            'article-service',
            expect.objectContaining({ topicCount: 1, method: 'getArticleIdsForTopics' }),
            'warning',
        );
    });

    describe('chunking at 150 topics', () => {
        const echo = mockGql('GetArticleIdsForTopics', (v) => ({
            articleIdsForTopics: {
                __typename: 'ArticleIdsForTopicsResponse',
                results: (v.topics as TopicPaginationInput[]).map((t) => idsResult(t.topicText)),
            },
        }));

        it('sends one request for 150 topics', async () => {
            server.use(echo);
            const sent = recordOps();
            await ArticleService.getArticleIdsForTopics(topics(150));
            const calls = await sentOf(sent, 'GetArticleIdsForTopics');
            expect(calls).toHaveLength(1);
            expect(calls[0].variables.topics).toHaveLength(150);
        });

        it('splits 247 topics into 150 then 97, in order, and merges the results in order', async () => {
            server.use(echo);
            const sent = recordOps();
            const all = topics(247);
            const result = await ArticleService.getArticleIdsForTopics(all);
            const calls = await sentOf(sent, 'GetArticleIdsForTopics');
            expect(calls.map((c) => c.variables.topics.length)).toEqual([150, 97]);
            expect(calls[1].variables.topics[0]).toEqual({ topicText: 't150' });
            expect(result.results.map((r) => r.topicText)).toEqual(all.map((t) => t.topicText));
        });

        it('keeps the first result when a later batch echoes a topic it already has', async () => {
            let call = 0;
            server.use(
                mockGql('GetArticleIdsForTopics', () => ({
                    articleIdsForTopics: { results: [idsResult('t0', [call++ === 0 ? 'x' : 'y'])] },
                })),
            );
            const result = await ArticleService.getArticleIdsForTopics(topics(200));
            expect(result.results).toHaveLength(1);
            expect(result.results[0].articleIds).toEqual(['x']);
        });

        it('sends the same limitPerTopic with every chunk', async () => {
            server.use(echo);
            const sent = recordOps();
            await ArticleService.getArticleIdsForTopics(topics(160), { limitPerTopic: 7 });
            const calls = await sentOf(sent, 'GetArticleIdsForTopics');
            expect(calls.map((c) => c.variables.limitPerTopic)).toEqual([7, 7]);
        });
    });
});

const personaTopics = (n: number, offset = 0) => Array.from({ length: n }, (_, i) => ({ text: `t${i + offset}` }));
const topHeadlines = {
    scopes: [{ scope: 'GLOBAL', countryCode: null }],
    limitPerScope: 5,
} as unknown as PersonaQueryInput['topHeadlines'];
const personaTopicResult = (text: string) => ({
    __typename: 'PersonaTopicResult',
    topicText: text,
    articleIds: [`a-${text}`],
    matchMeta: [],
    nextCursor: null,
    hasNextPage: false,
});
const headlineResult = (scope: string) => ({
    __typename: 'HeadlineScopeResult',
    scope,
    countryCode: null,
    articleIds: [`h-${scope}`],
    clusterSizes: [1],
    stableClusterIds: ['sc-1'],
});
const personaReply = (topicTexts: string[], scopes: string[] = []) => ({
    articleIdsForPersona: {
        __typename: 'PersonaQueryResult',
        topicResults: topicTexts.map(personaTopicResult),
        headlineResults: scopes.map(headlineResult),
    },
});
const personaQuery = (over: Record<string, unknown>) => over as unknown as PersonaQueryInput;

describe('getArticleIdsForPersona', () => {
    it('sends the query as one variable and serves topic matches and headline scopes separately', async () => {
        const sent = recordOps();
        const query = personaQuery({
            topics: [{ text: 'f1' }, { text: 'chess' }],
            topHeadlines: {
                scopes: [{ scope: 'GLOBAL' }, { scope: 'COUNTRY', countryCode: 'NLD' }],
                limitPerScope: 10,
            },
        });
        const result = await ArticleService.getArticleIdsForPersona(query);

        expect((await sentOf(sent, 'GetArticleIdsForPersona'))[0].variables).toEqual({ query });
        expect(result.topicResults.map((r) => r.topicText)).toEqual(['f1', 'chess']);
        expect(result.topicResults.flatMap((r) => r.articleIds).sort()).toEqual([...TOPIC_ARTICLE_IDS].sort());
        expect(result.headlineResults.map((h) => h.scope)).toEqual(['GLOBAL', 'COUNTRY']);
        expect(result.headlineResults[0].articleIds).toEqual([...GLOBAL_HEADLINE_IDS]);
        expect(result.headlineResults[1].articleIds).toEqual([...COUNTRY_HEADLINE_IDS]);
        expect(result.headlineResults[1].countryCode).toBe('NLD');
    });

    it('returns the empty shape when the whole response is { data: null }', async () => {
        server.use(mockGql('GetArticleIdsForPersona', null));
        expect(await ArticleService.getArticleIdsForPersona(personaQuery({ topics: [] }))).toEqual({
            topicResults: [],
            headlineResults: [],
        });
    });

    it('returns the empty shape when the server sends a null field', async () => {
        server.use(mockGql('GetArticleIdsForPersona', { articleIdsForPersona: null }));
        expect(await ArticleService.getArticleIdsForPersona(personaQuery({ topics: [] }))).toEqual({
            topicResults: [],
            headlineResults: [],
        });
    });

    describe('chunking at 150 topics', () => {
        const echo = (scopes: string[] = []) =>
            mockGql('GetArticleIdsForPersona', (v) => {
                const asked = (v.query as { topics: { text: string }[] }).topics.map((t) => t.text);
                return personaReply(asked, scopes);
            });

        it('sends one request, topHeadlines included, for 150 topics', async () => {
            server.use(echo());
            const sent = recordOps();
            await ArticleService.getArticleIdsForPersona(personaQuery({ topics: personaTopics(150), topHeadlines }));
            const calls = await sentOf(sent, 'GetArticleIdsForPersona');
            expect(calls).toHaveLength(1);
            expect(calls[0].variables.query.topics).toHaveLength(150);
            expect(calls[0].variables.query.topHeadlines).toEqual(topHeadlines);
        });

        it('splits 219 topics into 150 then 69 and keeps the result order', async () => {
            server.use(echo(['GLOBAL']));
            const sent = recordOps();
            const all = personaTopics(219);
            const result = await ArticleService.getArticleIdsForPersona(personaQuery({ topics: all, topHeadlines }));
            const calls = await sentOf(sent, 'GetArticleIdsForPersona');
            expect(calls.map((c) => c.variables.query.topics.length)).toEqual([150, 69]);
            expect(result.topicResults.map((r) => r.topicText)).toEqual(all.map((t) => t.text));
        });

        it('sends topHeadlines on the FIRST chunk only', async () => {
            server.use(echo());
            const sent = recordOps();
            await ArticleService.getArticleIdsForPersona(personaQuery({ topics: personaTopics(219), topHeadlines }));
            const calls = await sentOf(sent, 'GetArticleIdsForPersona');
            expect(calls[0].variables.query.topHeadlines).toEqual(topHeadlines);
            expect(calls[1].variables.query).not.toHaveProperty('topHeadlines');
        });

        it('concatenates headlineResults and keeps the first of a topic echoed by a later chunk', async () => {
            let call = 0;
            server.use(
                mockGql('GetArticleIdsForPersona', () =>
                    call++ === 0 ? personaReply(['t0'], ['GLOBAL']) : personaReply(['t0', 't150']),
                ),
            );
            const result = await ArticleService.getArticleIdsForPersona(
                personaQuery({ topics: personaTopics(200), topHeadlines }),
            );
            expect(result.topicResults.map((r) => r.topicText)).toEqual(['t0', 't150']);
            expect(result.topicResults[0].articleIds).toEqual(['a-t0']);
            expect(result.headlineResults).toHaveLength(1);
        });

        it('carries the rest of the query (limitPerTopic) onto every chunk', async () => {
            server.use(echo());
            const sent = recordOps();
            await ArticleService.getArticleIdsForPersona(personaQuery({ topics: personaTopics(160), limitPerTopic: 40 }));
            const calls = await sentOf(sent, 'GetArticleIdsForPersona');
            expect(calls.map((c) => c.variables.query.limitPerTopic)).toEqual([40, 40]);
        });
    });

    it('rethrows with a breadcrumb and no capture of its own', async () => {
        const logs = spyLogger();
        server.use(mockGqlError('GetArticleIdsForPersona', 'INTERNAL_SERVER_ERROR', { message: 'persona query failed' }));
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

    it('reports the FULL topic count when the second chunk fails', async () => {
        const logs = spyLogger();
        let call = 0;
        server.use(
            mockGql('GetArticleIdsForPersona', (v) => {
                if (call++ === 0) return personaReply((v.query as any).topics.map((t: any) => t.text));
                // Not a GraphQL body: the client rejects it.
                throw new Error('chunk 2 failed');
            }),
        );
        await expect(
            ArticleService.getArticleIdsForPersona(personaQuery({ topics: personaTopics(219) })),
        ).rejects.toBeTruthy();
        expect(crumbOf(logs.crumb, 'getArticleIdsForPersona FAILED')?.[2]).toMatchObject({ topicCount: 219 });
    });
});

const ids = (n: number) => Array.from({ length: n }, (_, i) => `id-${i}`);
/** Echoes one article per requested id; ids at or past `capFrom` clip the response and set the cap. */
const hydrate = (op: string, key: string, over: (asked: string[]) => Record<string, unknown> = () => ({})) =>
    mockGql(op, (v) => {
        const asked = v.articleIds as string[];
        return {
            [key]: {
                __typename: 'ArticlesForTopicsByIdsResponse',
                articles: asked.map(articleWithClusters),
                dailyLimitReached: false,
                resetAt: null,
                ...over(asked),
            },
        };
    });

describe('getArticlesForTopicsByIds', () => {
    const echo = () => hydrate('GetArticlesForTopicsByIds', 'articlesForTopicsByIds');

    it('returns an empty result for no ids without sending a request', async () => {
        const sent = recordOps();
        expect(await ArticleService.getArticlesForTopicsByIds([])).toEqual({ articles: [], dailyLimitReached: false });
        expect(await sentOf(sent)).toHaveLength(0);
    });

    it('hydrates the fixture articles for one chunk and reports no cap', async () => {
        const wanted = ARTICLE_IDS.slice(0, 3);
        const sent = recordOps();
        const result = await ArticleService.getArticlesForTopicsByIds([...wanted]);
        expect(result.articles.map((a) => a._id).sort()).toEqual([...wanted].sort());
        expect(result.dailyLimitReached).toBe(false);
        expect(result.resetAt).toBeUndefined();
        expect(await sentOf(sent, 'GetArticlesForTopicsByIds')).toHaveLength(1);
    });

    it.each([
        [3, [3]],
        [50, [50]],
        [51, [50, 1]],
        [150, [50, 50, 50]],
    ])('splits %i ids into chunks of %j', async (count, sizes) => {
        server.use(echo());
        const sent = recordOps();
        const result = await ArticleService.getArticlesForTopicsByIds(ids(count));
        const calls = await sentOf(sent, 'GetArticlesForTopicsByIds');
        expect(calls.map((c) => c.variables.articleIds.length).sort((a, b) => b - a)).toEqual(sizes);
        expect(result.articles).toHaveLength(count);
    });

    it('sends the chunk boundaries as the variables', async () => {
        server.use(echo());
        const sent = recordOps();
        await ArticleService.getArticlesForTopicsByIds(ids(60));
        const calls = (await sentOf(sent, 'GetArticlesForTopicsByIds')).map((c) => c.variables.articleIds as string[]);
        const first = calls.find((c) => c[0] === 'id-0')!;
        const second = calls.find((c) => c[0] === 'id-50')!;
        expect(first).toHaveLength(50);
        expect(second).toHaveLength(10);
    });

    it('ORs dailyLimitReached across chunks and surfaces the resetAt of the capped one', async () => {
        server.use(
            hydrate('GetArticlesForTopicsByIds', 'articlesForTopicsByIds', (asked) =>
                asked.includes('id-50') ? { dailyLimitReached: true, resetAt: '2026-06-25T00:00:00.000Z' } : {},
            ),
        );
        const result = await ArticleService.getArticlesForTopicsByIds(ids(51));
        expect(result.dailyLimitReached).toBe(true);
        expect(result.resetAt).toBe('2026-06-25T00:00:00.000Z');
    });

    it('surfaces the cap exactly as the default server serves it: nothing delivered, a reset time', async () => {
        setScenario({ dailyLimitReached: true });
        const result = await ArticleService.getArticlesForTopicsByIds([...ARTICLE_IDS.slice(0, 3)]);
        expect(result.articles).toEqual([]);
        expect(result.dailyLimitReached).toBe(true);
        expect(result.resetAt).toEqual(expect.stringMatching(/^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/));
    });

    it('reports progress from (0, total) up to (total, total)', async () => {
        server.use(echo());
        const progress: [number, number][] = [];
        await ArticleService.getArticlesForTopicsByIds(ids(100), (done, total) => progress.push([done, total]));
        expect(progress[0]).toEqual([0, 100]);
        expect(progress.every(([, total]) => total === 100)).toBe(true);
        expect(progress[progress.length - 1][0]).toBe(100);
        expect(progress.map(([done]) => done)).toEqual([...progress.map(([done]) => done)].sort((a, b) => a - b));
    });

    it('treats a null field as an empty, uncapped result', async () => {
        server.use(mockGql('GetArticlesForTopicsByIds', { articlesForTopicsByIds: null }));
        const result = await ArticleService.getArticlesForTopicsByIds(['id1']);
        expect(result.articles).toEqual([]);
        expect(result.dailyLimitReached).toBe(false);
    });

    it('rethrows with an error-level breadcrumb and no capture of its own', async () => {
        const logs = spyLogger();
        server.use(mockGqlError('GetArticlesForTopicsByIds', 'INTERNAL_SERVER_ERROR', { message: 'batch fetch error' }));
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
    it('returns an empty result for no ids without sending a request', async () => {
        const sent = recordOps();
        expect(await ArticleService.getArticlesForStories([])).toEqual({ articles: [] });
        expect(await sentOf(sent)).toHaveLength(0);
    });

    it('hydrates the fixture articles and is never capped, even when the daily limit is reached', async () => {
        setScenario({ dailyLimitReached: true });
        const wanted = ARTICLE_IDS.slice(0, 3);
        const result = await ArticleService.getArticlesForStories([...wanted]);
        expect(result.articles.map((a) => a._id).sort()).toEqual([...wanted].sort());
    });

    it('splits 51 ids into 50 then 1 and reports progress', async () => {
        server.use(hydrate('GetArticlesForStories', 'articlesForStories'));
        const sent = recordOps();
        const progress: number[] = [];
        const result = await ArticleService.getArticlesForStories(ids(51), (done) => progress.push(done));
        const calls = await sentOf(sent, 'GetArticlesForStories');
        expect(calls.map((c) => c.variables.articleIds.length).sort((a, b) => b - a)).toEqual([50, 1]);
        expect(result.articles).toHaveLength(51);
        expect(progress[0]).toBe(0);
        expect(progress[progress.length - 1]).toBe(51);
    });

    it('rethrows with an error-level breadcrumb and no capture of its own', async () => {
        const logs = spyLogger();
        server.use(mockGqlError('GetArticlesForStories', 'INTERNAL_SERVER_ERROR', { message: 'stories failed' }));
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
