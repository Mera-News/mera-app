// useScopeArticleList (World and country pages): the real hook under renderHook with the real
// ArticleService, Apollo client and MSW. Faked: only the clock (hung-load test). The windowed
// document's fallbacks are module state in article-service, reset in beforeEach.
import {
  delay,
  graphql,
  mockGql,
  mockGqlError,
  renderHookInScreen,
  server,
  useStrictClock,
} from '@/test/helpers';
import { act, waitFor } from '@testing-library/react-native';
import { useScopeArticleList } from '@/components/custom/explore/useScopeArticleList';
import { HUNG_LOAD_MS } from '@/components/custom/explore/useScopeArticleList';
import { __resetExploreWindowSupport, __resetWorldTopicsSupport } from '@/lib/article-service';
import type { ExploreScope } from '@/lib/explore/scopes';
import { articlesForCountry, newsArticle, pageOf, stableClusterId } from '@/test/mock-backend/fixtures/articles';

const WORLD: ExploreScope = { id: 'world', kind: 'world', label: '', icon: 'public', countryCodeAlpha3: null };
const NLD: ExploreScope = {
  id: 'country:NLD',
  kind: 'country',
  label: 'Netherlands',
  icon: 'flag',
  countryCodeAlpha3: 'NLD',
  countryCodeAlpha2: 'NL',
};

/** One article per story, as the server's deduplicated edition lists them. */
const leaders = (code: string | null) => {
  const list = articlesForCountry(code);
  return list.filter((a, i) => list.findIndex((x) => x.clusterIndex === a.clusterIndex) === i);
};
const WORLD_LEADERS = leaders(null);

type Item = ReturnType<typeof leaders>[number];
/** The wire answer for one page of `list`, in the shape the real query selects. */
function headlinesAnswer(list: readonly Item[], vars: Record<string, any>) {
  const ctx = { origin: 'http://localhost', now: Date.now() };
  const page = pageOf(list, vars.first, vars.after);
  return {
    topHeadlinesForCountry: {
      __typename: 'TopHeadlinesForCountryResponse',
      articles: page.items.map((a) => newsArticle(a, ctx)),
      headlines: page.items.map((a) => ({
        __typename: 'TopHeadline',
        stableClusterId: stableClusterId(a),
        clusterSize: 1,
        article: newsArticle(a, ctx),
      })),
      pageInfo: page.pageInfo,
      editionBuiltAt: new Date(ctx.now).toISOString(),
    },
  };
}

/** Every request the mock receives for these operations, with its variables. */
function record(...ops: string[]) {
  const sent: { op: string; vars: Record<string, any> }[] = [];
  server.use(
    graphql.operation(({ operationName, variables }) => {
      if (ops.includes(operationName)) sent.push({ op: operationName, vars: variables });
      return undefined; // observe only; the next handler answers
    }),
  );
  return sent;
}

const render = (scope: ExploreScope, windowHours?: number) =>
  renderHookInScreen(() => useScopeArticleList({ scope, enabled: true, windowHours }));
const ids = (r: { current: { headlines: { article: { _id: string } }[] } }) => r.current.headlines.map((h) => h.article._id);

/** Strict-clock settle: step fake time and one real event-loop turn per step, inside act so React
 *  flushes, until `cond()` holds. (advanceUntil outside act would leave state updates unflushed.) */
async function settleUntil(cond: () => boolean, steps = 200): Promise<void> {
  for (let i = 0; i < steps && !cond(); i++) {
    await act(async () => {
      await jest.advanceTimersByTimeAsync(50);
      await new Promise<void>((resolve) => setImmediate(resolve));
    });
  }
  if (!cond()) throw new Error('settleUntil: condition not met');
}

// Everything below except the topic-filter block runs against a server without worldHeadlines,
// so these tests keep pinning the country/windowed documents the old-server fallback sends.
beforeEach(() => {
  __resetExploreWindowSupport();
  __resetWorldTopicsSupport();
  server.use(mockGqlError('GetWorldHeadlines', 'GRAPHQL_VALIDATION_FAILED', { message: 'Cannot query field "worldHeadlines"' }));
});

describe('first page', () => {
  it('loads a country scope: that country\'s story leaders, in the request for its alpha-3 code', async () => {
    const sent = record('GetTopHeadlinesForCountry');
    const { result } = render(NLD);
    expect(result.current.isLoading).toBe(true);
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(ids(result)).toEqual(leaders('NLD').map((a) => a.id));
    expect(sent[0].vars).toMatchObject({ countryCode: 'NLD', first: 10 });
    expect(result.current.loadFailed).toBe(false);
  });

  it('loads World with the GLOBAL sentinel mapped to a null country, first page only', async () => {
    const sent = record('GetTopHeadlinesForCountry');
    const { result } = render(WORLD);
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(sent[0].vars.countryCode).toBeNull();
    expect(ids(result)).toEqual(WORLD_LEADERS.slice(0, 10).map((a) => a.id));
  });

  it('an empty answer gives an empty list with isLoading false at once, and no failure', async () => {
    server.use(mockGql('GetTopHeadlinesForCountry', (v) => headlinesAnswer([], v)));
    const { result } = render(WORLD);
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.headlines).toEqual([]);
    expect(result.current.loadFailed).toBe(false);
    expect(result.current.isRefreshing).toBe(false);
  });

  it('a failed load is loadFailed, not an empty success', async () => {
    server.use(mockGqlError('GetTopHeadlinesForCountry', 'INTERNAL_SERVER_ERROR'));
    const { result } = render(WORLD);
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.headlines).toEqual([]);
    expect(result.current.loadFailed).toBe(true);
  });
});

describe('paging', () => {
  it('loadMore appends the next page', async () => {
    const { result } = render(WORLD);
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    await act(async () => {
      await result.current.loadMore();
    });
    expect(ids(result)).toEqual(WORLD_LEADERS.map((a) => a.id));
  });

  it('an article id repeated across pages renders once', async () => {
    // The edition was rebuilt between the two requests: page 2 re-serves page 1's last row.
    server.use(
      mockGql('GetTopHeadlinesForCountry', (v) =>
        v.after ? headlinesAnswer(WORLD_LEADERS.slice(9), { first: 10 }) : headlinesAnswer(WORLD_LEADERS, v),
      ),
    );
    const { result } = render(WORLD);
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    await act(async () => {
      await result.current.loadMore();
    });
    const shown = ids(result);
    expect(shown).toHaveLength(WORLD_LEADERS.length);
    expect(new Set(shown).size).toBe(shown.length);
  });

  it('a refresh landing while a paginate is in flight drops the stale page: one run, no duplicates', async () => {
    // The new ranking reorders the first page and keeps the stale page's row (the 11th) off it, so
    // the stale page can only show up as an extra row.
    const reversed = [...WORLD_LEADERS.slice(0, 10).reverse(), WORLD_LEADERS[10]];
    let firstPageCalls = 0;
    server.use(
      mockGql('GetTopHeadlinesForCountry', async (v) => {
        if (v.after) {
          await delay(250); // the paginate is still in flight when the refresh lands
          return headlinesAnswer(WORLD_LEADERS, v);
        }
        // Mount sees the old ranking, the refresh the new one.
        return headlinesAnswer(++firstPageCalls === 1 ? WORLD_LEADERS : reversed, v);
      }),
    );
    const { result } = render(WORLD);
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    let more!: Promise<void>;
    act(() => {
      more = result.current.loadMore();
    });
    await waitFor(() => expect(result.current.isLoadingMore).toBe(true));
    await act(async () => {
      await result.current.onRefresh();
    });
    await act(async () => {
      await more;
    });

    const shown = ids(result);
    expect(shown).toEqual(reversed.slice(0, 10).map((a) => a.id)); // the refreshed page 1 alone
    expect(new Set(shown).size).toBe(shown.length);
    expect(result.current.isLoadingMore).toBe(false);
    expect(result.current.isRefreshing).toBe(false);
  });
});

describe('hung load', () => {
  it('flips loadHung exactly at HUNG_LOAD_MS while the request is still in flight, and the answer still lands', async () => {
    useStrictClock(Date.now());
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    server.use(
      mockGql('GetTopHeadlinesForCountry', async (v) => {
        await held;
        return headlinesAnswer(WORLD_LEADERS, v);
      }),
    );
    const { result } = render(WORLD);
    await act(async () => {
      await jest.advanceTimersByTimeAsync(HUNG_LOAD_MS - 1);
    });
    expect(result.current.isLoading).toBe(true);
    expect(result.current.loadHung).toBe(false);

    await act(async () => {
      await jest.advanceTimersByTimeAsync(1);
    });
    expect(result.current.loadHung).toBe(true);
    expect(result.current.isLoading).toBe(true);

    release();
    await settleUntil(() => !result.current.isLoading);
    expect(ids(result)).toHaveLength(10);
  });

  it('an answer inside the window never flips it', async () => {
    useStrictClock(Date.now());
    const { result } = render(WORLD);
    await settleUntil(() => !result.current.isLoading);
    await act(async () => {
      await jest.advanceTimersByTimeAsync(HUNG_LOAD_MS * 2);
    });
    expect(result.current.loadHung).toBe(false);
  });
});

describe('Explore window (windowHours)', () => {
  const validationFailed = () => mockGqlError('GetTopHeadlinesForCountryWindowed', 'GRAPHQL_VALIDATION_FAILED', { message: 'Unknown argument "windowHours"' });
  const badWindow = () => mockGqlError('GetTopHeadlinesForCountryWindowed', 'BAD_WINDOW', { message: 'bad window' });
  const WINDOW_OPS = ['GetTopHeadlinesForCountryWindowed', 'GetTopHeadlinesForCountry'];

  it('a supported server answers the windowed document with the window', async () => {
    const sent = record(...WINDOW_OPS);
    const { result } = render(WORLD, 12);
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(sent.map((s) => s.op)).toEqual(['GetTopHeadlinesForCountryWindowed']);
    expect(sent[0].vars.windowHours).toBe(12);
    expect(ids(result)).toHaveLength(10);
  });

  it('GRAPHQL_VALIDATION_FAILED falls back to the plain document and stays latched for later loads', async () => {
    server.use(validationFailed());
    const sent = record(...WINDOW_OPS);
    const first = render(WORLD, 12);
    await waitFor(() => expect(first.result.current.isLoading).toBe(false));
    expect(sent.map((s) => s.op)).toEqual(['GetTopHeadlinesForCountryWindowed', 'GetTopHeadlinesForCountry']);
    expect(ids(first.result)).toHaveLength(10);
    expect(first.result.current.loadFailed).toBe(false);

    // A later load, even for another window, goes straight to the plain document.
    sent.length = 0;
    const second = render(NLD, 6);
    await waitFor(() => expect(second.result.current.isLoading).toBe(false));
    expect(sent.map((s) => s.op)).toEqual(['GetTopHeadlinesForCountry']);
    expect(ids(second.result)).toEqual(leaders('NLD').map((a) => a.id));
  });

  it('BAD_WINDOW falls back for that request only: the next load tries the windowed document again', async () => {
    server.use(badWindow());
    const sent = record(...WINDOW_OPS);
    const first = render(WORLD, 6);
    await waitFor(() => expect(first.result.current.isLoading).toBe(false));
    expect(sent.map((s) => s.op)).toEqual(['GetTopHeadlinesForCountryWindowed', 'GetTopHeadlinesForCountry']);
    expect(ids(first.result)).toHaveLength(10);

    sent.length = 0;
    const second = render(WORLD, 24);
    await waitFor(() => expect(second.result.current.isLoading).toBe(false));
    expect(sent.map((s) => s.op)).toEqual(['GetTopHeadlinesForCountryWindowed', 'GetTopHeadlinesForCountry']);
  });

  it('any other error on the windowed document is a failed load, with no fallback request', async () => {
    server.use(mockGqlError('GetTopHeadlinesForCountryWindowed', 'INTERNAL_SERVER_ERROR'));
    const sent = record(...WINDOW_OPS);
    const { result } = render(WORLD, 12);
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(sent.map((s) => s.op)).toEqual(['GetTopHeadlinesForCountryWindowed']);
    expect(result.current.loadFailed).toBe(true);
  });
});

describe('topic filter (worldHeadlines)', () => {
  beforeEach(() => {
    server.resetHandlers(); // drop the old-server handler above: the mock backend serves worldHeadlines
  });

  it('returns the facets and marks topics supported', async () => {
    const { result } = render(WORLD, 24);
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.topicsSupported).toBe(true);
    expect(result.current.facets).toEqual([{ __typename: 'CanonicalTopicFacet', topicId: 'ct-politics', count: WORLD_LEADERS.length }]);
    expect(ids(result)).toHaveLength(10);
  });

  it('sends the picked topic id and lists only its stories', async () => {
    const sent = record('GetWorldHeadlines');
    const { result } = renderHookInScreen(() => useScopeArticleList({ scope: WORLD, enabled: true, topicId: 'ct-politics' }));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(sent[0].vars.canonicalTopicIds).toEqual(['ct-politics']);
    expect(ids(result)).toHaveLength(10);
  });

  it('an id the server does not know matches nothing', async () => {
    const { result } = renderHookInScreen(() => useScopeArticleList({ scope: WORLD, enabled: true, topicId: 'nope' }));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(ids(result)).toEqual([]);
    expect(result.current.loadFailed).toBe(false);
  });

  it('sends no canonicalTopicIds without a pick', async () => {
    const sent = record('GetWorldHeadlines');
    const { result } = render(WORLD);
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(sent[0].vars.canonicalTopicIds ?? null).toBeNull();
  });
});
