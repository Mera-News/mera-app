// usePublicationArticles over injected ports: first page, load more (and its
// own error), refresh keeping the list, offline on-device list, stale answers.

import { renderHook, act, waitFor } from '@testing-library/react-native';
import {
  makeUsePublicationArticles,
  type PublicationArticlesPorts,
  type PublisherArticleOrder,
} from '../use-publication-articles';
import type { NewsArticle } from '@/lib/generated/graphql-types';

const art = (id: string) => ({ _id: id, title: id }) as unknown as NewsArticle;
const page = (ids: string[], endCursor: string | null, hasNextPage = !!endCursor, orderApplied = true) => ({
  articles: ids.map(art),
  pageInfo: { endCursor, hasNextPage, pageSize: 20 },
  orderApplied,
});

function makePorts(overrides: Partial<PublicationArticlesPorts> = {}) {
  let reconnect: (() => void) | null = null;
  const ports: PublicationArticlesPorts = {
    fetchPage: jest.fn(async () => page(['a', 'b'], 'c1')),
    loadLocal: jest.fn(async () => [art('local-1')]),
    isOffline: jest.fn(() => false),
    onReconnect: jest.fn((l: () => void) => {
      reconnect = l;
      return () => {
        reconnect = null;
      };
    }),
    ...overrides,
  };
  return { ports, fireReconnect: () => reconnect?.() };
}

const ids = (list: NewsArticle[]) => list.map((a) => a._id);

describe('usePublicationArticles', () => {
  it('starts on the publisher id alone and loads the first page', async () => {
    const { ports } = makePorts();
    const use = makeUsePublicationArticles(ports);
    const { result } = renderHook(() => use('p1', 'NEWEST'));
    expect(result.current.state).toBe('loading');
    await waitFor(() => expect(result.current.state).toBe('ready'));
    expect(ids(result.current.articles)).toEqual(['a', 'b']);
    expect(result.current.hasMore).toBe(true);
    expect(ports.fetchPage).toHaveBeenCalledWith('p1', 'NEWEST', undefined, 20);
  });

  it('without a publisher id and online it asks for nothing', async () => {
    const { ports } = makePorts();
    const use = makeUsePublicationArticles(ports);
    const { result } = renderHook(() => use(null, 'NEWEST', { sourceNames: ['X'] }));
    await waitFor(() => expect(result.current.state).toBe('idle'));
    expect(ports.fetchPage).not.toHaveBeenCalled();
  });

  it('load more appends by cursor, deduping by id, and stops at the end', async () => {
    const fetchPage = jest
      .fn()
      .mockResolvedValueOnce(page(['a', 'b'], 'c1'))
      .mockResolvedValueOnce(page(['b', 'c'], null));
    const { ports } = makePorts({ fetchPage });
    const use = makeUsePublicationArticles(ports);
    const { result } = renderHook(() => use('p1', 'NEWEST'));
    await waitFor(() => expect(result.current.state).toBe('ready'));
    act(() => result.current.loadMore());
    await waitFor(() => expect(ids(result.current.articles)).toEqual(['a', 'b', 'c']));
    expect(fetchPage).toHaveBeenLastCalledWith('p1', 'NEWEST', 'c1', 20);
    expect(result.current.hasMore).toBe(false);
    act(() => result.current.loadMore());
    expect(fetchPage).toHaveBeenCalledTimes(2);
  });

  it('a failed load more keeps the list and has its own error; calling it again retries', async () => {
    const fetchPage = jest
      .fn()
      .mockResolvedValueOnce(page(['a'], 'c1'))
      .mockRejectedValueOnce(new Error('500'))
      .mockResolvedValueOnce(page(['b'], null));
    const { ports } = makePorts({ fetchPage });
    const use = makeUsePublicationArticles(ports);
    const { result } = renderHook(() => use('p1', 'TOP_HEADLINES'));
    await waitFor(() => expect(result.current.state).toBe('ready'));
    act(() => result.current.loadMore());
    await waitFor(() => expect(result.current.loadMoreState).toBe('error'));
    expect(result.current.state).toBe('ready');
    expect(ids(result.current.articles)).toEqual(['a']);
    act(() => result.current.loadMore());
    await waitFor(() => expect(ids(result.current.articles)).toEqual(['a', 'b']));
    expect(result.current.loadMoreState).toBe('idle');
  });

  it('a failed first page is error; refresh starts over', async () => {
    const fetchPage = jest.fn().mockRejectedValueOnce(new Error('500')).mockResolvedValueOnce(page(['a'], null));
    const { ports } = makePorts({ fetchPage });
    const use = makeUsePublicationArticles(ports);
    const { result } = renderHook(() => use('p1', 'NEWEST'));
    await waitFor(() => expect(result.current.state).toBe('error'));
    await act(async () => {
      await result.current.refresh();
    });
    await waitFor(() => expect(result.current.state).toBe('ready'));
    expect(ids(result.current.articles)).toEqual(['a']);
  });

  it('pull to refresh keeps the list on screen and keeps it when the refresh fails', async () => {
    let resolveRefresh: (v: ReturnType<typeof page>) => void = () => {};
    const fetchPage = jest
      .fn()
      .mockResolvedValueOnce(page(['a'], null))
      .mockImplementationOnce(() => new Promise((r) => (resolveRefresh = r)))
      .mockRejectedValueOnce(new Error('500'));
    const { ports } = makePorts({ fetchPage });
    const use = makeUsePublicationArticles(ports);
    const { result } = renderHook(() => use('p1', 'NEWEST'));
    await waitFor(() => expect(result.current.state).toBe('ready'));
    let pending: Promise<void> = Promise.resolve();
    act(() => {
      pending = result.current.refresh();
    });
    expect(result.current.refreshing).toBe(true);
    expect(ids(result.current.articles)).toEqual(['a']);
    await act(async () => {
      resolveRefresh(page(['n', 'a'], null));
      await pending;
    });
    expect(result.current.refreshing).toBe(false);
    expect(ids(result.current.articles)).toEqual(['n', 'a']);
    await act(async () => {
      await result.current.refresh();
    });
    expect(ids(result.current.articles)).toEqual(['n', 'a']);
    expect(result.current.state).toBe('ready');
  });

  it('switching the order restarts the list at the top', async () => {
    const fetchPage = jest.fn(async (_p: string, order: PublisherArticleOrder) =>
      order === 'NEWEST' ? page(['new'], null) : page(['top'], null),
    );
    const { ports } = makePorts({ fetchPage });
    const use = makeUsePublicationArticles(ports);
    const { result, rerender } = renderHook((o: PublisherArticleOrder) => use('p1', o), { initialProps: 'NEWEST' });
    await waitFor(() => expect(ids(result.current.articles)).toEqual(['new']));
    rerender('TOP_HEADLINES');
    await waitFor(() => expect(ids(result.current.articles)).toEqual(['top']));
  });

  it('a stale answer for the previous order never lands', async () => {
    let resolveFirst: (v: ReturnType<typeof page>) => void = () => {};
    const fetchPage = jest
      .fn()
      .mockImplementationOnce(() => new Promise((r) => (resolveFirst = r)))
      .mockResolvedValueOnce(page(['top'], null));
    const { ports } = makePorts({ fetchPage });
    const use = makeUsePublicationArticles(ports);
    const { result, rerender } = renderHook((o: PublisherArticleOrder) => use('p1', o), { initialProps: 'NEWEST' });
    rerender('TOP_HEADLINES');
    await waitFor(() => expect(ids(result.current.articles)).toEqual(['top']));
    await act(async () => resolveFirst(page(['stale'], null)));
    expect(ids(result.current.articles)).toEqual(['top']);
  });

  it('reports when an older server ignored NEWEST', async () => {
    const { ports } = makePorts({ fetchPage: jest.fn(async () => page(['a'], null, false, false)) });
    const { result } = renderHook(() => makeUsePublicationArticles(ports)('p1', 'NEWEST'));
    await waitFor(() => expect(result.current.state).toBe('ready'));
    expect(result.current.orderApplied).toBe(false);
  });

  it('offline shows the on-device articles for the source names, then the server list once back', async () => {
    let offline = true;
    const { ports, fireReconnect } = makePorts({ isOffline: jest.fn(() => offline) });
    const use = makeUsePublicationArticles(ports);
    const { result } = renderHook(() => use('p1', 'NEWEST', { sourceNames: ['Times of India', 'TOI Business'] }));
    await waitFor(() => expect(result.current.state).toBe('offline'));
    expect(ports.loadLocal).toHaveBeenCalledWith(['Times of India', 'TOI Business']);
    expect(ids(result.current.articles)).toEqual(['local-1']);
    expect(result.current.isLocal).toBe(true);
    expect(result.current.hasMore).toBe(false);
    expect(ports.fetchPage).not.toHaveBeenCalled();
    offline = false;
    act(() => fireReconnect());
    await waitFor(() => expect(result.current.state).toBe('ready'));
    expect(result.current.isLocal).toBe(false);
    expect(ids(result.current.articles)).toEqual(['a', 'b']);
  });

  it('a first page that fails because the link dropped falls back to the on-device list', async () => {
    let offline = false;
    const { ports } = makePorts({
      fetchPage: jest.fn(async () => {
        offline = true;
        throw new Error('network');
      }),
      isOffline: jest.fn(() => offline),
    });
    const { result } = renderHook(() => makeUsePublicationArticles(ports)('p1', 'NEWEST', { sourceNames: ['X'] }));
    await waitFor(() => expect(result.current.state).toBe('offline'));
    expect(ids(result.current.articles)).toEqual(['local-1']);
  });

  it('a new name-list array with the same names does not refetch', async () => {
    const { ports } = makePorts();
    const use = makeUsePublicationArticles(ports);
    const { result, rerender } = renderHook((names: string[]) => use('p1', 'NEWEST', { sourceNames: names }), {
      initialProps: ['A'],
    });
    await waitFor(() => expect(result.current.state).toBe('ready'));
    rerender(['A']);
    await waitFor(() => expect(result.current.state).toBe('ready'));
    expect(ports.fetchPage).toHaveBeenCalledTimes(1);
  });
});
