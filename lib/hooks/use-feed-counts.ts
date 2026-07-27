// use-feed-counts — the shared "N published / M analysed / K relevant" counters
// for the last 48h, extracted from ForYouScreen so both the Dashboard header
// (FeedStatusShimmer/Sheet) and the new Feed tab's stats sentence read ONE
// source of truth.
//
// `articleCount` (total published this cycle) comes from the for-you store
// (written by the FeedSyncMachine). `analysedCount`/`relevantCount` are derived
// from the live scored suggestions in the 48h window (P5c — widened from 24h
// to match the 48h storage TTL and score-propagation lookback below).
//
// NOTE: the two windows differ ON PURPOSE and the UI copy reflects only the
// first. `articleCount` is the SERVER's recentArticleCount, a hard 24h count
// (CUTOFF_HOURS = 24 in mera-server articles-for-topics.service.ts), so the
// "…published in the last 24 hours" in feed.analysedArticles is correct and
// qualifies that number alone. Do not "fix" that string to 48h to match the
// constant below — analysed/relevant carry no stated window.

import { useMemo } from 'react';
import { ArticleSuggestionStatus } from '@/lib/database/article-suggestion-status';
import { SCORE_PROPAGATION_LOOKBACK_MS } from '@/lib/feed-grouping/story-grouping';
import { useForYouCounts, useForYouSuggestions } from '@/lib/stores/selectors';

// Was 24h; storage TTL (SUGGESTION_TTL_MS, lib/scheduler/tasks/data-cleanup-task.ts)
// and score-propagation lookback (SCORE_PROPAGATION_LOOKBACK_MS, imported below)
// are both 48h, so a 24h counter window made anything in the 24-48h band that
// storage kept invisible to the "N analysed" count — part of why a user saw
// "4 articles were analysed for you" despite far more sitting in local
// storage. Reusing the already-exported SCORE_PROPAGATION_LOOKBACK_MS keeps
// this window in step with that constant without a second hardcoded copy;
// keep it in step with SUGGESTION_TTL_MS too (not exported, currently 48h).
const FEED_WINDOW_MS = SCORE_PROPAGATION_LOOKBACK_MS;
/** A scored suggestion counts as "relevant" above this bar (mirrors the feed). */
const RELEVANT_GATE = 0.3;

export interface FeedCounts {
  /** Total articles published this cycle (store-tracked). */
  articleCount: number;
  /** Scored suggestions in the last 48h. */
  analysedCount: number;
  /** Scored suggestions in the last 48h with relevance above the gate. */
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
