// Turning an own service off, or wiping the device, puts every request back on Mera and leaves nothing of the own server behind.
import { gql } from '@apollo/client';
import client from '@/lib/apollo-client';
import { authClient } from '@/lib/auth-client';
import { cloudComplete } from '@/lib/llm/cloudComplete';
import { wipeAllLocalUserData } from '@/lib/security/local-wipe';
import { isLatched, latchUnsupported, useOwnNewsHealth } from '@/lib/own-services/news-latch';
import { OWN_AI_KEY, OWN_NEWS_KEY } from '@/lib/own-services/keys';
import { ownAiState, recordOwnAiCheck, saveOwnAiFields, setOwnAiOn } from '@/lib/own-services/own-ai-state';
import { ownNewsState, recordOwnNewsCheck, saveOwnNewsFields, setOwnNewsOn } from '@/lib/own-services/own-news-state';
import { reportSecrets } from '@/lib/own-services/report-secrets';
import { gatewayCalls, http, HttpResponse, server, signInFixtureAccount } from '@/test/helpers';
import { secureStoreDump } from '@/test/helpers/storage';
import { resetLinkState } from './apollo/link-chain/kit';
import { fakeClock, resetTransport, run } from '@/test/integration/chat/transport/transport-kit';

const AI_KEY = 'own-ai-key-12345678';
const NEWS_KEY = 'own-news-key-12345678';
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
const askNews = () => client.query({ query: NEWS, variables: { query: { topics: [] } } });

const turnOnAi = async (baseUrl = 'https://ai.own.test/v1') => {
    await saveOwnAiFields({ baseUrl, model: 'own-model', key: AI_KEY });
    await recordOwnAiCheck('connected');
    await setOwnAiOn(true, { at: 1, privacyVersion: null });
};
const turnOnNews = async () => {
    await saveOwnNewsFields({ baseUrl: 'https://news.own.test', key: NEWS_KEY });
    await recordOwnNewsCheck('connected', null);
    await setOwnNewsOn(true, { at: 1, privacyVersion: null });
};

/** Every GraphQL request by host, with its cookie. */
function watchGraphql() {
    const seen: { host: string; cookie: string | null }[] = [];
    const listener = ({ request }: { request: Request }) => {
        if (request.method === 'POST' && request.url.endsWith('/graphql')) {
            seen.push({ host: new URL(request.url).host, cookie: request.headers.get('cookie') });
        }
    };
    server.events.on('request:start', listener);
    return { seen, stop: () => server.events.removeListener('request:start', listener) };
}

let ownAi: string[];
let stopWatching: (() => void)[];
beforeEach(async () => {
    await resetTransport({ signIn: false });
    resetLinkState();
    ownAiState.resetMemory();
    ownNewsState.resetMemory();
    await client.clearStore();
    ownAi = [];
    stopWatching = [];
    const aiAnswer = ({ request }: { request: Request }) => {
        ownAi.push(request.url);
        return HttpResponse.json({ choices: [{ message: { content: 'own reply' } }] });
    };
    server.use(
        http.post('https://ai.own.test/*', aiAnswer),
        http.post('https://ai2.own.test/*', aiAnswer),
        http.post('https://news.own.test/graphql', () =>
            HttpResponse.json({ data: { articleIdsForPersona: { __typename: 'PersonaQueryResult', topicResults: [] } } }),
        ),
    );
});
afterEach(() => stopWatching.splice(0).forEach((stop) => stop()));

it('own AI off after on: the next call reaches the gateway, and a changed address does not reuse the old transport', async () => {
    await turnOnAi();
    expect(await cloudComplete({ systemPrompt: 's', prompt: 'u' })).toBe('own reply');
    expect(ownAi).toHaveLength(1);

    await setOwnAiOn(false);
    await signInFixtureAccount();
    fakeClock();
    await run(cloudComplete({ systemPrompt: 's', prompt: 'u' }));
    expect(gatewayCalls('chat')).toHaveLength(1);
    expect(ownAi).toHaveLength(1);

    await saveOwnAiFields({ baseUrl: 'https://ai2.own.test/v1', model: 'own-model', key: AI_KEY });
    await recordOwnAiCheck('connected');
    await setOwnAiOn(true, { at: 1, privacyVersion: null });
    await cloudComplete({ systemPrompt: 's', prompt: 'u' });
    expect(ownAi[1]).toBe('https://ai2.own.test/v1/chat/completions');
});

it('own news off after on: the cache is emptied, the latch is empty, and a news query reaches Mera with the cookie', async () => {
    await signInFixtureAccount();
    const cookie = authClient.getCookie();
    await turnOnNews();
    const watch = watchGraphql();
    stopWatching.push(watch.stop);
    await askNews();
    expect(watch.seen.map((s) => s.host)).toEqual(['news.own.test']);
    latchUnsupported('GetSomethingTheOwnServerLacks');
    expect(JSON.stringify(client.cache.extract())).toContain('articleIdsForPersona');

    await setOwnNewsOn(false);

    expect(isLatched('GetSomethingTheOwnServerLacks')).toBe(false);
    expect(client.cache.extract()).toEqual({});
    await askNews();
    expect(watch.seen.map((s) => s.host)).toEqual(['news.own.test', '127.0.0.1:8790']);
    expect(watch.seen[1].cookie).toBe(cookie);
});

it('a logout wipe with both modes on: both items and states are gone, news goes to Mera with the cookie, no report secrets remain', async () => {
    await signInFixtureAccount();
    await turnOnAi();
    await turnOnNews();
    expect(reportSecrets().secrets).toEqual(expect.arrayContaining([AI_KEY, NEWS_KEY]));
    expect(Object.keys(secureStoreDump())).toEqual(expect.arrayContaining([OWN_AI_KEY, OWN_NEWS_KEY]));

    await wipeAllLocalUserData();

    expect(Object.keys(secureStoreDump())).not.toEqual(expect.arrayContaining([OWN_AI_KEY]));
    expect(Object.keys(secureStoreDump())).not.toEqual(expect.arrayContaining([OWN_NEWS_KEY]));
    expect(ownAiState.isHydrated()).toBe(false);
    expect(ownNewsState.isHydrated()).toBe(false);
    expect(reportSecrets()).toEqual({ hosts: [], secrets: [] });

    await signInFixtureAccount();
    const watch = watchGraphql();
    stopWatching.push(watch.stop);
    await askNews();
    expect(watch.seen.map((s) => s.host)).toEqual(['127.0.0.1:8790']);
    expect(watch.seen[0].cookie).toBe(authClient.getCookie());
    expect(watch.seen[0].cookie).toBeTruthy();
});

it('own news off while its server is down: no unreachable state is left behind', async () => {
    await signInFixtureAccount();
    await turnOnNews();
    server.use(http.post('https://news.own.test/graphql', () => HttpResponse.error()));
    await askNews().catch(() => undefined);
    expect(useOwnNewsHealth.getState().health).toBe('unreachable');
    await setOwnNewsOn(false);
    expect(useOwnNewsHealth.getState().health).toBeNull();
});
