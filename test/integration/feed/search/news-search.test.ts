// News search: the debounced useNewsSearch state machine and the searchNews service behind it, over
// the real Apollo client and MSW. Replaces lib/news-search/__tests__/search-news-service.test.ts
// (which mocked apollo-client, logger and the not-subscribed predicate); its cases are carried over
// below with the same expected values. Faked: only the clock.
import { graphql, HttpResponse, mockGql, mockGqlError, server, useFakeClock, useStrictClock, advanceUntilDone } from '@/test/helpers';
import { act, renderHook } from '@testing-library/react-native';
import logger from '@/lib/logger';
import { useNewsSearch, NEWS_SEARCH_DEBOUNCE_MS } from '@/lib/news-search/use-news-search';
import { SEARCH_NEWS_MAX_RESULTS, SEARCH_NEWS_MIN_QUERY_LENGTH, searchNews } from '@/lib/news-search/search-news-service';

const hit = (overrides: Record<string, unknown> = {}) => ({
  __typename: 'NewsSearchHit',
  _id: 'hit-1',
  title_en: 'A headline',
  image_url: 'https://example.com/x.jpg',
  publication_name: 'Example Times',
  country_code: 'US',
  pubDate: '2026-08-07T00:00:00.000Z',
  score: 0.87,
  ...overrides,
});

/** An answer for SearchNews that records every request's variables. */
function answering(hits: unknown[] | null, sent: Record<string, any>[] = []) {
  server.use(
    mockGql('SearchNews', (vars) => {
      sent.push(vars);
      return { searchNews: hits };
    }),
  );
  return sent;
}

let captureSpy: jest.SpyInstance;
let crumbSpy: jest.SpyInstance;
beforeEach(() => {
  // The logger is a mockable edge: nothing reaches Sentry.
  captureSpy = jest.spyOn(logger, 'captureException').mockImplementation(() => undefined as never);
  crumbSpy = jest.spyOn(logger, 'addBreadcrumb').mockImplementation(() => undefined as never);
});
afterEach(() => {
  captureSpy.mockRestore();
  crumbSpy.mockRestore();
});

/** The calls the SERVICE made to the logger (the Apollo error link reports on its own tags). */
const serviceCaptures = () => captureSpy.mock.calls.filter((c) => c[1]?.tags?.service === 'news-search-service');
const serviceCrumbs = () => crumbSpy.mock.calls.filter((c) => c[1] === 'news-search');

describe('searchNews', () => {
  it('short-circuits below the minimum query length without calling the server', async () => {
    const sent = answering([hit()]);
    expect(await searchNews('a')).toEqual({ ok: true, hits: [] });
    expect(sent).toHaveLength(0);
  });

  it('short-circuits an all-whitespace query', async () => {
    const sent = answering([hit()]);
    expect(await searchNews('   ')).toEqual({ ok: true, hits: [] });
    expect(sent).toHaveLength(0);
  });

  it('accepts exactly the minimum length', async () => {
    expect(SEARCH_NEWS_MIN_QUERY_LENGTH).toBe(2);
    const sent = answering([]);
    expect(await searchNews('ab')).toEqual({ ok: true, hits: [] });
    expect(sent).toHaveLength(1);
  });

  it('trims the query and sends the default limit', async () => {
    const sent = answering([]);
    await searchNews('  modi india  ');
    expect(sent).toEqual([{ query: 'modi india', limit: SEARCH_NEWS_MAX_RESULTS }]);
  });

  it('forwards a custom limit', async () => {
    const sent = answering([]);
    await searchNews('modi', 5);
    expect(sent).toEqual([{ query: 'modi', limit: 5 }]);
  });

  it('returns the hits from a successful response', async () => {
    answering([hit(), hit({ _id: 'hit-2' })]);
    const result = await searchNews('modi india');
    expect(result).toEqual({ ok: true, hits: [hit(), hit({ _id: 'hit-2' })] });
  });

  it('falls back to an empty array when the response carries no data', async () => {
    answering(null);
    expect(await searchNews('modi india')).toEqual({ ok: true, hits: [] });
  });

  it('classifies a not-subscribed failure (PAYMENT_REQUIRED) without a Sentry report from the service', async () => {
    server.use(mockGqlError('SearchNews', 'PAYMENT_REQUIRED', { statusCode: 402 }));
    expect(await searchNews('modi india')).toEqual({ ok: false, kind: 'not-subscribed' });
    expect(serviceCrumbs()).toHaveLength(1);
    expect(serviceCrumbs()[0][2]).toEqual({ queryLength: 'modi india'.length });
    expect(serviceCaptures()).toHaveLength(0);
  });

  it('classifies an HTTP 402 the same way', async () => {
    server.use(mockGqlError('SearchNews', 'PAYMENT_REQUIRED', { httpStatus: 402 }));
    expect(await searchNews('modi india')).toEqual({ ok: false, kind: 'not-subscribed' });
    expect(serviceCaptures()).toHaveLength(0);
  });

  it('classifies any other GraphQL failure as unknown and reports it with the query length only', async () => {
    server.use(mockGqlError('SearchNews', 'INTERNAL_SERVER_ERROR', { message: 'boom' }));
    expect(await searchNews('modi india')).toEqual({ ok: false, kind: 'unknown' });
    expect(serviceCaptures()).toHaveLength(1);
    const [error, ctx] = serviceCaptures()[0];
    expect(String(error)).toContain('boom');
    expect(ctx).toEqual({ tags: { service: 'news-search-service', method: 'searchNews' }, extra: { queryLength: 10 } });
    expect(serviceCrumbs()).toHaveLength(0);
  });

  it('classifies a transport failure as unknown and reports it', async () => {
    useFakeClock(Date.now()); // the client retries a dropped connection with a backoff
    server.use(graphql.operation(({ operationName }) => (operationName === 'SearchNews' ? HttpResponse.error() : undefined)));
    const result = await advanceUntilDone(searchNews('modi india'));
    expect(result).toEqual({ ok: false, kind: 'unknown' });
    expect(serviceCaptures()).toHaveLength(1);
    expect(serviceCrumbs()).toHaveLength(0);
  });
});

describe('useNewsSearch', () => {
  /** Step the strict clock (and one real event-loop turn per step, inside act) until `cond()`. */
  async function settleUntil(cond: () => boolean, steps = 200): Promise<void> {
    for (let i = 0; i < steps && !cond(); i++) {
      await act(async () => {
        await jest.advanceTimersByTimeAsync(10);
        await new Promise<void>((resolve) => setImmediate(resolve));
      });
    }
    if (!cond()) throw new Error('settleUntil: condition not met');
  }
  const advance = (ms: number) =>
    act(async () => {
      await jest.advanceTimersByTimeAsync(ms);
    });
  const type = (r: { current: ReturnType<typeof useNewsSearch> }, text: string) => act(() => r.current.setQuery(text));

  beforeEach(() => useStrictClock(Date.now()));

  it('stays idle with no request below two characters, however long it waits', async () => {
    const sent = answering([hit()]);
    const { result } = renderHook(() => useNewsSearch());
    await type(result, 'a');
    await advance(NEWS_SEARCH_DEBOUNCE_MS * 5);
    expect(result.current.status).toBe('idle');
    expect(result.current.isActive).toBe(true); // typed something, so the panel is up
    expect(sent).toHaveLength(0);
    await type(result, ' a ');
    await advance(NEWS_SEARCH_DEBOUNCE_MS * 5);
    expect(result.current.status).toBe('idle');
    expect(sent).toHaveLength(0);
  });

  it('fires one request 300 ms after the last keystroke, not before', async () => {
    expect(NEWS_SEARCH_DEBOUNCE_MS).toBe(300);
    const sent = answering([hit()]);
    const { result } = renderHook(() => useNewsSearch());
    await type(result, 'mo');
    expect(result.current.status).toBe('loading');
    await advance(299);
    expect(sent).toHaveLength(0);
    await advance(1);
    await settleUntil(() => result.current.status === 'success');
    expect(sent).toEqual([{ query: 'mo', limit: 25 }]);
    expect(result.current.hits).toEqual([hit()]);
  });

  it('typing again restarts the window: three quick keystrokes make one request for the last text', async () => {
    const sent = answering([hit()]);
    const { result } = renderHook(() => useNewsSearch());
    await type(result, 'mo');
    await advance(200);
    await type(result, 'mod');
    await advance(200);
    await type(result, 'modi');
    await advance(299);
    expect(sent).toHaveLength(0);
    await advance(1);
    await settleUntil(() => result.current.status === 'success');
    expect(sent).toEqual([{ query: 'modi', limit: 25 }]);
  });

  it('asks for at most 25 results', async () => {
    const sent = answering([]);
    const { result } = renderHook(() => useNewsSearch());
    await type(result, 'modi');
    await advance(NEWS_SEARCH_DEBOUNCE_MS);
    await settleUntil(() => result.current.status === 'success');
    expect(SEARCH_NEWS_MAX_RESULTS).toBe(25);
    expect(sent[0].limit).toBe(25);
  });

  it('a slower earlier response does not overwrite a later one', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    server.use(
      mockGql('SearchNews', async (vars) => {
        if (vars.query === 'modi') await held; // the first query is slow
        return { searchNews: [hit({ _id: `for-${vars.query}` })] };
      }),
    );
    const { result } = renderHook(() => useNewsSearch());
    await type(result, 'modi');
    await advance(NEWS_SEARCH_DEBOUNCE_MS); // request 1 is now in flight and held
    await type(result, 'modi india');
    await advance(NEWS_SEARCH_DEBOUNCE_MS);
    await settleUntil(() => result.current.status === 'success');
    expect(result.current.hits.map((h) => h._id)).toEqual(['for-modi india']);

    release(); // the stale answer arrives last
    await act(async () => {
      for (let i = 0; i < 10; i++) await new Promise<void>((resolve) => setImmediate(resolve));
    });
    expect(result.current.hits.map((h) => h._id)).toEqual(['for-modi india']);
    expect(result.current.status).toBe('success');
  });

  it('deleting back below two characters clears at once and drops an in-flight answer', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    server.use(
      mockGql('SearchNews', async () => {
        await held;
        return { searchNews: [hit()] };
      }),
    );
    const { result } = renderHook(() => useNewsSearch());
    await type(result, 'modi');
    await advance(NEWS_SEARCH_DEBOUNCE_MS);
    expect(result.current.status).toBe('loading');
    await type(result, 'm'); // no debounce on the way down
    expect(result.current.status).toBe('idle');
    expect(result.current.hits).toEqual([]);
    release();
    await act(async () => {
      for (let i = 0; i < 10; i++) await new Promise<void>((resolve) => setImmediate(resolve));
    });
    expect(result.current.status).toBe('idle');
    expect(result.current.hits).toEqual([]);
  });

  it('retry re-runs the search at once, without the debounce', async () => {
    let calls = 0;
    server.use(
      graphql.operation(({ operationName }) => {
        if (operationName !== 'SearchNews') return undefined;
        calls += 1;
        return calls === 1
          ? HttpResponse.json({ errors: [{ message: 'boom', extensions: { code: 'INTERNAL_SERVER_ERROR' } }] })
          : HttpResponse.json({ data: { searchNews: [hit()] } });
      }),
    );
    const { result } = renderHook(() => useNewsSearch());
    await type(result, 'modi');
    await advance(NEWS_SEARCH_DEBOUNCE_MS);
    await settleUntil(() => result.current.status === 'error');
    expect(result.current.errorKind).toBe('unknown');
    expect(result.current.hits).toEqual([]);

    act(() => result.current.retry());
    expect(result.current.status).toBe('loading');
    // Real event-loop turns only: no fake time passes, so no debounce could have elapsed.
    await act(async () => {
      for (let i = 0; i < 50 && calls < 2; i++) await new Promise<void>((resolve) => setImmediate(resolve));
    });
    await act(async () => {
      for (let i = 0; i < 20; i++) await new Promise<void>((resolve) => setImmediate(resolve));
    });
    expect(calls).toBe(2);
    expect(result.current.status).toBe('success');
    expect(result.current.errorKind).toBeNull();
    expect(result.current.hits).toEqual([hit()]);
  });

  it('retry is a no-op below the minimum length', async () => {
    const sent = answering([hit()]);
    const { result } = renderHook(() => useNewsSearch());
    await type(result, 'a');
    act(() => result.current.retry());
    await advance(NEWS_SEARCH_DEBOUNCE_MS);
    expect(sent).toHaveLength(0);
    expect(result.current.status).toBe('idle');
  });

  it('a not-subscribed answer is an error state of kind not-subscribed', async () => {
    server.use(mockGqlError('SearchNews', 'PAYMENT_REQUIRED', { statusCode: 402 }));
    const { result } = renderHook(() => useNewsSearch());
    await type(result, 'modi');
    await advance(NEWS_SEARCH_DEBOUNCE_MS);
    await settleUntil(() => result.current.status === 'error');
    expect(result.current.errorKind).toBe('not-subscribed');
  });

  it('clear() returns to the idle pre-search state', async () => {
    answering([hit()]);
    const { result } = renderHook(() => useNewsSearch());
    await type(result, 'modi');
    await advance(NEWS_SEARCH_DEBOUNCE_MS);
    await settleUntil(() => result.current.status === 'success');
    act(() => result.current.clear());
    expect(result.current.query).toBe('');
    expect(result.current.status).toBe('idle');
    expect(result.current.hits).toEqual([]);
    expect(result.current.isActive).toBe(false);
  });
});
