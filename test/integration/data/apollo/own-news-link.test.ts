// The split link: news operations go to the person's own server with nothing of Mera's, account operations stay on Mera.
import { gql } from '@apollo/client';
import { _getBreakerState } from '@/lib/auth-failure-breaker';
import { authClient } from '@/lib/auth-client';
import client from '@/lib/apollo-client';
import { __resetPublisherOrderSupport, ArticleService } from '@/lib/article-service';
import { clientHeaderValue } from '@/lib/observability/client-header';
import { clearLatch, isLatched, useOwnNewsHealth } from '@/lib/own-services/news-latch';
import { NEWS_OPERATIONS } from '@/lib/own-services/news-operations';
import { OWN_NEWS_KEY } from '@/lib/own-services/keys';
import { ownNewsState, recordOwnNewsCheck, saveOwnNewsFields, setOwnNewsOn } from '@/lib/own-services/own-news-state';
import { advanceUntilDone, delay, http, HttpResponse, server, signInFixtureAccount, useFakeClock } from '@/test/helpers';
import { SLOW_REQUEST_MS } from '@/lib/apollo-fetch';
import { useNetworkStore } from '@/lib/stores/network-store';
import { secureStoreDump } from '@/test/helpers/storage';
import { resetLinkState } from './link-chain/kit';

const NEWS = gql`
    query GetArticleIdsForPersona($query: PersonaQueryInput!) {
        articleIdsForPersona(query: $query) {
            topicResults {
                topicText
                articleIds
            }
        }
    }
`;
const ACCOUNT = gql`
    query GetUserBilling {
        userBilling {
            __typename
        }
    }
`;
const PUBLISHER = gql`
    query GetArticlesForPublisher($newsPublisherId: ID!, $first: Int, $order: PublisherArticleOrder) {
        articlesForPublisher(newsPublisherId: $newsPublisherId, first: $first, order: $order) {
            articles {
                _id
            }
        }
    }
`;

const FACT_CHECK = gql`
    query GetFactCheck($articleId: ID!) {
        factCheck(articleId: $articleId) {
            __typename
        }
    }
`;

const OWN = 'https://news.own.test/graphql';
const KEY = 'own-news-key-12345678';
const noCache = { fetchPolicy: 'no-cache' as const };
const askNews = () => client.query({ query: NEWS, variables: { query: { topics: [] } }, ...noCache });
const askAccount = () => client.query({ query: ACCOUNT, ...noCache });
const failure = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e ?? new Error('empty'));

interface Seen {
    host: string;
    op: string;
    headers: Headers;
    redirect: RequestRedirect;
}
/** Every GraphQL POST MSW receives, by host. `settled()` waits for the bodies to be read. */
function record() {
    const seen: Seen[] = [];
    const pending: Promise<unknown>[] = [];
    const listener = ({ request }: { request: Request }) => {
        if (request.method !== 'POST' || !request.url.endsWith('/graphql')) return;
        const entry: Seen = { host: new URL(request.url).host, op: '', headers: request.headers, redirect: request.redirect };
        seen.push(entry);
        pending.push(
            request
                .clone()
                .json()
                .then((b: { operationName?: string }) => {
                    entry.op = b.operationName ?? '';
                })
                .catch(() => undefined),
        );
    };
    server.events.on('request:start', listener);
    cleanups.push(() => server.events.removeListener('request:start', listener));
    return {
        seen,
        settled: async () => {
            await Promise.all(pending);
            return seen;
        },
    };
}
const cleanups: (() => void)[] = [];

const turnOnOwnNews = async (baseUrl = 'https://news.own.test') => {
    await saveOwnNewsFields({ baseUrl, key: KEY });
    await recordOwnNewsCheck('connected', null);
    await setOwnNewsOn(true, { at: 1, privacyVersion: null });
};
/** An own server answering one operation by name; every other operation falls through to the default handlers. */
const ownAnswers = (op: string, respond: () => Response) =>
    http.post(OWN, async ({ request }) => {
        const body = (await request.clone().json().catch(() => ({}))) as { operationName?: string };
        return body.operationName === op ? respond() : undefined;
    });

beforeEach(async () => {
    resetLinkState();
    ownNewsState.resetMemory();
    clearLatch();
    useOwnNewsHealth.setState({ health: null });
    await client.clearStore();
});
afterEach(() => {
    cleanups.splice(0).forEach((c) => c());
    // The client's own fallback latch is module state: never leave it set for the next test.
    __resetPublisherOrderSupport();
});

it('mode off: news and account operations both reach Mera with the cookie, the own server gets nothing', async () => {
    await signInFixtureAccount();
    const cookie = authClient.getCookie();
    expect(cookie).toBeTruthy();
    const rec = record();

    await askNews();
    await askAccount();

    const seen = await rec.settled();
    expect(seen.map((s) => s.op).sort()).toEqual(['GetArticleIdsForPersona', 'GetUserBilling']);
    expect(seen.filter((s) => s.host === 'news.own.test')).toHaveLength(0);
    for (const s of seen) {
        expect(s.headers.get('cookie')).toBe(cookie);
        expect(s.headers.get('x-mera-client')).toBe(clientHeaderValue);
        expect(s.headers.get('x-api-key')).toBeNull();
    }
});

describe('Mera-only operations', () => {
    const askFactCheck = () => client.query({ query: FACT_CHECK, variables: { articleId: 'a1' }, ...noCache });

    it('mode on: reaches neither server, answers NOT_OFFERED marked as the own server, and latches', async () => {
        await signInFixtureAccount();
        await turnOnOwnNews();
        const rec = record();

        const err = (await failure(askFactCheck())) as { errors?: { extensions?: Record<string, unknown> }[] };

        expect(err.errors).toHaveLength(1);
        expect(err.errors?.[0]?.extensions).toEqual({ code: 'NOT_OFFERED', ownServer: true });
        expect(await rec.settled()).toHaveLength(0);
        expect(isLatched('GetFactCheck')).toBe(true);
        expect(_getBreakerState().consecutiveFailures).toBe(0);
    });

    it('mode off: reaches Mera with the cookie, exactly as today', async () => {
        await signInFixtureAccount();
        const rec = record();

        await askFactCheck();

        const seen = await rec.settled();
        expect(seen.map((s) => s.op)).toEqual(['GetFactCheck']);
        expect(seen[0].host).not.toBe('news.own.test');
        expect(seen[0].headers.get('cookie')).toBe(authClient.getCookie());
    });
});

it('an error from Mera never carries the own-server flag', async () => {
    server.use(
        http.post('*/graphql', async ({ request }) => {
            const body = (await request.clone().json()) as { operationName?: string };
            if (body.operationName === 'GetUserBilling') {
                return HttpResponse.json({ errors: [{ message: 'nope', extensions: { code: 'INTERNAL_SERVER_ERROR' } }] });
            }
            return body.operationName === 'GetArticleIdsForPersona' ? HttpResponse.error() : undefined;
        }),
    );

    const graphql = (await failure(askAccount())) as { errors?: { extensions?: { ownServer?: boolean } }[] };
    const network = (await failure(askNews())) as { ownServer?: boolean };

    expect(graphql.errors?.[0]?.extensions?.ownServer).toBeUndefined();
    expect(network.ownServer).toBeUndefined();
});

it('mode on: the news query reaches the own server with only its key, no news operation reaches Mera, accounts stay on Mera', async () => {
    await signInFixtureAccount();
    const cookie = authClient.getCookie();
    expect(clientHeaderValue).toBeTruthy();
    await turnOnOwnNews();
    const rec = record();

    await askNews();
    await askAccount();

    const seen = await rec.settled();
    const own = seen.filter((s) => s.host === 'news.own.test');
    expect(own.map((s) => s.op)).toEqual(['GetArticleIdsForPersona']);
    expect(own[0].headers.get('x-api-key')).toBe(KEY);
    for (const h of ['cookie', 'authorization', 'x-mera-client']) expect(own[0].headers.get(h)).toBeNull();
    // Mera saw the account query and no news operation.
    const mera = seen.filter((s) => s.host !== 'news.own.test');
    expect(mera.map((s) => s.op)).toEqual(['GetUserBilling']);
    expect(mera.filter((s) => NEWS_OPERATIONS.has(s.op))).toHaveLength(0);
    expect(mera[0].headers.get('cookie')).toBe(cookie);
});

it('mode on: a caller-supplied header never reaches the own server', async () => {
    await turnOnOwnNews();
    const rec = record();

    await client.query({
        query: NEWS,
        variables: { query: { topics: [] } },
        context: { headers: { Authorization: 'Bearer leak', Cookie: 'session=leak' } },
        ...noCache,
    });

    const [own] = await rec.settled();
    expect(own.host).toBe('news.own.test');
    expect(own.headers.get('authorization')).toBeNull();
    expect(own.headers.get('cookie')).toBeNull();
});

describe('failures', () => {
    it('an own-server 401 leaves the auth breaker alone, and a Mera 401 still counts', async () => {
        await signInFixtureAccount();
        await turnOnOwnNews();
        server.use(ownAnswers('GetArticleIdsForPersona', () => new HttpResponse('no', { status: 401 })));

        const err = await failure(askNews());

        expect(err).toBeTruthy();
        expect(_getBreakerState().consecutiveFailures).toBe(0);
        expect(useOwnNewsHealth.getState().health).toBe('refused');

        server.use(
            http.post('*/graphql', async ({ request }) => {
                if (new URL(request.url).host === 'news.own.test') return undefined;
                const body = (await request.clone().json()) as { operationName?: string };
                return body.operationName === 'GetUserBilling' ? new HttpResponse('no session', { status: 401 }) : undefined;
            }),
        );
        expect(await failure(askAccount())).toBeTruthy();
        expect(_getBreakerState().consecutiveFailures).toBe(1);
    });

    it('a validation failure latches the operation, reaches the caller marked, and the client falls back without `order`', async () => {
        await turnOnOwnNews();
        const reject = () =>
            HttpResponse.json(
                { errors: [{ message: 'Unknown argument "order"', extensions: { code: 'GRAPHQL_VALIDATION_FAILED' } }] },
                { status: 400, headers: { 'content-type': 'application/graphql-response+json' } },
            );
        server.use(ownAnswers('GetArticlesForPublisher', reject));
        const rec = record();

        const err = (await failure(
            client.query({ query: PUBLISHER, variables: { newsPublisherId: 'p1', order: 'NEWEST' }, ...noCache }),
        )) as { errors?: { extensions?: { code?: string; ownServer?: boolean } }[] };
        expect(err.errors?.[0]?.extensions?.code).toBe('GRAPHQL_VALIDATION_FAILED');
        expect(err.errors?.[0]?.extensions?.ownServer).toBe(true);
        expect(isLatched('GetArticlesForPublisher')).toBe(true);

        const page = await ArticleService.getArticlesForPublisher('p1', { order: 'NEWEST' });
        expect(page.orderApplied).toBe(false);
        const own = (await rec.settled()).filter((s) => s.host === 'news.own.test').map((s) => s.op);
        expect(own).toContain('GetArticlesForPublisherNoOrder');
        // Nothing went to Mera, and the breaker never moved.
        expect((await rec.settled()).filter((s) => s.host !== 'news.own.test')).toHaveLength(0);
        expect(_getBreakerState().consecutiveFailures).toBe(0);
    });

    it('a network failure marks the error and reports the server unreachable, without touching Mera state', async () => {
        await turnOnOwnNews();
        server.use(http.post(OWN, () => HttpResponse.error()));

        const err = (await failure(askNews())) as { ownServer?: boolean };

        expect(err.ownServer).toBe(true);
        expect(useOwnNewsHealth.getState().health).toBe('unreachable');
        expect(_getBreakerState().consecutiveFailures).toBe(0);
    });

    it('a success reports ok', async () => {
        await turnOnOwnNews();
        await askNews();
        expect(useOwnNewsHealth.getState().health).toBe('ok');
    });

    it('a redirect from the own server is refused, not followed', async () => {
        await turnOnOwnNews();
        const rec = record();
        let followed = 0;
        server.use(
            http.all('https://elsewhere.test/graphql', () => {
                followed += 1;
                return HttpResponse.json({ data: {} });
            }),
            ownAnswers('GetArticleIdsForPersona', () => new HttpResponse(null, { status: 302, headers: { location: 'https://elsewhere.test/graphql' } })),
        );

        expect(await failure(askNews())).toBeTruthy();
        expect(followed).toBe(0);
        // Sent with redirect 'manual', and refused at once: a redirect is never retried.
        const own = (await rec.settled()).filter((x) => x.host === 'news.own.test');
        expect(own.map((x) => x.redirect)).toEqual(['manual']);
    });

    it('a slow own server never arms Mera\'s slow-server band', async () => {
        await turnOnOwnNews();
        const states: boolean[] = [];
        const stop = useNetworkStore.subscribe((x) => states.push(x.serverSlow));
        useFakeClock(Date.now());
        server.use(
            http.post(OWN, async () => {
                await delay(SLOW_REQUEST_MS + 2_000);
                return HttpResponse.json({ data: { articleIdsForPersona: { topicResults: [] } } });
            }),
        );
        await advanceUntilDone(askNews());
        stop();
        expect(states).not.toContain(true);
        expect(useNetworkStore.getState().serverSlow).toBe(false);
    });
});

describe('the cache', () => {
    it('a result cached from Mera is not served once the mode turns on, and an address change clears it again', async () => {
        await ownNewsState.hydrate();
        const cached = { query: NEWS, variables: { query: { topics: [] } }, fetchPolicy: 'cache-first' as const };
        const rec = record();

        await client.query(cached);
        await client.query(cached);
        expect((await rec.settled()).map((s) => s.host)).toHaveLength(1);

        await turnOnOwnNews();
        await client.query(cached);
        expect((await rec.settled()).map((s) => s.host)).toEqual([expect.not.stringMatching(/own\.test/), 'news.own.test']);
        await client.query(cached);
        expect(await rec.settled()).toHaveLength(2);

        await saveOwnNewsFields({ baseUrl: 'https://other.own.test', key: KEY });
        await recordOwnNewsCheck('connected', null);
        await setOwnNewsOn(true, { at: 1, privacyVersion: null });
        await client.query(cached);
        expect((await rec.settled()).map((s) => s.host).pop()).toBe('other.own.test');
    });
});

it('before hydrate, with the item stored: the news query waits and lands at the own server', async () => {
    await turnOnOwnNews();
    const stored = secureStoreDump()[OWN_NEWS_KEY];
    expect(stored).toBeTruthy();
    ownNewsState.resetMemory();
    expect(ownNewsState.isHydrated()).toBe(false);
    const rec = record();

    await askNews();

    const seen = await rec.settled();
    expect(seen.map((s) => s.host)).toEqual(['news.own.test']);
});
