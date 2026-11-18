// While paired, news operations go to the paired server with the device token and nothing of Mera's; accounts stay on Mera.
import { gql } from '@apollo/client';
import { _getBreakerState } from '@/lib/auth-failure-breaker';
import { authClient } from '@/lib/auth-client';
import client from '@/lib/apollo-client';
import { clearLatch, useOwnNewsHealth } from '@/lib/own-services/news-latch';
import { ownNewsState, recordOwnNewsCheck, saveOwnNewsFields, setOwnNewsOn } from '@/lib/own-services/own-news-state';
import { resetPodHealth, usePodHealth } from '@/lib/own-services/pod-health';
import { forgetPairing, podState, savePairing, type PodPairing } from '@/lib/own-services/pod-state';
import { fakePod, http, HttpResponse, podPairing, POD_URL, server, signInFixtureAccount } from '@/test/helpers';
import { useNetworkStore } from '@/lib/stores/network-store';
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
const FACT_CHECK = gql`
    query GetFactCheck($articleId: ID!) {
        factCheck(articleId: $articleId) {
            __typename
        }
    }
`;

const TOKEN = 'pod-token-abcdef123456';
const pairing: PodPairing = podPairing({ token: TOKEN });
const NEWS_DATA = { articleIdsForPersona: { __typename: 'PersonaArticleIds', topicResults: [] } };
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
const cleanups: (() => void)[] = [];
/** Every GraphQL POST MSW receives, by host. */
function record() {
    const seen: Seen[] = [];
    const pending: Promise<unknown>[] = [];
    const listener = ({ request }: { request: Request }) => {
        if (request.method !== 'POST' || !request.url.endsWith('/graphql')) return;
        const entry: Seen = { host: new URL(request.url).host, op: '', headers: request.headers, redirect: request.redirect };
        seen.push(entry);
        pending.push(request.clone().json().then((b: { operationName?: string }) => { entry.op = b.operationName ?? ''; }).catch(() => undefined));
    };
    server.events.on('request:start', listener);
    cleanups.push(() => server.events.removeListener('request:start', listener));
    return { settled: async () => { await Promise.all(pending); return seen; } };
}

let pod: ReturnType<typeof fakePod>;
let logs: jest.SpyInstance[];
beforeEach(async () => {
    resetLinkState();
    ownNewsState.resetMemory();
    podState.resetMemory();
    clearLatch();
    useOwnNewsHealth.setState({ health: null });
    resetPodHealth();
    pod = fakePod({ token: TOKEN });
    pod.graphql.GetArticleIdsForPersona = NEWS_DATA;
    logs = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => jest.spyOn(console, m).mockImplementation(() => {}));
    await client.clearStore();
});
afterEach(() => {
    cleanups.splice(0).forEach((c) => c());
    logs.forEach((s) => s.mockRestore());
});

it('not paired: news and account operations both reach Mera with the cookie and the paired server gets nothing', async () => {
    await signInFixtureAccount();
    const rec = record();
    await askNews();
    await askAccount();
    const seen = await rec.settled();
    expect(seen.map((s) => s.op).sort()).toEqual(['GetArticleIdsForPersona', 'GetUserBilling']);
    expect(seen.filter((s) => s.host === 'pod.own.test')).toHaveLength(0);
    for (const s of seen) expect(s.headers.get('cookie')).toBe(authClient.getCookie());
});

it('paired: the news query reaches the paired server with the bearer and nothing of Mera, accounts stay on Mera', async () => {
    await signInFixtureAccount();
    const cookie = authClient.getCookie();
    await savePairing(pairing);
    const rec = record();
    await askNews();
    await askAccount();
    const seen = await rec.settled();
    const own = seen.filter((s) => s.host === 'pod.own.test');
    expect(own.map((s) => s.op)).toEqual(['GetArticleIdsForPersona']);
    expect(own[0].headers.get('authorization')).toBe(`Bearer ${TOKEN}`);
    for (const h of ['cookie', 'x-api-key', 'x-mera-client']) expect(own[0].headers.get(h)).toBeNull();
    const mera = seen.filter((s) => s.host !== 'pod.own.test');
    expect(mera.map((s) => s.op)).toEqual(['GetUserBilling']);
    expect(mera[0].headers.get('cookie')).toBe(cookie);
    expect(usePodHealth.getState().health).toBe('ok');
});

it('paired: a caller-supplied header never reaches the paired server', async () => {
    await savePairing(pairing);
    const rec = record();
    await client.query({ query: NEWS, variables: { query: { topics: [] } }, context: { headers: { Authorization: 'Bearer leak', Cookie: 'session=leak' } }, ...noCache });
    const [own] = await rec.settled();
    expect(own.headers.get('authorization')).toBe(`Bearer ${TOKEN}`);
    expect(own.headers.get('cookie')).toBeNull();
});

it('pairing wins over an own news server that is also on', async () => {
    await saveOwnNewsFields({ baseUrl: 'https://news.own.test', key: 'own-news-key-12345678' });
    await recordOwnNewsCheck('connected', null);
    await setOwnNewsOn(true, { at: 1, privacyVersion: null });
    await savePairing(pairing);
    const rec = record();
    await askNews();
    expect((await rec.settled()).map((s) => s.host)).toEqual(['pod.own.test']);
});

it('paired: GetFactCheck reaches neither host and answers NOT_OFFERED', async () => {
    await signInFixtureAccount();
    await savePairing(pairing);
    const rec = record();
    const err = (await failure(client.query({ query: FACT_CHECK, variables: { articleId: 'a1' }, ...noCache }))) as { errors?: { extensions?: Record<string, unknown> }[] };
    expect(err.errors?.[0]?.extensions?.code).toBe('NOT_OFFERED');
    expect(await rec.settled()).toHaveLength(0);
});

it('before hydrate, with the item stored: the news query waits and lands at the paired server', async () => {
    await savePairing(pairing);
    podState.resetMemory();
    const rec = record();
    await askNews();
    expect((await rec.settled()).map((s) => s.host)).toEqual(['pod.own.test']);
});

describe('failures', () => {
    it('a paired 401 marks the server refused and leaves Mera\'s breaker, slow band and reachability alone; a Mera 401 still counts', async () => {
        await signInFixtureAccount();
        await savePairing(pairing);
        pod.answer('/graphql', 401);
        const reachableBefore = useNetworkStore.getState();
        expect(await failure(askNews())).toBeTruthy();
        expect(usePodHealth.getState().health).toBe('refused');
        expect(_getBreakerState().consecutiveFailures).toBe(0);
        expect(useNetworkStore.getState().serverSlow).toBe(reachableBefore.serverSlow);
        expect(useNetworkStore.getState().serverReachable ?? true).toBe(reachableBefore.serverReachable ?? true);

        server.use(
            http.post('*/graphql', async ({ request }) => {
                if (new URL(request.url).host === 'pod.own.test') return undefined;
                const body = (await request.clone().json()) as { operationName?: string };
                return body.operationName === 'GetUserBilling' ? new HttpResponse('no session', { status: 401 }) : undefined;
            }),
        );
        expect(await failure(askAccount())).toBeTruthy();
        expect(_getBreakerState().consecutiveFailures).toBe(1);
    });

    it('a redirect is refused once, never retried, and the token goes to no other host', async () => {
        await savePairing(pairing);
        const rec = record();
        let elsewhere = 0;
        server.use(
            http.all('https://elsewhere.test/*', () => { elsewhere += 1; return HttpResponse.json({ data: {} }); }),
            http.post(`${POD_URL}/graphql`, () => new HttpResponse(null, { status: 302, headers: { location: 'https://elsewhere.test/graphql' } })),
        );
        expect(await failure(askNews())).toBeTruthy();
        expect(elsewhere).toBe(0);
        const own = (await rec.settled()).filter((s) => s.host === 'pod.own.test');
        expect(own.map((s) => s.redirect)).toEqual(['manual']);
    });

    it('a failure leaves neither the token nor the address in the thrown error, its fields or any log line', async () => {
        await savePairing(pairing);
        server.use(http.post(`${POD_URL}/graphql`, () => new HttpResponse('no', { status: 401 })));
        const err = (await failure(askNews())) as Error;
        const text = JSON.stringify({ ...err, message: err.message, response: undefined }) + logs.flatMap((s) => s.mock.calls).map((c) => JSON.stringify(c)).join('\n');
        expect(text).not.toContain(TOKEN);
        expect(text).not.toContain('pod.own.test');
    });
});

describe('the cache', () => {
    const cached = { query: NEWS, variables: { query: { topics: [] } }, fetchPolicy: 'cache-first' as const };

    it('a result cached from Mera is not served after pairing, and unpairing puts Mera back at once', async () => {
        await podState.hydrate();
        const rec = record();
        await client.query(cached);
        await client.query(cached);
        expect(await rec.settled()).toHaveLength(1);

        await savePairing(pairing);
        await client.query(cached);
        expect((await rec.settled()).map((s) => s.host)).toEqual([expect.not.stringMatching(/own\.test/), 'pod.own.test']);

        await forgetPairing();
        await client.query(cached);
        expect((await rec.settled()).map((s) => s.host).pop()).not.toBe('pod.own.test');
        expect(await rec.settled()).toHaveLength(3);
    });

    it('switching from an own news server to paired clears the cache', async () => {
        await saveOwnNewsFields({ baseUrl: 'https://news.own.test', key: 'own-news-key-12345678' });
        await recordOwnNewsCheck('connected', null);
        await setOwnNewsOn(true, { at: 1, privacyVersion: null });
        const rec = record();
        await client.query(cached);
        await savePairing(pairing);
        await client.query(cached);
        expect((await rec.settled()).map((s) => s.host)).toEqual(['news.own.test', 'pod.own.test']);
    });
});
