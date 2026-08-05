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
import {
  passesImportanceThreshold,
  type ImportanceThreshold,
} from '@/lib/feed-ordering/importance-filter';
import { isBreaking, RENDER_GATE } from '@/lib/stores/fact-rows-selector';
import type { ForYouSuggestion } from '@/lib/stores/for-you-store';
import { useOpenedStoriesStore } from '@/lib/stores/opened-stories-store';
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
/** A scored suggestion counts as "relevant" at or above this bar. Imported
 *  rather than copied: this header number sits next to the feed's own count in
 *  the funnel diagnostic, and a silently-diverged private copy would make that
 *  comparison a lie.
 *
 *  RELEVANCE V3 (2026-08-05): `RENDER_GATE` is now INCLUSIVE (`relevance >=
 *  RENDER_GATE`, was strict `>`), so the comparison below matches — see the
 *  comment there. */
const RELEVANT_GATE = RENDER_GATE;

export interface FeedCounts {
  /** Total articles published this cycle (store-tracked). */
  articleCount: number;
  /** Scored suggestions in the last 48h. */
  analysedCount: number;
  /** Scored suggestions in the last 48h with relevance above the gate. */
  relevantCount: number;
  /** Of those relevant ones, how many the reader has actually opened. A subset
   *  of `relevantCount` by construction — a row the user opened but which never
   *  cleared the relevance gate was never offered to them as "relevant", so
   *  counting it here would make the sentence's own arithmetic ("K relevant,
   *  you read R") read as a contradiction. */
  readCount: number;
}

export interface ComputeFeedCountsOptions {
  /** Clock injection for tests; defaults to `Date.now()`. */
  nowMs?: number;
  /** Live opened set (article ids only) from `useOpenedStoriesStore`. Omitted
   *  ⇒ `readCount` is 0 rather than an error, so non-UI callers can ask for
   *  just the analysed/relevant pair. */
  openedArticleIds?: ReadonlySet<string>;
  /** Minimum band the SURFACE reading this sentence renders. Defaults to 'low'
   *  — the no-op setting, so every existing caller keeps its exact counts. A
   *  tighter value narrows `relevant`/`read` only, never `analysed`: the number
   *  of stories we looked at does not change because the reader hid some. */
  importanceThreshold?: ImportanceThreshold;
}

/** The minimal row projection the counters read. `rawScore`/`eventType` are here
 *  solely for `isBreaking` (which is exempt from the importance threshold) and
 *  stay optional so callers with a leaner row shape still type-check. */
type FeedCountsRow = {
  status: string;
  firstPubDate: string;
  relevance: number;
  articleId: string;
  rawScore?: number | null;
  eventType?: string | null;
};

/**
 * The pure "analysed / relevant" counters behind the header sentence.
 *
 * Exported so the feed funnel diagnostic can report the EXACT number the user is
 * reading on screen next to the feed's own much tighter gate (24h + `complete`
 * only). Re-deriving it there would risk the two silently diverging, which would
 * make the whole "header says 90, feed shows 23" reconciliation a lie.
 */
export function computeFeedCounts(
  suggestions: FeedCountsRow[],
  opts?: ComputeFeedCountsOptions,
): { analysedCount: number; relevantCount: number; readCount: number } {
  const cutoffMs = (opts?.nowMs ?? Date.now()) - FEED_WINDOW_MS;
  const opened = opts?.openedArticleIds;
  const threshold = opts?.importanceThreshold ?? 'low';
  let analysed = 0;
  let relevant = 0;
  let read = 0;
  for (const s of suggestions) {
    if (s.status === ArticleSuggestionStatus.Unscored) continue;
    const pt = Date.parse(s.firstPubDate);
    if (!Number.isFinite(pt) || pt < cutoffMs) continue;
    analysed++;
    // Same two-part rule the Feed list applies (`filterByImportance`): band, or
    // breaking regardless of band. `isBreaking` reads only rawScore/eventType,
    // hence the downcast rather than a second copy of the rule here.
    // `>=`, not `>`: RENDER_GATE is inclusive as of relevance v3 (see the
    // comment on `RELEVANT_GATE` above) — a strict comparison here would silently
    // undercount the header relative to what the feed itself renders.
    if (
      s.relevance >= RELEVANT_GATE &&
      (passesImportanceThreshold(s.relevance, threshold) ||
        isBreaking(s as ForYouSuggestion))
    ) {
      relevant++;
      if (opened?.has(s.articleId)) read++;
    }
  }
  return { analysedCount: analysed, relevantCount: relevant, readCount: read };
}

export function useFeedCounts(importanceThreshold?: ImportanceThreshold): FeedCounts {
  const suggestions = useForYouSuggestions();
  const { articleCount } = useForYouCounts();
  // Subscribed, not read via getState(): every open replaces the Set (see
  // `markOpened`), so this identity change is what re-renders the sentence's
  // read count the moment the reader opens a story.
  const openedArticleIds = useOpenedStoriesStore((s) => s.articleIds);

  const { analysedCount, relevantCount, readCount } = useMemo(
    () => computeFeedCounts(suggestions, { openedArticleIds, importanceThreshold }),
    [suggestions, openedArticleIds, importanceThreshold],
  );

  return { articleCount, analysedCount, relevantCount, readCount };
}
