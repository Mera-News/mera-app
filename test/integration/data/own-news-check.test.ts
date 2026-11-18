// The connection check talks to the server directly: one case per status.
import { checkOwnNews } from '@/lib/own-services/check-news';
import { http, HttpResponse, server } from '@/test/helpers';

const URL = 'https://news.own.test/graphql';
const KEY = 'own-news-key-12345678';
const FEED = ['articleIdsForPersona', 'articlesForTopicsByIds'];
const check = () => checkOwnNews({ baseUrl: 'https://news.own.test', key: KEY });

const introspection = (names: string[]) => HttpResponse.json({ data: { __type: { fields: names.map((name) => ({ name })) } } });
const validationFailure = () =>
    HttpResponse.json(
        { errors: [{ message: 'Cannot query field', extensions: { code: 'GRAPHQL_VALIDATION_FAILED' } }] },
        { status: 400, headers: { 'content-type': 'application/graphql-response+json' } },
    );
const personaAnswer = () => HttpResponse.json({ data: { articleIdsForPersona: { topicResults: [], headlineResults: [] } } });

/** Answers by operation shape: the introspection query, then the persona document. */
function serve(on: { introspection?: () => Response; persona?: () => Response }) {
    const calls: { body: { query?: string; operationName?: string; variables?: unknown }; headers: Headers; redirect: string }[] = [];
    server.use(
        http.post(URL, async ({ request }) => {
            const body = (await request.clone().json()) as { query?: string; operationName?: string };
            calls.push({ body, headers: request.headers, redirect: request.redirect });
            if (body.query?.includes('__type')) return (on.introspection ?? (() => introspection(FEED)))();
            return (on.persona ?? personaAnswer)();
        }),
    );
    return calls;
}

it('connected: the feed fields are listed, and the request carries only the key', async () => {
    const calls = serve({ introspection: () => introspection([...FEED, 'searchNews']) });

    expect(await check()).toEqual({ status: 'connected', fields: [...FEED, 'searchNews'] });

    expect(calls).toHaveLength(1);
    expect(calls[0].headers.get('x-api-key')).toBe(KEY);
    expect(calls[0].headers.get('cookie')).toBeNull();
    expect(calls[0].redirect).toBe('manual');
});

it('no-feed: a feed field is missing', async () => {
    serve({ introspection: () => introspection(['articleIdsForPersona', 'searchNews']) });
    expect(await check()).toEqual({ status: 'no-feed', fields: ['articleIdsForPersona', 'searchNews'] });
});

it('introspection refused falls back to the persona document with no topic, fields null', async () => {
    const calls = serve({ introspection: validationFailure });

    expect(await check()).toEqual({ status: 'connected', fields: null });

    expect(calls).toHaveLength(2);
    expect(calls[1].body.operationName).toBe('GetArticleIdsForPersona');
    expect(calls[1].body.variables).toEqual({ query: { topics: [] } });
});

it('introspection with an empty field list falls back the same way', async () => {
    const calls = serve({ introspection: () => introspection([]) });
    expect(await check()).toEqual({ status: 'connected', fields: null });
    expect(calls).toHaveLength(2);
});

it('no-feed: the fallback document fails validation', async () => {
    serve({ introspection: validationFailure, persona: validationFailure });
    expect(await check()).toEqual({ status: 'no-feed', fields: null });
});

it.each([401, 403])('refused: HTTP %i', async (status) => {
    server.use(http.post(URL, () => new HttpResponse('no', { status })));
    expect(await check()).toEqual({ status: 'refused', fields: null });
});

it('refused: the fallback is refused after introspection was', async () => {
    serve({ introspection: validationFailure, persona: () => new HttpResponse('no', { status: 401 }) });
    expect(await check()).toEqual({ status: 'refused', fields: null });
});

it('unreachable: a network failure', async () => {
    server.use(http.post(URL, () => HttpResponse.error()));
    expect(await check()).toEqual({ status: 'unreachable', fields: null });
});

it('unreachable: the server errors on both steps', async () => {
    server.use(http.post(URL, () => new HttpResponse('boom', { status: 502 })));
    expect(await check()).toEqual({ status: 'unreachable', fields: null });
});

it('no-feed: the address answers 404, like a site that is not a news server', async () => {
    server.use(http.post(URL, () => new HttpResponse('not found', { status: 404 })));
    expect(await check()).toEqual({ status: 'no-feed', fields: null });
});

it('redirect: a 302 is reported, not followed', async () => {
    let followed = 0;
    server.use(
        http.all('https://elsewhere.test/graphql', () => {
            followed += 1;
            return HttpResponse.json({ data: {} });
        }),
        http.post(URL, () => new HttpResponse(null, { status: 302, headers: { location: 'https://elsewhere.test/graphql' } })),
    );

    expect(await check()).toEqual({ status: 'redirect', fields: null });
    expect(followed).toBe(0);
});

it('an address already ending in /graphql is used as given', async () => {
    const calls = serve({});
    await checkOwnNews({ baseUrl: 'https://news.own.test/graphql', key: null });
    expect(calls).toHaveLength(1);
    expect(calls[0].headers.get('x-api-key')).toBeNull();
});
