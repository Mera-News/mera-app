// usePublicationArticles: the news list on the publication page. One
// publisher's articles across all its feeds, paged by cursor, in the order the
// page's switch picks (Latest = NEWEST, or TOP_HEADLINES).
//
// - Starts the moment the publisher id is known; it never waits on the
//   profile request.
// - A failed first page is `error` (the page offers Try again, which is
//   `refresh`); a failed next page is `loadMoreState: 'error'` and leaves the
//   list in place (the footer's Try again is `loadMore`).
// - Offline (the device link is down, decided before asking), it shows this
//   publication's articles already on the device: feed rows whose source name
//   is one of `sourceNames`. That list is complete as it stands (`hasMore`
//   false) and is replaced by the server's once the link returns.
// - A server that predates `order` answers top headlines to a NEWEST request
//   (ArticleService falls back once per session); `orderApplied` says so.
//
// The network and device reads are PORTS (tests pass their own); the defaults
// require Apollo, the database and NetInfo lazily.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { NewsArticle } from '@/lib/generated/graphql-types';
import type { PublisherArticleOrder, PublisherArticlesPage } from '@/lib/article-service';

export type { PublisherArticleOrder };

export type PublicationArticlesState = 'idle' | 'loading' | 'ready' | 'error' | 'offline';
export type PublicationArticlesLoadMoreState = 'idle' | 'loading' | 'error';

export interface PublicationArticlesPorts {
  fetchPage(
    publisherId: string,
    order: PublisherArticleOrder,
    after: string | undefined,
    first: number,
  ): Promise<PublisherArticlesPage>;
  /** This publication's on-device articles, newest first. */
  loadLocal(names: readonly string[]): Promise<NewsArticle[]>;
  isOffline(): boolean;
  onReconnect(listener: () => void): () => void;
}

export interface UsePublicationArticlesOptions {
  /** Every source name of the publication (profile `sourceNames`, or what the
   *  entry point knows). Only used for the offline list. */
  sourceNames?: readonly string[] | null;
  /** Articles per page. */
  pageSize?: number;
}

export interface PublicationArticlesResult {
  articles: NewsArticle[];
  /** `idle`: no publisher id yet and online (nothing to ask for). */
  state: PublicationArticlesState;
  loadMoreState: PublicationArticlesLoadMoreState;
  hasMore: boolean;
  /** False when the server ignored a NEWEST request (older server). */
  orderApplied: boolean;
  /** True while showing the on-device list. */
  isLocal: boolean;
  /** True during a pull-to-refresh over an already-loaded list. */
  refreshing: boolean;
  /** Next page. Also the load-more error footer's Try again. */
  loadMore: () => void;
  /** First page again, keeping the list on screen meanwhile. Also the
   *  first-load error's Try again. */
  refresh: () => Promise<void>;
}

export const PUBLICATION_ARTICLES_PAGE_SIZE = 20;

export const defaultPublicationArticlesPorts: PublicationArticlesPorts = {
  fetchPage: (publisherId, order, after, first) => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { ArticleService } = require('@/lib/article-service') as typeof import('@/lib/article-service');
    return ArticleService.getArticlesForPublisher(publisherId, { first, after, order });
  },
  loadLocal: (names) => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const local = require('@/lib/database/services/publication-local-articles') as typeof import('@/lib/database/services/publication-local-articles');
    return local.getLocalArticlesForPublication(names);
  },
  isOffline: () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { useNetworkStore } = require('@/lib/stores/network-store') as typeof import('@/lib/stores/network-store');
    return useNetworkStore.getState().isConnected === false;
  },
  onReconnect: (listener) => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { useNetworkStore } = require('@/lib/stores/network-store') as typeof import('@/lib/stores/network-store');
    return useNetworkStore.subscribe((s, prev) => {
      if (s.isConnected === true && prev.isConnected === false) listener();
    });
  },
};

function appendUnique(list: NewsArticle[], page: readonly NewsArticle[]): NewsArticle[] {
  const seen = new Set(list.map((a) => a._id));
  const out = list.slice();
  for (const a of page) {
    if (!a?._id || seen.has(a._id)) continue;
    seen.add(a._id);
    out.push(a);
  }
  return out;
}

/** The hook factory, so tests can pass their own ports. */
export function makeUsePublicationArticles(ports: PublicationArticlesPorts) {
  return function usePublicationArticlesWith(
    publisherId: string | null | undefined,
    order: PublisherArticleOrder,
    options?: UsePublicationArticlesOptions,
  ): PublicationArticlesResult {
    const pageSize = options?.pageSize ?? PUBLICATION_ARTICLES_PAGE_SIZE;
    // A stable dependency for the name list: a new array each render must not
    // refetch. The effect rebuilds the list from it.
    const namesKey = (options?.sourceNames ?? []).join('\u0000');

    const [articles, setArticles] = useState<NewsArticle[]>([]);
    const [state, setState] = useState<PublicationArticlesState>(publisherId ? 'loading' : 'idle');
    const [loadMoreState, setLoadMoreState] = useState<PublicationArticlesLoadMoreState>('idle');
    const [hasMore, setHasMore] = useState(false);
    const [orderApplied, setOrderApplied] = useState(true);
    const [isLocal, setIsLocal] = useState(false);
    const [refreshing, setRefreshing] = useState(false);
    const [attempt, setAttempt] = useState(0);

    // Every request carries the generation it was made in; a newer key,
    // order or retry makes older answers land nowhere.
    const generationRef = useRef(0);
    const cursorRef = useRef<string | undefined>(undefined);
    const loadingMoreRef = useRef(false);

    const showLocal = useCallback(async (generation: number, names: readonly string[]) => {
      let local: NewsArticle[] = [];
      try {
        local = names.length > 0 ? await ports.loadLocal(names) : [];
      } catch {
        local = [];
      }
      if (generationRef.current !== generation) return;
      setArticles(local);
      setHasMore(false);
      setIsLocal(true);
      setState('offline');
    }, []);

    useEffect(() => {
      const generation = ++generationRef.current;
      const names = namesKey ? namesKey.split('\u0000') : [];
      cursorRef.current = undefined;
      loadingMoreRef.current = false;
      setLoadMoreState('idle');
      setRefreshing(false);
      if (ports.isOffline()) {
        void showLocal(generation, names);
        return;
      }
      if (!publisherId) {
        setArticles([]);
        setHasMore(false);
        setIsLocal(false);
        setState('idle');
        return;
      }
      setArticles([]);
      setIsLocal(false);
      setState('loading');
      ports
        .fetchPage(publisherId, order, undefined, pageSize)
        .then((page) => {
          if (generationRef.current !== generation) return;
          cursorRef.current = page.pageInfo?.endCursor ?? undefined;
          setArticles(appendUnique([], page.articles ?? []));
          setHasMore(!!page.pageInfo?.hasNextPage && !!page.pageInfo?.endCursor);
          setOrderApplied(page.orderApplied);
          setState('ready');
        })
        .catch(() => {
          if (generationRef.current !== generation) return;
          if (ports.isOffline()) {
            void showLocal(generation, names);
            return;
          }
          setState('error');
        });
      // namesKey: the offline list depends on the names.
    }, [publisherId, order, pageSize, namesKey, attempt, showLocal]);

    // Offline is left by itself when the link comes back.
    useEffect(() => {
      if (state !== 'offline') return;
      return ports.onReconnect(() => setAttempt((a) => a + 1));
    }, [state]);

    const loadMore = useCallback(() => {
      if (!publisherId || state !== 'ready' || !hasMore || loadingMoreRef.current) return;
      const generation = generationRef.current;
      loadingMoreRef.current = true;
      setLoadMoreState('loading');
      ports
        .fetchPage(publisherId, order, cursorRef.current, pageSize)
        .then((page) => {
          if (generationRef.current !== generation) return;
          cursorRef.current = page.pageInfo?.endCursor ?? undefined;
          setArticles((prev) => appendUnique(prev, page.articles ?? []));
          setHasMore(!!page.pageInfo?.hasNextPage && !!page.pageInfo?.endCursor);
          setLoadMoreState('idle');
        })
        .catch(() => {
          if (generationRef.current !== generation) return;
          setLoadMoreState('error');
        })
        .finally(() => {
          if (generationRef.current === generation) loadingMoreRef.current = false;
        });
    }, [publisherId, order, pageSize, state, hasMore]);

    const refresh = useCallback(async () => {
      // Nothing loaded to keep on screen (first load failed, offline, idle):
      // start over, which shows the loading state.
      if (state !== 'ready' || !publisherId || ports.isOffline()) {
        setAttempt((a) => a + 1);
        return;
      }
      const generation = ++generationRef.current;
      loadingMoreRef.current = false;
      setLoadMoreState('idle');
      setRefreshing(true);
      try {
        const page = await ports.fetchPage(publisherId, order, undefined, pageSize);
        if (generationRef.current !== generation) return;
        cursorRef.current = page.pageInfo?.endCursor ?? undefined;
        setArticles(appendUnique([], page.articles ?? []));
        setHasMore(!!page.pageInfo?.hasNextPage && !!page.pageInfo?.endCursor);
        setOrderApplied(page.orderApplied);
      } catch {
        // A failed refresh keeps the list the reader already has.
      } finally {
        if (generationRef.current === generation) setRefreshing(false);
      }
    }, [publisherId, order, pageSize, state]);

    return { articles, state, loadMoreState, hasMore, orderApplied, isLocal, refreshing, loadMore, refresh };
  };
}

/**
 * The publication page's news list. `publisherId` null (not resolved yet, not
 * found, or an older server) asks for nothing online; offline it still shows
 * the on-device articles for `options.sourceNames`.
 */
export const usePublicationArticles = makeUsePublicationArticles(defaultPublicationArticlesPorts);
