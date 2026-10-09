// The two reads that fall back for a server older than the app: a publisher's articles (`order`)
// and a country's top headlines (Explore's `windowHours`), plus the headlines read's error policy.
// Real Apollo client against MSW. The fallback flags are session memory, reset in beforeEach.
import ArticleService from '@/lib/article-service';
import {
    advanceUntilDone,
    graphql,
    HttpResponse,
    mockGql,
    mockGqlError,
    server,
    useFakeClock,
} from '@/test/helpers';
import { articleFixtures } from '@/test/mock-backend/fixtures/articles';
import {
    breakerFailures,
    expectNoServiceCapture,
    failOp,
    recordOps,
    resetServiceState,
    sentOf,
    spyLogger,
} from './kit';

beforeEach(resetServiceState);

const PUBLISHER = articleFixtures.publications[0].publisherId;
const opNames = async (sent: Awaited<ReturnType<typeof recordOps>>) => (await sentOf(sent)).map((s) => s.op);
const validationFailed = (op: string) => mockGqlError(op, 'GRAPHQL_VALIDATION_FAILED', { message: 'Unknown argument' });

describe('getArticlesForPublisher', () => {
    it('sends order with the ordered document, and a validation failure on it is expected: no capture', async () => {
        const sent = recordOps();
        const result = await ArticleService.getArticlesForPublisher(PUBLISHER, { order: 'NEWEST', first: 20, after: 'x' });
        expect(result.orderApplied).toBe(true);
        expect(result.articles.length).toBeGreaterThan(0);
        const [call] = await sentOf(sent, 'GetArticlesForPublisher');
        expect(call.variables).toEqual({ newsPublisherId: PUBLISHER, first: 20, after: 'x', order: 'NEWEST' });

        // The same document, refused: the link must treat the code as expected (breadcrumb, no event).
        const logs = spyLogger();
        server.use(validationFailed('GetArticlesForPublisher'));
        await ArticleService.getArticlesForPublisher(PUBLISHER, { order: 'NEWEST' });
        expect(logs.capture).not.toHaveBeenCalled();
        expect(logs.crumb).toHaveBeenCalledWith(
            'GraphQL expected error',
            'apollo-error-link',
            expect.objectContaining({ operationName: 'GetArticlesForPublisher', errorCode: 'GRAPHQL_VALIDATION_FAILED' }),
            'info',
        );
    });

    it('without order uses the document without the argument, and its page counts as top headlines', async () => {
        server.use(mockGql('GetArticlesForPublisherNoOrder', { articlesForPublisher: null }));
        const sent = recordOps();
        const result = await ArticleService.getArticlesForPublisher(PUBLISHER);
        const calls = await sentOf(sent);
        expect(calls.map((c) => c.op)).toEqual(['GetArticlesForPublisherNoOrder']);
        expect(calls[0].variables).not.toHaveProperty('order');
        expect(result).toEqual({
            articles: [],
            pageInfo: { endCursor: null, hasNextPage: false, pageSize: 20 },
            orderApplied: true,
        });
    });

    describe('on GRAPHQL_VALIDATION_FAILED', () => {
        beforeEach(() => {
            spyLogger();
            server.use(validationFailed('GetArticlesForPublisher'));
        });

        it('asks once more without order and answers with orderApplied false for a NEWEST request', async () => {
            const sent = recordOps();
            const logs = spyLogger();
            const result = await ArticleService.getArticlesForPublisher(PUBLISHER, { order: 'NEWEST' });
            expect(await opNames(sent)).toEqual(['GetArticlesForPublisher', 'GetArticlesForPublisherNoOrder']);
            expect(result.orderApplied).toBe(false);
            expect(result.articles.length).toBeGreaterThan(0);
            expect(logs.capture).not.toHaveBeenCalled();
        });

        it('remembers for the session: the next call goes straight to the document without order', async () => {
            await ArticleService.getArticlesForPublisher(PUBLISHER, { order: 'NEWEST' });

            const sent = recordOps();
            const top = await ArticleService.getArticlesForPublisher(PUBLISHER, { order: 'TOP_HEADLINES' });
            const newest = await ArticleService.getArticlesForPublisher(PUBLISHER, { order: 'NEWEST' });
            expect(await opNames(sent)).toEqual(['GetArticlesForPublisherNoOrder', 'GetArticlesForPublisherNoOrder']);
            // Top headlines IS what the server answers without order.
            expect(top.orderApplied).toBe(true);
            expect(newest.orderApplied).toBe(false);
        });

        it('rejects instead of looping when the fallback fails too', async () => {
            const sent = recordOps();
            const logs = spyLogger();
            server.use(validationFailed('GetArticlesForPublisherNoOrder'));
            await expect(ArticleService.getArticlesForPublisher(PUBLISHER, { order: 'NEWEST' })).rejects.toBeTruthy();
            expect(await opNames(sent)).toEqual(['GetArticlesForPublisher', 'GetArticlesForPublisherNoOrder']);
            // The fallback document does not declare the code expected, so the link reports it once.
            expectNoServiceCapture(logs.capture, 1);
        });
    });

    it('propagates any other error without the fallback, and the breadcrumb carries no publisher id', async () => {
        const sent = recordOps();
        const logs = spyLogger();
        server.use(mockGqlError('GetArticlesForPublisher', 'INTERNAL_SERVER_ERROR', { message: 'boom' }));
        await expect(ArticleService.getArticlesForPublisher(PUBLISHER, { order: 'NEWEST' })).rejects.toThrow('boom');
        expect(await opNames(sent)).toEqual(['GetArticlesForPublisher']);
        expectNoServiceCapture(logs.capture);
        const crumb = logs.crumb.mock.calls.find((c) => String(c[0]).includes('getArticlesForPublisher failed'));
        expect(crumb).toBeDefined();
        expect(JSON.stringify(crumb)).not.toContain(PUBLISHER);
    });

    it('a transport failure is not mistaken for an old server: no fallback document, nothing remembered', async () => {
        useFakeClock(Date.now());
        spyLogger();
        server.use(failOp('GetArticlesForPublisher'));
        const sent = recordOps();
        await expect(
            advanceUntilDone(ArticleService.getArticlesForPublisher(PUBLISHER, { order: 'NEWEST' })),
        ).rejects.toBeTruthy();
        expect(await opNames(sent)).not.toContain('GetArticlesForPublisherNoOrder');

        server.resetHandlers();
        const after = recordOps();
        await ArticleService.getArticlesForPublisher(PUBLISHER, { order: 'NEWEST' });
        expect(await opNames(after)).toEqual(['GetArticlesForPublisher']);
    });

    it('does not remember an unrelated error: the next ordered call still sends order', async () => {
        server.use(mockGqlError('GetArticlesForPublisher', 'INTERNAL_SERVER_ERROR'));
        await expect(ArticleService.getArticlesForPublisher(PUBLISHER, { order: 'NEWEST' })).rejects.toBeTruthy();
        server.resetHandlers();
        const sent = recordOps();
        await ArticleService.getArticlesForPublisher(PUBLISHER, { order: 'NEWEST' });
        expect(await opNames(sent)).toEqual(['GetArticlesForPublisher']);
    });
});

const edition = {
    __typename: 'TopHeadlinesForCountryResponse',
    articles: [],
    headlines: [],
    editionBuiltAt: null,
    pageInfo: { endCursor: null, hasNextPage: false, pageSize: 10 },
};

describe('getTopHeadlinesForCountry: Explore window', () => {
    it('sends windowHours with the windowed document', async () => {
        const sent = recordOps();
        await ArticleService.getTopHeadlinesForCountry('NLD', { first: 10, windowHours: 48 });
        const [call] = await sentOf(sent);
        expect(call.op).toBe('GetTopHeadlinesForCountryWindowed');
        expect(call.variables).toEqual({ countryCode: 'NLD', first: 10, windowHours: 48 });
    });

    it('without windowHours keeps the plain document, unchanged', async () => {
        const sent = recordOps();
        await ArticleService.getTopHeadlinesForCountry('GLOBAL', { first: 10 });
        const [call] = await sentOf(sent);
        expect(call.op).toBe('GetTopHeadlinesForCountry');
        expect(call.variables).toEqual({ countryCode: null, first: 10 });
    });

    it('on GRAPHQL_VALIDATION_FAILED (server older than the app) asks the plain document, quietly, and remembers', async () => {
        server.use(validationFailed('GetTopHeadlinesForCountryWindowed'));
        server.use(mockGql('GetTopHeadlinesForCountry', { topHeadlinesForCountry: edition }));
        const sent = recordOps();
        const logs = spyLogger();

        const first = await ArticleService.getTopHeadlinesForCountry('NLD', { windowHours: 24 });
        expect(first).toEqual(edition);
        expect(await opNames(sent)).toEqual(['GetTopHeadlinesForCountryWindowed', 'GetTopHeadlinesForCountry']);
        expect(logs.capture).not.toHaveBeenCalled();
        expect(logs.info).toHaveBeenCalledWith(expect.stringContaining('plain document this session'));

        await ArticleService.getTopHeadlinesForCountry('NLD', { windowHours: 48 });
        expect(await opNames(sent)).toEqual([
            'GetTopHeadlinesForCountryWindowed',
            'GetTopHeadlinesForCountry',
            'GetTopHeadlinesForCountry',
        ]);
    });

    it('on BAD_WINDOW (server without 6h/12h) serves that request plain, without latching', async () => {
        server.use(mockGqlError('GetTopHeadlinesForCountryWindowed', 'BAD_WINDOW', { message: 'windowHours must be 24 or 48' }));
        server.use(mockGql('GetTopHeadlinesForCountry', { topHeadlinesForCountry: edition }));
        const sent = recordOps();
        const logs = spyLogger();

        expect(await ArticleService.getTopHeadlinesForCountry('NLD', { windowHours: 6 })).toEqual(edition);
        expect(await opNames(sent)).toEqual(['GetTopHeadlinesForCountryWindowed', 'GetTopHeadlinesForCountry']);
        expect(logs.capture).not.toHaveBeenCalled();

        await ArticleService.getTopHeadlinesForCountry('NLD', { windowHours: 48 });
        // Not latched: the window is sent again (this server refuses it again, so plain follows).
        expect((await opNames(sent))[2]).toBe('GetTopHeadlinesForCountryWindowed');
    });

    it('propagates any other error without the fallback', async () => {
        const sent = recordOps();
        server.use(mockGqlError('GetTopHeadlinesForCountryWindowed', 'INTERNAL_SERVER_ERROR', { message: 'boom' }));
        await expect(ArticleService.getTopHeadlinesForCountry('NLD', { windowHours: 24 })).rejects.toThrow('boom');
        expect(await opNames(sent)).toEqual(['GetTopHeadlinesForCountryWindowed']);
    });

    it('a transport failure is not mistaken for an old server: no plain document, nothing remembered', async () => {
        useFakeClock(Date.now());
        spyLogger();
        server.use(failOp('GetTopHeadlinesForCountryWindowed'));
        const sent = recordOps();
        await expect(
            advanceUntilDone(ArticleService.getTopHeadlinesForCountry('NLD', { windowHours: 24 })),
        ).rejects.toBeTruthy();
        expect(await opNames(sent)).not.toContain('GetTopHeadlinesForCountry');

        server.resetHandlers();
        const after = recordOps();
        await ArticleService.getTopHeadlinesForCountry('NLD', { windowHours: 24 });
        expect(await opNames(after)).toEqual(['GetTopHeadlinesForCountryWindowed']);
    });
});

describe('getTopHeadlinesForCountry', () => {
    it('returns the served edition: headlines with cluster sizes, and the build time', async () => {
        const result = await ArticleService.getTopHeadlinesForCountry('NLD', {});
        expect(result.headlines.length).toBeGreaterThan(0);
        expect(result.headlines[0]).toMatchObject({ stableClusterId: expect.any(String), clusterSize: expect.any(Number) });
        expect(result.editionBuiltAt).toEqual(expect.any(String));
    });

    it('falls back to an empty edition when the field is null', async () => {
        server.use(mockGql('GetTopHeadlinesForCountry', { topHeadlinesForCountry: null }));
        const result = await ArticleService.getTopHeadlinesForCountry('USA', {});
        expect(result.headlines).toEqual([]);
        expect(result.editionBuiltAt).toBeNull();
        expect(result.pageInfo).toEqual({ endCursor: null, hasNextPage: false, pageSize: 20 });
    });

    it.each([
        ['GLOBAL', null],
        [null, null],
        [undefined, null],
        ['USA', 'USA'],
    ])('sends countryCode %p as %p', async (given, sentAs) => {
        const sent = recordOps();
        await ArticleService.getTopHeadlinesForCountry(given, {});
        const [call] = await sentOf(sent, 'GetTopHeadlinesForCountry');
        expect(call.variables.countryCode ?? null).toBe(sentAs);
    });

    it('sends first defaulting to 20, or the first and after given, and asks again every time (no-cache)', async () => {
        const sent = recordOps();
        await ArticleService.getTopHeadlinesForCountry('USA', {});
        await ArticleService.getTopHeadlinesForCountry('USA', { first: 5, after: 'cur' });
        const calls = await sentOf(sent, 'GetTopHeadlinesForCountry');
        expect(calls).toHaveLength(2);
        expect(calls[0].variables.first).toBe(20);
        expect(calls[1].variables).toMatchObject({ first: 5, after: 'cur' });
    });

    it('rethrows with a breadcrumb that names the country, and no capture of its own', async () => {
        const logs = spyLogger();
        server.use(mockGqlError('GetTopHeadlinesForCountry', 'INTERNAL_SERVER_ERROR', { message: 'top headlines error' }));
        await expect(ArticleService.getTopHeadlinesForCountry('USA', {})).rejects.toThrow('top headlines error');
        expectNoServiceCapture(logs.capture);
        expect(logs.crumb).toHaveBeenCalledWith(
            expect.stringContaining('getTopHeadlinesForCountry failed'),
            'article-service',
            expect.objectContaining({ method: 'getTopHeadlinesForCountry', countryCode: 'USA' }),
            'warning',
        );
    });

    // The 401 rule lives in the Apollo error link alone (MERA-APP-77): the service breadcrumbs and
    // rethrows, so the breaker sees exactly one failure and nothing is captured.
    describe('auth failures are left to the link', () => {
        it('a network 401: one breaker failure, no capture, the service breadcrumb and the rejection', async () => {
            const logs = spyLogger();
            server.use(
                graphql.operation(({ operationName }) =>
                    operationName === 'GetTopHeadlinesForCountry' ? new Response('no session', { status: 401 }) : undefined,
                ),
            );
            await expect(ArticleService.getTopHeadlinesForCountry('USA', {})).rejects.toBeTruthy();
            expect(logs.capture).not.toHaveBeenCalled();
            expect(breakerFailures()).toBe(1);
            expect(logs.crumb).toHaveBeenCalledWith(
                expect.stringContaining('getTopHeadlinesForCountry failed'),
                'article-service',
                expect.objectContaining({ method: 'getTopHeadlinesForCountry', countryCode: 'USA' }),
                'warning',
            );
        });

        it('a GraphQL UNAUTHENTICATED: one breaker failure, no capture', async () => {
            const logs = spyLogger();
            server.use(mockGqlError('GetTopHeadlinesForCountry', 'UNAUTHENTICATED', { message: 'Unauthorized' }));
            await expect(ArticleService.getTopHeadlinesForCountry('USA', {})).rejects.toBeTruthy();
            expect(logs.capture).not.toHaveBeenCalled();
            expect(breakerFailures()).toBe(1);
        });

        it('a non-401 network error: the link reports it once, the breaker is untouched', async () => {
            const logs = spyLogger();
            useFakeClock(Date.now());
            server.use(
                graphql.operation(({ operationName }) =>
                    operationName === 'GetTopHeadlinesForCountry' ? new HttpResponse(null, { status: 500 }) : undefined,
                ),
            );
            await expect(
                advanceUntilDone(ArticleService.getTopHeadlinesForCountry('USA', {})),
            ).rejects.toBeTruthy();
            expectNoServiceCapture(logs.capture);
            expect(breakerFailures()).toBe(0);
        });
    });
});
