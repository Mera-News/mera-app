// Tests for chat-tools/web-search-handler.ts (item 13).
//
// The load-bearing one is "makes ZERO network calls when the toggle is off":
// the client is mocked and asserted NEVER CALLED, which is the only assertion
// that proves nothing left the device.

const mockSearchWebBatch = jest.fn();

jest.mock('../../web-search/web-search-client', () => ({
  searchWebBatch: (...args: unknown[]) => mockSearchWebBatch(...args),
  MIN_QUERY_CHARS: 2,
  MAX_QUERY_CHARS: 200,
  MAX_BATCH_QUERIES: 4,
}));

const mockGetState = jest.fn();

jest.mock('../../stores/mera-protocol-store', () => ({
  useMeraProtocolStore: { getState: (...args: unknown[]) => mockGetState(...args) },
}));

import { handleWebSearch } from '../web-search-handler';

describe('handleWebSearch', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetState.mockReturnValue({ webSearchInChat: true });
    mockSearchWebBatch.mockResolvedValue({ ok: true, searches: [] });
  });

  // --- THE privacy test ----------------------------------------------------

  describe('with the toggle OFF', () => {
    it('returns an error result and makes ZERO network calls', async () => {
      mockGetState.mockReturnValue({ webSearchInChat: false });

      const result = await handleWebSearch({ query: 'who won the election' });

      expect(mockSearchWebBatch).not.toHaveBeenCalled();
      expect(result.searched).toBe(false);
      expect(typeof result.error).toBe('string');
      expect(result.error as string).toContain('switched off');
    });

    // A device that has never seen the toggle has no value in the store at
    // all. Absent must behave exactly like off — never like on.
    it('treats an ABSENT toggle as off, still with zero network calls', async () => {
      mockGetState.mockReturnValue({});

      const result = await handleWebSearch({ query: 'who won the election' });

      expect(mockSearchWebBatch).not.toHaveBeenCalled();
      expect(result.searched).toBe(false);
    });

    // The gate must precede every await. `searchWeb` resolves a JWT — itself a
    // networked call — so a check placed after that would already have hit the
    // network by the time it refused. Even a nonsense payload must not search.
    it('refuses before any other work, whatever the arguments look like', async () => {
      mockGetState.mockReturnValue({ webSearchInChat: false });

      for (const args of [{}, { query: '' }, { query: 42 }, { query: 'x'.repeat(500) }]) {
        const result = await handleWebSearch(args as Record<string, unknown>);
        expect(result.searched).toBe(false);
      }
      expect(mockSearchWebBatch).not.toHaveBeenCalled();
    });
  });

  // --- with the toggle ON --------------------------------------------------

  // A LONE `query` keeps its original result shape exactly — `searched` +
  // `results` at the top level, no `searches` array. Every prompt written
  // before batching existed still reads the same thing.
  it('searches and returns the hits when the toggle is on', async () => {
    mockSearchWebBatch.mockResolvedValue({
      ok: true,
      searches: [
        { query: 'election results', results: [{ title: 'T', url: 'https://e.com', snippet: 'S' }] },
      ],
    });

    const result = await handleWebSearch({ query: '  election results  ' });

    expect(mockSearchWebBatch).toHaveBeenCalledWith(['election results']);
    expect(result.searched).toBe(true);
    expect(result.results).toEqual([{ title: 'T', url: 'https://e.com', snippet: 'S' }]);
    expect(result.searches).toBeUndefined();
  });

  it('rejects an empty or non-string query without searching', async () => {
    for (const args of [{}, { query: '   ' }, { query: 7 }, { queries: [] }, { queries: [7, ''] }]) {
      const result = await handleWebSearch(args as Record<string, unknown>);
      expect(result.searched).toBe(false);
      expect(result.error).toBe('queries must be a non-empty array of strings');
    }
    expect(mockSearchWebBatch).not.toHaveBeenCalled();
  });

  it('caps how many hits reach the prompt, and truncates long snippets', async () => {
    mockSearchWebBatch.mockResolvedValue({
      ok: true,
      searches: [
        {
          query: 'qqq',
          results: Array.from({ length: 10 }, (_, i) => ({
            title: `T${i}`,
            url: `https://e.com/${i}`,
            snippet: 'x'.repeat(400),
          })),
        },
      ],
    });

    const result = await handleWebSearch({ query: 'q' .repeat(3) });
    const results = result.results as Array<{ snippet: string }>;

    expect(results).toHaveLength(5);
    expect(results[0].snippet.length).toBeLessThanOrEqual(220);
    expect(results[0].snippet.endsWith('…')).toBe(true);
  });

  // `ok:true, results:[]` means we searched and the index had nothing — a real
  // answer about the world, distinct from `ok:false` ("we did not search",
  // which the gateway now signals with its own 503 + code rather than an empty
  // array). See web-search-client.ts's WebSearchOutcome contract.
  it('reports an empty result set as a search that succeeded', async () => {
    mockSearchWebBatch.mockResolvedValue({
      ok: true,
      searches: [{ query: 'obscure thing', results: [] }],
    });

    const result = await handleWebSearch({ query: 'obscure thing' });

    expect(result.searched).toBe(true);
    expect(result.results).toEqual([]);
    expect(typeof result.note).toBe('string');
  });

  it('passes a client failure through as an error the model can act on', async () => {
    mockSearchWebBatch.mockResolvedValue({ ok: false, error: 'rate limited', status: 429 });

    const result = await handleWebSearch({ query: 'anything' });

    expect(result.searched).toBe(false);
    expect(result.error).toBe('rate limited');
  });

  // Deliberately NOT truncated: a 200-char prefix cut mid-clause would be
  // searched and reported as a success, so the model would answer confidently
  // about a question the user did not ask. The client refuses it instead.
  it('passes an over-long query through untruncated, for the client to refuse', async () => {
    mockSearchWebBatch.mockResolvedValue({ ok: false, error: 'too long', status: 400 });
    const long = 'y'.repeat(500);

    const result = await handleWebSearch({ query: long });

    expect(mockSearchWebBatch).toHaveBeenCalledWith([long]);
    expect(result.searched).toBe(false);
    expect(result.error).toBe('too long');
  });

  // conversation-service.parseToolCalls persists tool results as JSON, so a
  // result that does not survive a JSON round trip would come back corrupt on
  // a replayed conversation.
  it('returns a JSON round-trippable result', async () => {
    mockSearchWebBatch.mockResolvedValue({
      ok: true,
      searches: [{ query: 'election', results: [{ title: 'T', url: 'https://e.com', snippet: 'S' }] }],
    });
    const result = await handleWebSearch({ query: 'election' });
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });

  // --- several queries in one call -----------------------------------------
  //
  // The whole reason the batch shape exists: the app's shared gateway limiter
  // grants one caller every 3s, so three searches issued as three calls are at
  // least 6s of pure queueing. One call, one grant.

  describe('with several queries', () => {
    it('sends them all in ONE client call and returns one entry per query', async () => {
      mockSearchWebBatch.mockResolvedValue({
        ok: true,
        searches: [
          { query: 'a query', results: [{ title: 'A', url: 'https://a.com', snippet: 'sa' }] },
          { query: 'b query', results: [] },
        ],
      });

      const result = await handleWebSearch({ queries: ['a query', 'b query'] });

      expect(mockSearchWebBatch).toHaveBeenCalledTimes(1);
      expect(mockSearchWebBatch).toHaveBeenCalledWith(['a query', 'b query']);
      const searches = result.searches as Array<Record<string, unknown>>;
      expect(searches).toHaveLength(2);
      expect(searches[0].searched).toBe(true);
      expect(searches[1].results).toEqual([]);
      expect(typeof searches[1].note).toBe('string');
    });

    it('gives each query fewer hits than a lone query gets', async () => {
      const hits = Array.from({ length: 10 }, (_, i) => ({
        title: `T${i}`,
        url: `https://e.com/${i}`,
        snippet: 's',
      }));
      mockSearchWebBatch.mockResolvedValue({
        ok: true,
        searches: [
          { query: 'one', results: hits },
          { query: 'two', results: hits },
        ],
      });

      const result = await handleWebSearch({ queries: ['one', 'two'] });
      const searches = result.searches as Array<{ results: unknown[] }>;

      // Breadth is what a batch buys; depth per query is what it spends.
      expect(searches[0].results).toHaveLength(3);
      expect(searches[1].results).toHaveLength(3);
    });

    // An entry that carries `error` was NEVER LOOKED UP. Reporting it as an
    // empty result set is the fabricated all-clear this whole contract exists
    // to prevent.
    it('keeps an unavailable entry distinct from an empty one', async () => {
      mockSearchWebBatch.mockResolvedValue({
        ok: true,
        searches: [
          { query: 'looked up', results: [] },
          { query: 'never looked', error: 'NOTHING was searched', code: 'search-unavailable' },
        ],
      });

      const result = await handleWebSearch({ queries: ['looked up', 'never looked'] });
      const searches = result.searches as Array<Record<string, unknown>>;

      expect(searches[0]).toMatchObject({ searched: true, results: [] });
      expect(searches[1]).toMatchObject({ searched: false });
      expect(searches[1].results).toBeUndefined();
      // At least one query WAS searched, so the call as a whole was.
      expect(result.searched).toBe(true);
    });

    it('reports searched:false when every entry failed', async () => {
      mockSearchWebBatch.mockResolvedValue({
        ok: true,
        searches: [
          { query: 'one', error: 'nope', code: 'search-unavailable' },
          { query: 'two', error: 'nope', code: 'search-unavailable' },
        ],
      });

      const result = await handleWebSearch({ queries: ['one', 'two'] });

      expect(result.searched).toBe(false);
    });

    it('tells the model when it asked for more queries than the ceiling', async () => {
      mockSearchWebBatch.mockResolvedValue({
        ok: true,
        searches: [1, 2, 3, 4].map((n) => ({ query: `q${n}`, results: [] })),
      });

      const result = await handleWebSearch({ queries: ['q1', 'q2', 'q3', 'q4', 'q5'] });

      // Silent truncation would read as "all five were searched".
      expect(typeof result.dropped).toBe('string');
    });
  });

});
