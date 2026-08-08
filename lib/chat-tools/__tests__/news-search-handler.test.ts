// Tests for chat-tools/news-search-handler.ts (item 12b).

const mockQuery = jest.fn();

jest.mock('../../apollo-client', () => ({
  __esModule: true,
  default: { query: (...args: unknown[]) => mockQuery(...args) },
}));

jest.mock('../../logger', () => ({
  __esModule: true,
  default: { warn: jest.fn(), error: jest.fn(), debug: jest.fn(), info: jest.fn() },
}));

import { handleSearchNews, NEWS_SEARCH_LIMIT } from '../news-search-handler';

function hit(over: Partial<Record<string, unknown>> = {}) {
  return {
    _id: 'a1',
    title_en: 'Floods hit the delta',
    image_url: 'https://img',
    publication_name: 'The Daily',
    country_code: 'IN',
    pubDate: '2026-08-07T09:12:00.000Z',
    score: 0.81,
    ...over,
  };
}

describe('handleSearchNews', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockQuery.mockResolvedValue({ data: { searchNews: [hit()] } });
  });

  it('queries with the trimmed terms and returns flattened headlines', async () => {
    const result = await handleSearchNews({ query: '  delta floods  ' });

    expect(mockQuery).toHaveBeenCalledTimes(1);
    const call = mockQuery.mock.calls[0][0];
    expect(call.variables).toEqual({ query: 'delta floods', limit: NEWS_SEARCH_LIMIT });
    expect(call.fetchPolicy).toBe('no-cache');
    expect(result.articles).toEqual([
      {
        id: 'a1',
        title: 'Floods hit the delta',
        publication: 'The Daily',
        country: 'IN',
        date: '2026-08-07',
      },
    ]);
  });

  it('rejects an empty or non-string query without querying', async () => {
    for (const args of [{}, { query: '  ' }, { query: 3 }]) {
      const result = await handleSearchNews(args as Record<string, unknown>);
      expect(result.error).toBe('query must be a non-empty string');
    }
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('clamps the limit into 1..NEWS_SEARCH_LIMIT', async () => {
    for (const [asked, expected] of [
      [100, NEWS_SEARCH_LIMIT],
      [0, 1],
      [-5, 1],
      [3, 3],
      [3.9, 3],
    ] as const) {
      mockQuery.mockClear();
      await handleSearchNews({ query: 'q', limit: asked });
      expect(mockQuery.mock.calls[0][0].variables.limit).toBe(expected);
    }
  });

  it('nulls out missing optional fields rather than emitting undefined', async () => {
    mockQuery.mockResolvedValue({
      data: { searchNews: [hit({ publication_name: null, country_code: null, pubDate: 'junk' })] },
    });
    const result = await handleSearchNews({ query: 'q' });
    expect(result.articles).toEqual([
      { id: 'a1', title: 'Floods hit the delta', publication: null, country: null, date: '' },
    ]);
  });

  // 48h of news genuinely may not contain the thing asked about. That is a
  // success the model must report, not a failure it should retry.
  it('reports no hits as a success with a "say so" note', async () => {
    mockQuery.mockResolvedValue({ data: { searchNews: [] } });
    const result = await handleSearchNews({ query: 'q' });
    expect(result.articles).toEqual([]);
    expect(result.error).toBeUndefined();
    expect(typeof result.note).toBe('string');
  });

  it('handles a null payload the same way', async () => {
    mockQuery.mockResolvedValue({ data: { searchNews: null } });
    expect((await handleSearchNews({ query: 'q' })).articles).toEqual([]);
  });

  it('handles a missing data envelope', async () => {
    mockQuery.mockResolvedValue({});
    expect((await handleSearchNews({ query: 'q' })).articles).toEqual([]);
  });

  it('returns an error instead of throwing when the query fails', async () => {
    mockQuery.mockRejectedValue(new Error('offline'));
    const result = await handleSearchNews({ query: 'q' });
    expect(result.error).toContain('could not be reached');
    expect(result.articles).toBeUndefined();
  });

  // The server deliberately withholds body text and the link (hydration goes
  // through the metered articlesForTopicsByIds). The model must be told, or it
  // narrates an article it never read.
  it('tells the model it only has headlines', async () => {
    const result = await handleSearchNews({ query: 'q' });
    expect(result.note as string).toContain('Headlines only');
  });

  // conversation-service.parseToolCalls persists tool results as JSON, so a
  // result that does not survive a JSON round trip would come back corrupt on
  // a replayed conversation. Nulls and nested arrays are the shapes at risk.
  it('returns a JSON round-trippable result', async () => {
    mockQuery.mockResolvedValue({
      data: { searchNews: [hit(), hit({ _id: 'a2', publication_name: null })] },
    });
    const result = await handleSearchNews({ query: 'q' });
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });
});
