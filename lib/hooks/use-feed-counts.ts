// use-feed-counts — the shared "N published / M analysed / K relevant" counters
// for the last 24h, extracted from ForYouScreen so both the Dashboard header
// (FeedStatusShimmer/Sheet) and the new Feed tab's stats sentence read ONE
// source of truth.
//
// `articleCount` (total published this cycle) comes from the for-you store
// (written by the FeedSyncMachine). `analysedCount`/`relevantCount` are derived
// from the live scored suggestions in the 24h window.

import { useMemo } from 'react';
import { ArticleSuggestionStatus } from '@/lib/database/article-suggestion-status';
import { useForYouCounts, useForYouSuggestions } from '@/lib/stores/selectors';

const FEED_WINDOW_MS = 24 * 60 * 60 * 1000;
/** A scored suggestion counts as "relevant" above this bar (mirrors the feed). */
const RELEVANT_GATE = 0.3;

export interface FeedCounts {
  /** Total articles published this cycle (store-tracked). */
  articleCount: number;
  /** Scored suggestions in the last 24h. */
  analysedCount: number;
  /** Scored suggestions in the last 24h with relevance above the gate. */
  relevantCount: number;
}

export function useFeedCounts(): FeedCounts {
  const suggestions = useForYouSuggestions();
  const { articleCount } = useForYouCounts();

  const { analysedCount, relevantCount } = useMemo(() => {
    const cutoffMs = Date.now() - FEED_WINDOW_MS;
    let analysed = 0;
    let relevant = 0;
    for (const s of suggestions) {
      if (s.status === ArticleSuggestionStatus.Unscored) continue;
      const pt = Date.parse(s.firstPubDate);
      if (!Number.isFinite(pt) || pt < cutoffMs) continue;
      analysed++;
      if (s.relevance > RELEVANT_GATE) relevant++;
    }
    return { analysedCount: analysed, relevantCount: relevant };
  }, [suggestions]);

  return { articleCount, analysedCount, relevantCount };
}
