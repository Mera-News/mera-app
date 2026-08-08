// useNewsSearch — debounced state machine for Explore's search bar (Item 12a).
//
// Owns the query text, the debounced/min-length-gated fetch, and an
// out-of-order-response guard, so ExploreScreen and its search UI can stay
// presentational. Mirrors SourcesL1CountryList's publisher-search effect
// (debounce + 2-char floor + monotonic request id) rather than the generic
// `useDebouncedValue` hook: that hook debounces the VALUE, which would still
// flash stale results while a user is mid-delete back below the minimum
// length. Here, dropping below the minimum clears the panel immediately —
// only the actual network fetch is debounced.
//
// Never throws out of the hook: `searchNews` itself never rejects (see
// search-news-service.ts), and the `.catch` below is defence in depth only.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { NewsSearchHit } from '@/lib/generated/graphql-types';
import logger from '@/lib/logger';
import {
  SEARCH_NEWS_MIN_QUERY_LENGTH,
  searchNews,
  type NewsSearchErrorKind,
} from './search-news-service';

/** Trailing-edge debounce window before a query fires. */
export const NEWS_SEARCH_DEBOUNCE_MS = 300;

export type NewsSearchStatus = 'idle' | 'loading' | 'success' | 'error';

export interface UseNewsSearchResult {
  /** Raw, unedited input text. */
  readonly query: string;
  readonly setQuery: (next: string) => void;
  /** Clears the query and returns the hook to its idle, pre-search state. */
  readonly clear: () => void;
  readonly status: NewsSearchStatus;
  readonly hits: NewsSearchHit[];
  /** Populated only when `status === 'error'`. */
  readonly errorKind: NewsSearchErrorKind | null;
  /**
   * Re-runs the search for the current query immediately, bypassing the
   * debounce — the error state's "try again" action. A no-op below the
   * minimum length (nothing to retry).
   */
  readonly retry: () => void;
  /**
   * True as soon as the user has typed anything — the trimmed query need not
   * yet meet the server's minimum length. The screen uses this to decide
   * whether to show the search panel at all vs. its normal scope-chip content;
   * `status` alone can't answer that because `status` stays `'idle'` for a
   * one-character query too.
   */
  readonly isActive: boolean;
}

export function useNewsSearch(debounceMs: number = NEWS_SEARCH_DEBOUNCE_MS): UseNewsSearchResult {
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<NewsSearchStatus>('idle');
  const [hits, setHits] = useState<NewsSearchHit[]>([]);
  const [errorKind, setErrorKind] = useState<NewsSearchErrorKind | null>(null);

  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Monotonic id — guards against a slow, now-superseded response landing
  // after a faster later one and clobbering it (classic debounced-typing race).
  const requestIdRef = useRef(0);

  const trimmed = query.trim();

  // Fires the actual fetch and lands its result — shared by the debounced
  // effect below and by `retry`, which calls it directly with a fresh
  // request id to skip the debounce.
  const runSearch = useCallback((q: string, requestId: number) => {
    searchNews(q)
      .then((result) => {
        if (requestIdRef.current !== requestId) return; // superseded
        if (result.ok) {
          setHits(result.hits);
          setStatus('success');
        } else {
          setHits([]);
          setErrorKind(result.kind);
          setStatus('error');
        }
      })
      .catch((error: unknown) => {
        if (requestIdRef.current !== requestId) return;
        logger.captureException(error, {
          tags: { hook: 'use-news-search', method: 'searchNews' },
        });
        setHits([]);
        setErrorKind('unknown');
        setStatus('error');
      });
  }, []);

  useEffect(() => {
    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);

    if (trimmed.length < SEARCH_NEWS_MIN_QUERY_LENGTH) {
      // Invalidate any in-flight request so a stale response can't land after
      // the user has already backed out of search — no debounce here, the
      // panel should clear the instant the floor is crossed downward.
      requestIdRef.current += 1;
      setStatus('idle');
      setHits([]);
      setErrorKind(null);
      return;
    }

    setStatus('loading');
    setErrorKind(null);

    const requestId = (requestIdRef.current += 1);
    const timer = setTimeout(() => runSearch(trimmed, requestId), debounceMs);
    debounceTimerRef.current = timer;

    // `timer` (not the ref) — the ref was JUST assigned above, so it is
    // provably still set at this point; closing over the local avoids an
    // always-true null check.
    return () => clearTimeout(timer);
  }, [trimmed, debounceMs, runSearch]);

  const clear = useCallback(() => setQuery(''), []);

  const retry = useCallback(() => {
    if (trimmed.length < SEARCH_NEWS_MIN_QUERY_LENGTH) return;
    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    setStatus('loading');
    setErrorKind(null);
    const requestId = (requestIdRef.current += 1);
    runSearch(trimmed, requestId);
  }, [trimmed, runSearch]);

  return {
    query,
    setQuery,
    clear,
    status,
    hits,
    errorKind,
    retry,
    isActive: trimmed.length > 0,
  };
}

export default useNewsSearch;
