// The web-search client end to end: the real client, the real interactive limiter and the real
// auth client against the gateway mock's plaintext `/v1/web-search` route. Time is the strict
// fake clock, so "one grant", "one second apart" and "gave up at the deadline" are read off the
// request start times instead of off spies.
import * as auth from '@/lib/auth-client';
import {
  interactiveWaitMs,
  acquire,
  MIN_INTERACTIVE_INTERVAL_MS,
  msUntilNextGrant,
} from '@/lib/llm/gateway-rate-limiter';
import {
  MAX_BATCH_QUERIES,
  MAX_QUERY_CHARS,
  MIN_QUERY_CHARS,
  SEARCH_UNAVAILABLE,
  searchWeb,
  searchWebBatch,
} from '@/lib/web-search/web-search-client';
import {
  advanceUntilDone,
  delay,
  gatewayCalls,
  http,
  HttpResponse,
  mockGateway,
  server,
  signInFixtureAccount,
  type GatewayReply,
} from '@/test/helpers';
import { resetChatModules, useStrictClock } from '@/test/integration/chat/_helpers';

jest.setTimeout(30_000);

type Hit = { title: string; url: string; snippet: string };
const hit = (over: Partial<Hit> = {}): Hit => ({ title: 'T', url: 'https://e.com/a', snippet: 'S', ...over });
const hits = (...h: Hit[]): string => JSON.stringify(h);

/** Scripts the search route: `reply` answers every query (a JSON string or a raw `{ status }`). */
function serveSearch(reply: GatewayReply | ((query: string) => GatewayReply)): void {
  server.use(
    ...mockGateway((call) => {
      if (call.route !== 'web-search') return 'unexpected';
      const query = call.messages[0].content;
      return typeof reply === 'function' ? reply(query) : reply;
    }),
  );
}

/** Every HTTP request that reached the search route: its fake-clock start and its raw body. */
function watchSearch() {
  const seen: { at: number; auth: string | null; body: Promise<string> }[] = [];
  server.events.on('request:start', ({ request }) => {
    if (new URL(request.url).pathname.endsWith('/v1/web-search')) {
      seen.push({ at: Date.now(), auth: request.headers.get('authorization'), body: request.clone().text() });
    }
  });
  return {
    count: () => seen.length,
    starts: () => seen.map((s) => s.at),
    auth: () => seen.map((s) => s.auth),
    bodies: async () => (await Promise.all(seen.map((s) => s.body))).map((b) => JSON.parse(b)),
  };
}

/** Drives a call to completion under the strict fake clock and reports how long it took. */
async function timed<T>(call: Promise<T>): Promise<{ value: T; t0: number; elapsed: number }> {
  const t0 = Date.now();
  const value = await advanceUntilDone(call, 120_000, 50);
  return { value, t0, elapsed: Date.now() - t0 };
}

/** The 400 a gateway that predates batching answers, then the normal route for single queries. */
function rejectBatchShape(): void {
  server.use(
    http.post('*/v1/web-search', async ({ request }) => {
      const body = (await request.clone().json()) as { queries?: unknown };
      if (Array.isArray(body.queries)) return HttpResponse.json({}, { status: 400 });
      return undefined; // falls through to the gateway mock for the single-query shape
    }),
  );
}

/** Slack over a fake-time bound: the driver steps 50ms and takes real turns between steps. */
const SLACK_MS = 250;

// The sign-in runs on real timers; the strict clock starts after it. The no-session suites turn it off.
let signedIn = true;
const withoutSession = () => {
  beforeAll(() => {
    signedIn = false;
  });
  afterAll(() => {
    signedIn = true;
  });
};

beforeEach(async () => {
  resetChatModules();
  if (signedIn) await signInFixtureAccount();
  useStrictClock(Date.now());
});
afterEach(() => {
  server.events.removeAllListeners();
  resetChatModules();
});

describe('searchWeb: the request', () => {
  it('POSTs ONLY the query to the search route, bearing the session JWT', async () => {
    serveSearch(hits(hit()));
    const requests = watchSearch();

    const { value } = await timed(searchWeb('  election results  '));

    expect(requests.count()).toBe(1);
    expect(await requests.bodies()).toEqual([{ query: 'election results' }]);
    expect(requests.auth()).toEqual([`Bearer ${await auth.getJwtToken()}`]);
    expect(gatewayCalls('web-search')).toHaveLength(1);
    expect(value).toEqual({ ok: true, results: [hit()] });
  });

  it('an empty array behind a 200 is a real zero-hit answer, not a failure', async () => {
    serveSearch('[]');
    expect((await timed(searchWeb('anything'))).value).toEqual({ ok: true, results: [] });
  });

  it('drops malformed hits and defaults a missing snippet', async () => {
    serveSearch(
      JSON.stringify([
        { title: 'ok', url: 'u1' },
        { title: 'no url' },
        null,
        'nonsense',
        { url: 'no title' },
      ]),
    );
    expect((await timed(searchWeb('anything'))).value).toEqual({
      ok: true,
      results: [{ title: 'ok', url: 'u1', snippet: '' }],
    });
  });

  it('a 200 body with no results key at all is zero hits', async () => {
    server.use(http.post('*/v1/web-search', () => HttpResponse.json({})));
    expect((await timed(searchWeb('anything'))).value).toEqual({ ok: true, results: [] });
  });
});

describe('searchWeb: queries refused locally', () => {
  it.each([
    ['empty', ''],
    ['blank', ' '],
    ['below the minimum', 'a'],
    ['above the maximum', 'z'.repeat(MAX_QUERY_CHARS + 1)],
  ])('refuses a query that is %s with a 400 and no request', async (_why, query) => {
    const requests = watchSearch();
    const { value } = await timed(searchWeb(query));

    expect(value).toMatchObject({ ok: false, status: 400 });
    expect(requests.count()).toBe(0);
  });

  it('accepts a query of exactly the minimum and the maximum length', async () => {
    serveSearch('[]');
    const requests = watchSearch();
    expect((await timed(searchWeb('a'.repeat(MIN_QUERY_CHARS)))).value.ok).toBe(true);
    expect((await timed(searchWeb('b'.repeat(MAX_QUERY_CHARS)))).value.ok).toBe(true);
    expect(requests.count()).toBe(2);
  });

  it('a null or undefined query is too short, with no request', async () => {
    const requests = watchSearch();
    for (const q of [null, undefined]) {
      expect((await timed(searchWeb(q as unknown as string))).value.ok).toBe(false);
    }
    expect(requests.count()).toBe(0);
  });

  it('a refused query spends no limiter grant: the next interactive caller is granted at once', async () => {
    await timed(searchWeb('a'));
    const t0 = Date.now();
    await advanceUntilDone(acquire('interactive'));
    expect(Date.now() - t0).toBeLessThan(SLACK_MS);
  });
});

describe('searchWeb: failures never throw and never read as "found nothing"', () => {
  it('a 503 search-unavailable carries the code, the status and the do-not-say-nothing instruction', async () => {
    serveSearch({ status: 503, body: { code: 'search-unavailable', reason: 'disabled', message: 'off' } });

    const { value } = await timed(searchWeb('anything'));

    expect(value).toMatchObject({ ok: false, code: SEARCH_UNAVAILABLE, status: 503 });
    // The prose is what the MODEL reads: it must forbid the exact wrong conclusion.
    expect((value as { error: string }).error).toContain('NOTHING was searched');
  });

  it('a body-less 503 (Cloud Run itself) reaches the same conclusion', async () => {
    serveSearch({ status: 503 });
    expect((await timed(searchWeb('anything'))).value).toMatchObject({ ok: false, code: SEARCH_UNAVAILABLE });
  });

  it('a 404 (the gateway predates the route) is unavailable too, in the same words as a 503', async () => {
    serveSearch({ status: 404 });
    const { value } = await timed(searchWeb('anything'));
    expect(value).toMatchObject({ ok: false, code: SEARCH_UNAVAILABLE, status: 404 });
    expect((value as { error: string }).error).toContain('NOTHING was searched');
  });

  it('a 502 is a provider failure on a search that was made: no unavailable code', async () => {
    serveSearch({ status: 502 });
    const { value } = await timed(searchWeb('anything'));
    expect(value).toMatchObject({ ok: false, status: 502 });
    expect((value as { code?: string }).code).toBeUndefined();
  });

  it.each([
    [400, 'between 2 and 200 characters'],
    [401, 'not authenticated'],
    [418, 'HTTP 418'],
  ])('maps a %i response to a failure that names its cause', async (status, words) => {
    serveSearch({ status });
    const { value } = await timed(searchWeb('anything'));
    expect(value).toMatchObject({ ok: false, status });
    expect((value as { error: string }).error).toContain(words);
  });

  it('a 429 is unavailable and holds the shared limiter back for 30 seconds', async () => {
    serveSearch({ status: 429 });

    const { value } = await timed(searchWeb('anything'));

    expect(value).toMatchObject({ ok: false, status: 429, code: SEARCH_UNAVAILABLE });
    // The background lane honours the pause in full; the interactive lane is capped by the limiter.
    expect(msUntilNextGrant()).toBeGreaterThan(28_000);
    expect(msUntilNextGrant()).toBeLessThanOrEqual(30_000);
    expect(interactiveWaitMs()).toBeLessThanOrEqual(2000);
  });

  it('control: a 200 leaves the limiter at its ordinary spacing', async () => {
    serveSearch('[]');
    await timed(searchWeb('anything'));
    expect(msUntilNextGrant()).toBeLessThanOrEqual(MIN_INTERACTIVE_INTERVAL_MS);
  });

  it('a network error is "could not be reached", not a throw', async () => {
    server.use(http.post('*/v1/web-search', () => HttpResponse.error()));
    const { value } = await timed(searchWeb('anything'));
    expect(value).toMatchObject({ ok: false, code: SEARCH_UNAVAILABLE });
    expect((value as { status?: number }).status).toBeUndefined();
  });

  it('a 200 whose body is not JSON is a failure, not a throw', async () => {
    server.use(http.post('*/v1/web-search', () => new HttpResponse('<html>not json</html>', { status: 200 })));
    expect((await timed(searchWeb('anything'))).value).toMatchObject({ ok: false, code: SEARCH_UNAVAILABLE });
  });
});

describe('searchWeb: no session', () => {
  withoutSession();

  it('sends nothing without a session, and spends no grant', async () => {
    const requests = watchSearch();

    const { value } = await timed(searchWeb('anything'));

    expect(value).toMatchObject({ ok: false, status: 401 });
    expect(requests.count()).toBe(0);
    const t0 = Date.now();
    await advanceUntilDone(acquire('interactive'));
    expect(Date.now() - t0).toBeLessThan(SLACK_MS);
  });

  it('sends nothing when the token lookup throws', async () => {
    await signInFixtureAccount();
    const spy = jest.spyOn(auth, 'getJwtToken').mockRejectedValueOnce(new Error('keychain locked'));
    const requests = watchSearch();
    try {
      expect((await timed(searchWeb('anything'))).value).toMatchObject({ ok: false, status: 401 });
      expect(requests.count()).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('searchWeb: metering and the deadline', () => {
  it('takes its limiter grant BEFORE the request: the first search starts at once, the next a second later', async () => {
    serveSearch('[]');
    const requests = watchSearch();

    const t0 = Date.now();
    await advanceUntilDone(searchWeb('first query'));
    await advanceUntilDone(searchWeb('second query'));

    const [a, b] = requests.starts();
    expect(a - t0).toBeLessThan(SLACK_MS);
    expect(b - a).toBeGreaterThanOrEqual(MIN_INTERACTIVE_INTERVAL_MS);
    expect(b - a).toBeLessThan(MIN_INTERACTIVE_INTERVAL_MS + SLACK_MS);
  });

  it('gives up without a request when the limiter queue outlasts the 12s deadline', async () => {
    serveSearch(hits(hit()));
    // Twenty interactive callers ahead: the search would be granted after ~20s.
    for (let i = 0; i < 20; i += 1) void acquire('interactive');
    const requests = watchSearch();

    const { value, elapsed } = await timed(searchWeb('anything'));

    expect(value).toMatchObject({ ok: false, code: SEARCH_UNAVAILABLE });
    expect(requests.count()).toBe(0);
    expect(elapsed).toBeGreaterThanOrEqual(12_000);
    expect(elapsed).toBeLessThan(12_000 + SLACK_MS);
  });

  it('aborts a hung request at the deadline and reports a failure', async () => {
    let aborted = false;
    server.use(
      http.post('*/v1/web-search', async ({ request }) => {
        request.signal.addEventListener('abort', () => {
          aborted = true;
        });
        await delay('infinite');
        return undefined;
      }),
    );

    const { value, elapsed } = await timed(searchWeb('a hung query'));

    expect(value).toMatchObject({ ok: false, code: SEARCH_UNAVAILABLE });
    expect(elapsed).toBeGreaterThanOrEqual(12_000);
    expect(elapsed).toBeLessThan(12_000 + SLACK_MS);
    expect(aborted).toBe(true);
  });
});

describe('searchWebBatch: the request', () => {
  it('sends ONE request carrying a queries array, after ONE grant; the gateway fans it out', async () => {
    serveSearch((q) => hits(hit({ title: q })));
    const requests = watchSearch();

    const { value, t0 } = await timed(searchWebBatch(['aa', 'bb', 'cc']));

    expect(requests.count()).toBe(1);
    expect(await requests.bodies()).toEqual([{ queries: ['aa', 'bb', 'cc'] }]);
    // One grant: three would have put the first request two seconds out.
    expect(requests.starts()[0] - t0).toBeLessThan(SLACK_MS);
    expect(gatewayCalls('web-search').map((c) => c.messages[0].content)).toEqual(['aa', 'bb', 'cc']);
    expect(value).toEqual({
      ok: true,
      searches: ['aa', 'bb', 'cc'].map((q) => ({ query: q, results: [hit({ title: q })] })),
    });
    expect(requests.auth()).toEqual([`Bearer ${await auth.getJwtToken()}`]);
  });

  it('sends nothing but the queries', async () => {
    serveSearch('[]');
    const requests = watchSearch();
    await timed(searchWebBatch(['first query', 'second query']));
    const [body] = await requests.bodies();
    expect(Object.keys(body)).toEqual(['queries']);
  });

  it('a lone query goes out in the single shape, so an old gateway still answers', async () => {
    serveSearch(hits(hit({ url: 'https://u.test' })));
    const requests = watchSearch();

    const { value } = await timed(searchWebBatch(['only one']));

    expect(await requests.bodies()).toEqual([{ query: 'only one' }]);
    expect(value).toEqual({
      ok: true,
      searches: [{ query: 'only one', results: [hit({ url: 'https://u.test' })] }],
    });
  });

  it('trims, drops blanks, dedupes and caps at MAX_BATCH_QUERIES', async () => {
    serveSearch('[]');
    const requests = watchSearch();

    await timed(searchWebBatch(['  aa  ', 'aa', '', '   ', 'bb', 'cc', 'dd', 'ee', 'ff']));

    const [body] = await requests.bodies();
    expect(body.queries).toEqual(['aa', 'bb', 'cc', 'dd']);
    expect(body.queries).toHaveLength(MAX_BATCH_QUERIES);
  });

  it('refuses an out-of-bounds query per entry without failing the batch', async () => {
    serveSearch((q) => hits(hit({ title: q })));
    const requests = watchSearch();

    const { value } = await timed(
      searchWebBatch(['x'.repeat(MAX_QUERY_CHARS + 1), 'y'.repeat(MIN_QUERY_CHARS - 1), 'fine query']),
    );

    // Only the fine query reaches the wire, in the single shape.
    expect(await requests.bodies()).toEqual([{ query: 'fine query' }]);
    const searches = (value as { searches: { query: string; error?: string; results?: unknown }[] }).searches;
    expect(searches).toHaveLength(3);
    expect(searches.filter((s) => s.error)).toHaveLength(2);
    expect(searches.find((s) => s.query === 'fine query')?.results).toEqual([hit({ title: 'fine query' })]);
  });

  it('only out-of-bounds queries: each is an error entry and nothing is sent', async () => {
    const requests = watchSearch();
    const { value } = await timed(searchWebBatch(['y', 'x'.repeat(MAX_QUERY_CHARS + 1)]));
    expect(requests.count()).toBe(0);
    expect((value as { ok: boolean; searches: { error?: string }[] }).searches.every((s) => !!s.error)).toBe(true);
  });

  it('an empty list is a 400 with no request', async () => {
    const requests = watchSearch();
    expect((await timed(searchWebBatch([]))).value).toMatchObject({ ok: false, status: 400 });
    expect(requests.count()).toBe(0);
  });
});

describe('searchWebBatch: per-query verdicts and whole-batch failures', () => {
  it('a per-query search-unavailable becomes an error entry, never an empty result', async () => {
    serveSearch((q) => (q === 'bb' ? JSON.stringify({ code: SEARCH_UNAVAILABLE, reason: 'upstream-rate-limited' }) : hits(hit())));

    const { value } = await timed(searchWebBatch(['aa', 'bb']));
    const searches = (value as { searches: { query: string; results?: unknown[]; error?: string; code?: string }[] }).searches;

    expect(searches[0].results).toHaveLength(1);
    expect(searches[1].results).toBeUndefined();
    expect(searches[1]).toMatchObject({ query: 'bb', code: SEARCH_UNAVAILABLE });
    expect(searches[1].error).toContain('NOTHING was searched');
  });

  it('skips entries that are not objects or carry no query', async () => {
    server.use(
      http.post('*/v1/web-search', () =>
        HttpResponse.json({ searches: [null, 'x', { results: [] }, { query: 'aa', results: [hit()] }] }),
      ),
    );
    expect((await timed(searchWebBatch(['aa', 'bb']))).value).toEqual({
      ok: true,
      searches: [{ query: 'aa', results: [hit()] }],
    });
  });

  it('a 503 is a whole-batch "we did not search", never an empty set', async () => {
    serveSearch({ status: 503, body: { code: SEARCH_UNAVAILABLE } });
    const { value } = await timed(searchWebBatch(['aa', 'bb']));
    expect(value).toMatchObject({ ok: false, code: SEARCH_UNAVAILABLE, status: 503 });
    expect((value as { searches?: unknown }).searches).toBeUndefined();
  });

  it('a 404 fails once and does NOT fall back: the route itself is gone', async () => {
    serveSearch({ status: 404 });
    const requests = watchSearch();

    const { value } = await timed(searchWebBatch(['aa', 'bb']));

    expect(requests.count()).toBe(1);
    expect(value).toMatchObject({ ok: false, status: 404, code: SEARCH_UNAVAILABLE });
  });

  it('a 429 holds the shared limiter back for 30 seconds', async () => {
    serveSearch({ status: 429 });
    const { value } = await timed(searchWebBatch(['aa', 'bb']));
    expect(value).toMatchObject({ ok: false, status: 429, code: SEARCH_UNAVAILABLE });
    expect(msUntilNextGrant()).toBeGreaterThan(28_000);
  });

  it('a network error is a failure carrying the unavailable code, not a throw', async () => {
    server.use(http.post('*/v1/web-search', () => HttpResponse.error()));
    expect((await timed(searchWebBatch(['aa', 'bb']))).value).toMatchObject({ ok: false, code: SEARCH_UNAVAILABLE });
  });

  it('aborts a hung batch at the longer 18s deadline', async () => {
    server.use(
      http.post('*/v1/web-search', async () => {
        await delay('infinite');
        return undefined;
      }),
    );
    const { value, elapsed } = await timed(searchWebBatch(['aa', 'bb']));
    expect(value).toMatchObject({ ok: false, code: SEARCH_UNAVAILABLE });
    expect(elapsed).toBeGreaterThanOrEqual(18_000);
    expect(elapsed).toBeLessThan(18_000 + SLACK_MS);
  });
});

describe('searchWebBatch: no session', () => {
  withoutSession();

  it('sends nothing without a session', async () => {
    const requests = watchSearch();

    expect((await timed(searchWebBatch(['aa', 'bb']))).value).toMatchObject({ ok: false, status: 401 });
    expect(requests.count()).toBe(0);
  });
});

describe('searchWebBatch: a gateway that predates batching', () => {
  it('a 400 falls back to one request per query, each metered a second apart', async () => {
    serveSearch((q) => hits(hit({ title: q })));
    rejectBatchShape();
    const requests = watchSearch();

    const { value, t0 } = await timed(searchWebBatch(['aa', 'bb']));

    expect(await requests.bodies()).toEqual([{ queries: ['aa', 'bb'] }, { query: 'aa' }, { query: 'bb' }]);
    const [a, b, c] = requests.starts();
    expect(a - t0).toBeLessThan(SLACK_MS);
    for (const gap of [b - a, c - b]) {
      expect(gap).toBeGreaterThanOrEqual(MIN_INTERACTIVE_INTERVAL_MS);
      expect(gap).toBeLessThan(MIN_INTERACTIVE_INTERVAL_MS + SLACK_MS);
    }
    expect(value).toEqual({
      ok: true,
      searches: [
        { query: 'aa', results: [hit({ title: 'aa' })] },
        { query: 'bb', results: [hit({ title: 'bb' })] },
      ],
    });
  });

  it('a single that then fails keeps its own verdict: the unavailable code rides on that entry only', async () => {
    serveSearch((q) => (q === 'bb' ? { status: 503 } : hits(hit())));
    rejectBatchShape();

    const { value } = await timed(searchWebBatch(['aa', 'bb']));
    const searches = (value as { searches: { query: string; results?: unknown[]; error?: string; code?: string }[] }).searches;

    expect(searches[0].results).toHaveLength(1);
    expect(searches[1].results).toBeUndefined();
    expect(searches[1]).toMatchObject({ query: 'bb', code: SEARCH_UNAVAILABLE });
    expect(searches[1].error).toContain('NOTHING was searched');
  });

  it('carries the out-of-bounds entries through the fallback', async () => {
    serveSearch((q) => hits(hit({ title: q })));
    rejectBatchShape();

    const { value } = await timed(searchWebBatch(['y', 'aa', 'bb']));
    const searches = (value as { searches: { query: string; error?: string }[] }).searches;

    expect(searches.map((s) => s.query)).toEqual(['y', 'aa', 'bb']);
    expect(searches[0].error).toBeDefined();
  });
});
