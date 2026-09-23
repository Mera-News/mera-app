// use-feed-counts — the shared "N published / M analysed / K relevant" counters
// for the last 48h, extracted from ForYouScreen so every surface that quotes
// them reads ONE source of truth: the Dashboard's stats sentence and status
// sheet, and the status detail panel on both tabs. (The Feed tab's own stats
// sentence was removed — the Feed does not show counts any more; its only
// route to these numbers is opening the status panel.)
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

import { useSyncExternalStore } from 'react';
import { ArticleSuggestionStatus } from '@/lib/database/article-suggestion-status';
import { SCORE_PROPAGATION_LOOKBACK_MS } from '@/lib/feed-grouping/story-grouping';
import { relevancePassesGate } from '@/lib/stores/fact-rows-selector';
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
 *  comment there.
 *
 *  PER-ROW GATE (schema v50): the cutoff is now chosen from each row's own
 *  scorer vintage (`relevancePassesGate`), not from the active flag. This
 *  header sentence counts what the feed renders, so it MUST use the identical
 *  per-row rule — counting at the flag's gate while the feed renders at the
 *  row's gate is precisely the failure the note above warns about, and it is
 *  the documented incident where the header advertised a pile of articles the
 *  feed then silently refused to show. */

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
}

/** The minimal row projection the counters read. `rawScore`/`eventType` are here
 *  optional so callers with a leaner row shape still type-check. They were read
 *  by an `isBreaking` exemption from the importance pill, which is gone; they
 *  stay in the projection because the callers already pass them. */
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
  let analysed = 0;
  let relevant = 0;
  let read = 0;
  for (const s of suggestions) {
    if (s.status === ArticleSuggestionStatus.Unscored) continue;
    const pt = Date.parse(s.firstPubDate);
    if (!Number.isFinite(pt) || pt < cutoffMs) continue;
    analysed++;
    // The render gate, and nothing else. This used to be the gate AND a second
    // term, "clears the reader's importance band, or is breaking regardless of
    // band". That pill is gone, and its floor setting 'low' was `relevance >=
    // 0.4` — the render gate itself — so the second term was already implied by
    // the first at the default and the breaking exemption never fired. Dropping
    // it changes no count.
    // `>=`, not `>`: RENDER_GATE is inclusive as of relevance v3 (see the
    // comment on `RELEVANT_GATE` above) — a strict comparison here would silently
    // undercount the header relative to what the feed itself renders.
    if (relevancePassesGate(s as ForYouSuggestion)) {
      relevant++;
      if (opened?.has(s.articleId)) read++;
    }
  }
  return { analysedCount: analysed, relevantCount: relevant, readCount: read };
}

// ── One shared clock and one shared result ────────────────────────────────
//
// The header sentence, the status panel and the status sheet each call this
// hook. Each used to memoise `computeFeedCounts` against its OWN `Date.now()`,
// taken whenever that instance happened to mount, so two surfaces on screen
// together could draw the 48h window's edge a minute apart and disagree on
// the same suggestions. Now every instance reads ONE minute-floored clock and
// the result is memoised at module level on (suggestions, opened set, minute),
// so any two instances rendered in the same minute return the same object.
//
// A minute is fine-grained enough: the only thing the clock moves is the 48h
// window's edge, and the counts may fall by design as rows age out.
const MINUTE_MS = 60_000;

export function floorToMinute(ms: number): number {
  return Math.floor(ms / MINUTE_MS) * MINUTE_MS;
}

const minuteListeners = new Set<() => void>();
let minuteTimer: ReturnType<typeof setInterval> | null = null;
let lastMinute = floorToMinute(Date.now());

function subscribeMinute(listener: () => void): () => void {
  minuteListeners.add(listener);
  if (minuteTimer === null) {
    // Polls a few times a minute and notifies only when the minute changes,
    // so a suspended-then-resumed app catches up on its next tick.
    minuteTimer = setInterval(() => {
      const m = floorToMinute(Date.now());
      if (m === lastMinute) return;
      lastMinute = m;
      minuteListeners.forEach((l) => l());
    }, 10_000);
  }
  return () => {
    minuteListeners.delete(listener);
    if (minuteListeners.size === 0 && minuteTimer !== null) {
      clearInterval(minuteTimer);
      minuteTimer = null;
    }
  };
}

function minuteSnapshot(): number {
  lastMinute = floorToMinute(Date.now());
  return lastMinute;
}

let memo: {
  suggestions: unknown;
  opened: unknown;
  minute: number;
  result: { analysedCount: number; relevantCount: number; readCount: number };
} | null = null;

/** Exported for tests only: forget the shared result between cases. */
export function resetFeedCountsMemoForTest(): void {
  memo = null;
}

function sharedCounts(
  suggestions: FeedCountsRow[],
  openedArticleIds: ReadonlySet<string>,
  minute: number,
) {
  if (
    memo &&
    memo.suggestions === suggestions &&
    memo.opened === openedArticleIds &&
    memo.minute === minute
  ) {
    return memo.result;
  }
  const result = computeFeedCounts(suggestions, { nowMs: minute, openedArticleIds });
  memo = { suggestions, opened: openedArticleIds, minute, result };
  return result;
}

export function useFeedCounts(): FeedCounts {
  const suggestions = useForYouSuggestions();
  const { articleCount } = useForYouCounts();
  // Subscribed, not read via getState(): every open replaces the Set (see
  // `markOpened`), so this identity change is what re-renders the sentence's
  // read count the moment the reader opens a story.
  const openedArticleIds = useOpenedStoriesStore((s) => s.articleIds);
  const minute = useSyncExternalStore(subscribeMinute, minuteSnapshot, minuteSnapshot);

  const { analysedCount, relevantCount, readCount } = sharedCounts(
    suggestions,
    openedArticleIds,
    minute,
  );

  return { articleCount, analysedCount, relevantCount, readCount };
}
