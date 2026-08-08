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

import { MAX_QUERY_CHARS, MIN_QUERY_CHARS, searchWeb } from '../web-search-client';

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

  // The server returns `{ results: [] }` when its own feature flag is off. That
  // is documented as a success, not an error — coding it as a failure would
  // make the model retry against a switch it can never flip.
  it('treats an empty result array as SUCCESS, not an error', async () => {
    mockFetch.mockResolvedValue(jsonResponse(200, { results: [] }));
    expect(await searchWeb('anything')).toEqual({ ok: true, results: [] });
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
      await Promise.resolve();
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
