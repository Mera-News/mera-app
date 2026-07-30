// use-open-article — the shared "open an article from a list" handler.
//
// Mera scores articles and writes a short reason for each one. Until now every
// list surface pushed `/logged-in/article-detail`, which shows the article but
// never Mera's reason — so from Explore (or any drill-down) there was no way to
// find out WHY a story was picked. This resolves articleId → suggestion id at
// tap time and routes to `/logged-in/suggestion-detail` when that article has a
// readable reason, falling back to the bare article view when it doesn't.
//
// Companion to use-open-suggestion.ts, which is the handler for surfaces that
// ALREADY hold a suggestion. This one is for surfaces that hold only an article.
//
// Deliberately does NOT record an open impression (use-open-suggestion does).
// Impressions drive the Feed's viewed-elimination, so recording one here would
// make merely tapping an Explore card silently evict that story from For You.
// That's a behaviour change, not a missing feature — keep it out.

import { useCallback } from 'react';
import { router } from 'expo-router';
import { getReasonedSuggestionIdForArticle } from '@/lib/database/services/article-suggestion-service';
import logger from '@/lib/logger';

/**
 * Ceiling on how long a tap may wait for the reason lookup before we give up
 * and open the article.
 *
 * Design decision — race, don't block and don't redirect. The lookup is a
 * single indexed WatermelonDB probe (sub-millisecond in practice), but it is
 * unavoidably async, and WatermelonDB serializes work behind whatever else is
 * on the DB queue (a sync pass, a scoring write). Two rejected alternatives:
 *   - Await unconditionally: a contended queue turns a tap into an unbounded
 *     dead-feeling pause.
 *   - Navigate to the article first and `replace` once the lookup lands: no tap
 *     lag, but the reader gets a visible screen swap under their thumb.
 * Racing a timeout keeps ONE navigation, guarantees the tap resolves within a
 * bound that stays under the ~100–150ms "instant" threshold, and degrades to
 * the article view — which is exactly the pre-change behaviour — when the DB is
 * too busy to answer in time.
 */
export const REASON_LOOKUP_TIMEOUT_MS = 120;

export interface OpenArticleOptions {
  /** Server article `_id` — NOT a suggestion id. */
  readonly articleId: string;
  /** Forwarded to article-detail so it resolves related coverage from the same
   *  cluster the card was ranked by. Dropped on the suggestion-detail path:
   *  that route accepts only `articleSuggestionId`, and ArticleSuggestionScreen
   *  derives its own siblings (buildStoryGroups + relatedArticles). */
  readonly stableClusterId?: string | null;
  /** Test seam — see REASON_LOOKUP_TIMEOUT_MS. */
  readonly timeoutMs?: number;
}

/** Resolve `promise`, or `null` if it hasn't settled within `ms`. */
function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  return Promise.race([promise, deadline]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

function pushArticle(articleId: string, stableClusterId?: string | null): void {
  router.push({
    pathname: '/logged-in/article-detail',
    params: stableClusterId ? { articleId, stableClusterId } : { articleId },
  });
}

/**
 * Open an article, preferring the view that shows Mera's reason.
 *
 * Never throws and never leaves a tap unresolved: any lookup failure, timeout
 * or missing/unreadable suggestion falls through to `/logged-in/article-detail`.
 */
export async function openArticle({
  articleId,
  stableClusterId,
  timeoutMs = REASON_LOOKUP_TIMEOUT_MS,
}: OpenArticleOptions): Promise<void> {
  let suggestionId: string | null = null;
  try {
    suggestionId = await withDeadline(
      getReasonedSuggestionIdForArticle(articleId),
      timeoutMs,
    );
  } catch (error) {
    // A broken lookup must cost the reader the reason, never the article.
    logger.captureException(error, {
      tags: { module: 'use-open-article', method: 'getReasonedSuggestionIdForArticle' },
      extra: { articleId },
    });
    suggestionId = null;
  }

  if (suggestionId) {
    router.push({
      pathname: '/logged-in/suggestion-detail',
      params: { articleSuggestionId: suggestionId },
    });
    return;
  }
  pushArticle(articleId, stableClusterId);
}

/**
 * Returns a stable fire-and-forget callback for list `onPress` handlers.
 * Navigation is the only effect, so there is nothing for the caller to await.
 */
export function useOpenArticle(): (options: OpenArticleOptions) => void {
  return useCallback((options: OpenArticleOptions) => {
    void openArticle(options);
  }, []);
}
