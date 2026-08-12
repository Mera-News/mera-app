// Tests for web-search/web-search-client.ts (item 13) — the transport.

const mockGetJwtToken = jest.fn();

jest.mock('../../auth-client', () => ({
  getJwtToken: (...args: unknown[]) => mockGetJwtToken(...args),
}));

jest.mock('../../config/endpoints', () => ({
  INFERENCE_ENDPOINT: 'https://gateway.test',
}));

jest.mock('../../logger', () => ({
  __esModule: true,
  default: { warn: jest.fn(), error: jest.fn(), debug: jest.fn(), info: jest.fn() },
}));

// The REAL limiter spaces grants 3s apart, which would add ~45s of dead wall
// clock to this file. Mocked so the ORDER (limiter before fetch) is asserted
// directly rather than paid for.
const mockAcquire = jest.fn().mockResolvedValue(undefined);
const mockPauseFor = jest.fn();
jest.mock('../../llm/gateway-rate-limiter', () => ({
  acquire: (...args: unknown[]) => mockAcquire(...args),
  pauseFor: (...args: unknown[]) => mockPauseFor(...args),
}));

import { MAX_QUERY_CHARS, MIN_QUERY_CHARS, SEARCH_UNAVAILABLE, searchWeb } from '../web-search-client';

const mockFetch = jest.fn();

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  };
}

describe('searchWeb', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetJwtToken.mockResolvedValue('jwt-abc');
    mockAcquire.mockResolvedValue(undefined);
    global.fetch = mockFetch as unknown as typeof fetch;
    mockFetch.mockResolvedValue(jsonResponse(200, { results: [] }));
  });

  it('POSTs ONLY the query, bearing the session JWT', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse(200, { results: [{ title: 'T', url: 'u', snippet: 'S' }] }),
    );

    const outcome = await searchWeb('  election results  ');

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('https://gateway.test/v1/web-search');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer jwt-abc');
    // The BODY is the privacy assertion: exactly one key, exactly the query.
    expect(JSON.parse(init.body)).toEqual({ query: 'election results' });
    expect(outcome).toEqual({ ok: true, results: [{ title: 'T', url: 'u', snippet: 'S' }] });
  });

  // An empty array behind a 200 now means EXACTLY ONE THING: we asked and the
  // index had nothing. It used to also mean "the server's feature flag is off",
  // which made a missing env var indistinguishable from a real zero-hit search.
  // The gateway signals that state with a 503 instead — see below.
  it('treats an empty result array behind a 200 as SUCCESS — we searched, no hits', async () => {
    mockFetch.mockResolvedValue(jsonResponse(200, { results: [] }));
    expect(await searchWeb('anything')).toEqual({ ok: true, results: [] });
  });

  // THE CONTROL THAT MUST BE ABLE TO FAIL. Point the client at a gateway whose
  // search is switched off and watch it refuse, rather than hand back a success
  // a caller would render as "we searched and found nothing".
  it('maps a 503 search-unavailable to a failure carrying the code', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse(503, { code: 'search-unavailable', reason: 'disabled', message: 'off' }),
    );

    const outcome = await searchWeb('anything');

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.code).toBe(SEARCH_UNAVAILABLE);
      expect(outcome.status).toBe(503);
      // The prose is what the MODEL reads, so it must forbid the exact wrong
      // conclusion rather than merely omit it.
      expect(outcome.error).toContain('NOTHING was searched');
    }
  });

  it('still concludes unavailable from a body-less 503 (e.g. Cloud Run itself)', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 503,
      json: () => Promise.reject(new SyntaxError('not json')),
    });
    const outcome = await searchWeb('anything');
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe(SEARCH_UNAVAILABLE);
  });

  it('marks a 429 unavailable and backs the shared limiter off', async () => {
    mockFetch.mockResolvedValue(jsonResponse(429, {}));
    const outcome = await searchWeb('anything');
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe(SEARCH_UNAVAILABLE);
    expect(mockPauseFor).toHaveBeenCalledTimes(1);
  });

  it('marks a 404 unavailable — the deploy-skew case that actually happened', async () => {
    // 2026-08-12, live: the app ran `dev` while the deployed gateway ran
    // `main`, which carries neither search route. A real quick fact check got
    // a 404 from a route that did not exist. Nothing was searched, so it must
    // carry the same code as 503 — otherwise a caller branching on `code`
    // alone treats a wholly unsearched query as merely a failed one.
    mockFetch.mockResolvedValue(jsonResponse(404, {}));
    const outcome = await searchWeb('anything');
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.code).toBe(SEARCH_UNAVAILABLE);
      // And the model must be told the same thing a 503 tells it, word for
      // word — a softer phrasing here is how "I found nothing" gets said.
      expect(outcome.error).toContain('NOTHING was searched');
    }
  });

  it('does NOT mark an ordinary upstream failure (502) as search-unavailable', async () => {
    // 502 means the provider failed on a request we did make; 503 means we
    // never made one. Both are `ok:false`, but only one is a configuration
    // state, and conflating them would make the code useless as a signal.
    mockFetch.mockResolvedValue(jsonResponse(502, {}));
    const outcome = await searchWeb('anything');
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBeUndefined();
  });

  it('goes through the shared gateway limiter BEFORE fetching', async () => {
    const order: string[] = [];
    mockAcquire.mockImplementation(() => {
      order.push('acquire');
      return Promise.resolve();
    });
    mockFetch.mockImplementation(() => {
      order.push('fetch');
      return Promise.resolve(jsonResponse(200, { results: [] }));
    });

    await searchWeb('anything');

    expect(order).toEqual(['acquire', 'fetch']);
  });

  // The limiter is a SHARED FIFO with no ceiling — during a scoring cycle a
  // search can queue behind many 3s grants. The deadline therefore covers the
  // queue wait too, or a chat turn hangs for as long as the pipeline runs.
  it('gives up without fetching when the limiter queue outlasts the deadline', async () => {
    jest.useFakeTimers();
    try {
      // A grant that never comes. Before the deadline was raced against the
      // limiter, this hung the call forever and this test timed out — which is
      // exactly how the bug was found.
      mockAcquire.mockImplementation(() => new Promise(() => {}));

      const pending = searchWeb('anything');
      // Let the token resolve so the deadline timer is actually registered
      // before the clock jumps.
      for (let i = 0; i < 10; i += 1) await Promise.resolve();
      jest.advanceTimersByTime(60_000);

      const outcome = await pending;

      expect(mockFetch).not.toHaveBeenCalled();
      expect(outcome.ok).toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not spend a limiter grant on a request it refuses locally', async () => {
    await searchWeb('a');
    mockGetJwtToken.mockResolvedValue(null);
    await searchWeb('anything');
    expect(mockAcquire).not.toHaveBeenCalled();
  });

  it('drops malformed hits and defaults a missing snippet', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse(200, {
        results: [
          { title: 'ok', url: 'u1' },
          { title: 'no url' },
          null,
          'nonsense',
          { url: 'no title' },
        ],
      }),
    );
    expect(await searchWeb('anything')).toEqual({
      ok: true,
      results: [{ title: 'ok', url: 'u1', snippet: '' }],
    });
  });

  it('tolerates a body with no results key at all', async () => {
    mockFetch.mockResolvedValue(jsonResponse(200, {}));
    expect(await searchWeb('anything')).toEqual({ ok: true, results: [] });
  });

  it.each([
    [400, '400'],
    [401, '401'],
    [429, '429'],
    [502, '502'],
    [418, 'HTTP 418'],
  ])('maps a %i response to a non-throwing failure', async (status) => {
    mockFetch.mockResolvedValue(jsonResponse(status, {}));
    const outcome = await searchWeb('anything');
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.status).toBe(status);
  });

  it('rejects a too-short or too-long query WITHOUT a round trip', async () => {
    for (const q of ['', ' ', 'a', 'z'.repeat(MAX_QUERY_CHARS + 1)]) {
      const outcome = await searchWeb(q);
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.status).toBe(400);
    }
    expect(mockFetch).not.toHaveBeenCalled();
    expect(MIN_QUERY_CHARS).toBe(2);
  });

  it('treats a null/undefined query as too short, without a round trip', async () => {
    for (const q of [null, undefined]) {
      const outcome = await searchWeb(q as unknown as string);
      expect(outcome.ok).toBe(false);
    }
    expect(mockFetch).not.toHaveBeenCalled();
  });

  // A chat turn is already waiting on this call, so a hung gateway must abort
  // rather than hold the turn open indefinitely.
  it('aborts a hung request and reports a failure', async () => {
    jest.useFakeTimers();
    try {
      let abortSignal: AbortSignal | undefined;
      mockFetch.mockImplementation((_url: string, init: { signal: AbortSignal }) => {
        abortSignal = init.signal;
        return new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(new Error('aborted')));
        });
      });

      const pending = searchWeb('a hung query');
      // Several awaits now stand between the call and the fetch (token, then
      // the shared rate limiter), so one microtask tick is no longer enough to
      // reach it. Flush generously before advancing the clock.
      for (let i = 0; i < 10; i += 1) await Promise.resolve();
      jest.advanceTimersByTime(60_000);

      expect(abortSignal!.aborted).toBe(true);
      expect((await pending).ok).toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });

  it('never sends a request without a token', async () => {
    mockGetJwtToken.mockResolvedValue(null);
    const outcome = await searchWeb('anything');
    expect(mockFetch).not.toHaveBeenCalled();
    expect(outcome).toEqual({ ok: false, error: expect.any(String), status: 401 });
  });

  it('never sends a request when the token lookup throws', async () => {
    mockGetJwtToken.mockRejectedValue(new Error('keychain locked'));
    const outcome = await searchWeb('anything');
    expect(mockFetch).not.toHaveBeenCalled();
    expect(outcome.ok).toBe(false);
  });

  it('returns a failure rather than throwing when the network rejects', async () => {
    mockFetch.mockRejectedValue(new Error('offline'));
    const outcome = await searchWeb('anything');
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.status).toBeUndefined();
  });

  it('returns a failure rather than throwing on a malformed body', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.reject(new SyntaxError('not json')),
    });
    expect((await searchWeb('anything')).ok).toBe(false);
  });
});
