import { graphqlUrlFor, type NewsCheckStatus } from './own-news-state';

const FEED_FIELDS = ['articleIdsForPersona', 'articlesForTopicsByIds'];
const TIMEOUT_MS = 15_000;
const INTROSPECTION = '{ __type(name: "Query") { fields { name } } }';
// The client's feed document with an empty topic list: it validates the persona query and sends no topic.
const PERSONA = `query GetArticleIdsForPersona($query: PersonaQueryInput!) {
  articleIdsForPersona(query: $query) { topicResults { topicText articleIds } headlineResults { scope countryCode articleIds } }
}`;

type Reply = { kind: 'net' } | { kind: 'redirect' } | { kind: 'http'; status: number; json: any };

// Direct fetch, never Apollo, so a check cannot touch the cache or the Mera chain.
async function post(url: string, key: string | null, body: object): Promise<Reply> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
        const res = await fetch(url, {
            method: 'POST',
            redirect: 'manual',
            credentials: 'omit',
            signal: controller.signal,
            headers: { 'content-type': 'application/json', ...(key ? { 'x-api-key': key } : {}) },
            body: JSON.stringify(body),
        });
        if (res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400)) return { kind: 'redirect' };
        const json = await res.json().catch(() => null);
        return { kind: 'http', status: res.status, json };
    } catch {
        return { kind: 'net' };
    } finally {
        clearTimeout(timer);
    }
}

const refused = (r: Reply) => r.kind === 'http' && (r.status === 401 || r.status === 403);
const validationFailed = (r: Reply) =>
    r.kind === 'http' &&
    (r.status === 400 || r.json?.errors?.some?.((e: { extensions?: { code?: string } }) => e.extensions?.code === 'GRAPHQL_VALIDATION_FAILED'));

export async function checkOwnNews(args: {
    baseUrl: string;
    key: string | null;
}): Promise<{ status: NewsCheckStatus; fields: string[] | null }> {
    const url = graphqlUrlFor(args.baseUrl);
    const out = (status: NewsCheckStatus, fields: string[] | null = null) => ({ status, fields });

    const first = await post(url, args.key, { query: INTROSPECTION });
    if (first.kind === 'net') return out('unreachable');
    if (first.kind === 'redirect') return out('redirect');
    if (refused(first)) return out('refused');
    const listed: unknown = first.status < 300 ? first.json?.data?.__type?.fields : null;
    if (Array.isArray(listed) && listed.length > 0) {
        const fields = listed.map((f: { name: string }) => f.name);
        return out(FEED_FIELDS.every((f) => fields.includes(f)) ? 'connected' : 'no-feed', fields);
    }

    // Introspection is often off in production: the feed document itself says whether the feed works.
    const second = await post(url, args.key, {
        operationName: 'GetArticleIdsForPersona',
        query: PERSONA,
        variables: { query: { topics: [] } },
    });
    if (second.kind === 'net') return out('unreachable');
    if (second.kind === 'redirect') return out('redirect');
    if (refused(second)) return out('refused');
    if (validationFailed(second)) return out('no-feed');
    if (second.kind === 'http' && second.status >= 500) return out('unreachable');
    // It answered, but not as a news server (a 404 or another refusal): it cannot make a feed.
    if (second.kind === 'http' && second.status >= 300) return out('no-feed');
    return out('connected');
}
