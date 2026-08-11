// Tests for chat-tools/web-search-handler.ts (item 13).
//
// The load-bearing one is "makes ZERO network calls when the toggle is off":
// the client is mocked and asserted NEVER CALLED, which is the only assertion
// that proves nothing left the device.

const mockSearchWeb = jest.fn();

jest.mock('../../web-search/web-search-client', () => ({
  searchWeb: (...args: unknown[]) => mockSearchWeb(...args),
  MIN_QUERY_CHARS: 2,
  MAX_QUERY_CHARS: 200,
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
    mockSearchWeb.mockResolvedValue({ ok: true, results: [] });
  });

  // --- THE privacy test ----------------------------------------------------

  describe('with the toggle OFF', () => {
    it('returns an error result and makes ZERO network calls', async () => {
      mockGetState.mockReturnValue({ webSearchInChat: false });

      const result = await handleWebSearch({ query: 'who won the election' });

      expect(mockSearchWeb).not.toHaveBeenCalled();
      expect(result.searched).toBe(false);
      expect(typeof result.error).toBe('string');
      expect(result.error as string).toContain('switched off');
    });

    // A device that has never seen the toggle has no value in the store at
    // all. Absent must behave exactly like off — never like on.
    it('treats an ABSENT toggle as off, still with zero network calls', async () => {
      mockGetState.mockReturnValue({});

      const result = await handleWebSearch({ query: 'who won the election' });

      expect(mockSearchWeb).not.toHaveBeenCalled();
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
      expect(mockSearchWeb).not.toHaveBeenCalled();
    });
  });

  // --- with the toggle ON --------------------------------------------------

  it('searches and returns the hits when the toggle is on', async () => {
    mockSearchWeb.mockResolvedValue({
      ok: true,
      results: [{ title: 'T', url: 'https://e.com', snippet: 'S' }],
    });

    const result = await handleWebSearch({ query: '  election results  ' });

    expect(mockSearchWeb).toHaveBeenCalledWith('election results');
    expect(result.searched).toBe(true);
    expect(result.results).toEqual([{ title: 'T', url: 'https://e.com', snippet: 'S' }]);
  });

  it('rejects an empty or non-string query without searching', async () => {
    for (const args of [{}, { query: '   ' }, { query: 7 }]) {
      const result = await handleWebSearch(args as Record<string, unknown>);
      expect(result.searched).toBe(false);
      expect(result.error).toBe('query must be a non-empty string');
    }
    expect(mockSearchWeb).not.toHaveBeenCalled();
  });

  it('caps how many hits reach the prompt, and truncates long snippets', async () => {
    mockSearchWeb.mockResolvedValue({
      ok: true,
      results: Array.from({ length: 10 }, (_, i) => ({
        title: `T${i}`,
        url: `https://e.com/${i}`,
        snippet: 'x'.repeat(400),
      })),
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
    mockSearchWeb.mockResolvedValue({ ok: true, results: [] });

    const result = await handleWebSearch({ query: 'obscure thing' });

    expect(result.searched).toBe(true);
    expect(result.results).toEqual([]);
    expect(typeof result.note).toBe('string');
  });

  it('passes a client failure through as an error the model can act on', async () => {
    mockSearchWeb.mockResolvedValue({ ok: false, error: 'rate limited', status: 429 });

    const result = await handleWebSearch({ query: 'anything' });

    expect(result.searched).toBe(false);
    expect(result.error).toBe('rate limited');
  });

  // Deliberately NOT truncated: a 200-char prefix cut mid-clause would be
  // searched and reported as a success, so the model would answer confidently
  // about a question the user did not ask. The client refuses it instead.
  it('passes an over-long query through untruncated, for the client to refuse', async () => {
    mockSearchWeb.mockResolvedValue({ ok: false, error: 'too long', status: 400 });
    const long = 'y'.repeat(500);

    const result = await handleWebSearch({ query: long });

    expect(mockSearchWeb).toHaveBeenCalledWith(long);
    expect(result.searched).toBe(false);
    expect(result.error).toBe('too long');
  });

  // conversation-service.parseToolCalls persists tool results as JSON, so a
  // result that does not survive a JSON round trip would come back corrupt on
  // a replayed conversation.
  it('returns a JSON round-trippable result', async () => {
    mockSearchWeb.mockResolvedValue({
      ok: true,
      results: [{ title: 'T', url: 'https://e.com', snippet: 'S' }],
    });
    const result = await handleWebSearch({ query: 'election' });
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });
});
