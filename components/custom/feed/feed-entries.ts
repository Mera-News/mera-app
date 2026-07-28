// feed-entries — pure display-ORDER for the Feed tab (RN-free, unit-tested).
//
// The persisted `feed-order-store.order` is the insert-only source of truth for
// which stories exist and how new arrivals stack. At render the Feed sorts that
// list into ONE continuous run — there is no longer an "All Caught Up" divider,
// and no end-of-feed marker row; the feed simply flows to its end:
//
//   [ unviewed: high → medium → low ] then [ viewed: high → medium → low ]
//
// Nothing is ever removed. A viewed card SINKS, it does not disappear, so the
// user can always scroll on to re-read everything they have already been shown.
//
// "Viewed" is the card's own LIFECYCLE STATE (`skipped` = dwelt on for
// DWELL_READ_SECONDS in the viewport, `viewed` = interacted with — the two are
// one concept for display purposes), plus an exact-article open recorded on any
// surface. It is deliberately NOT the cluster-wide opened set: a
// `stableClusterId` identifies an ONGOING story, so a brand-new article would be
// pre-sunk merely because the user read a DIFFERENT article in the same story up
// to 30 days ago.
//
// STABILITY: the screen feeds this a SNAPSHOT of card state that is refreshed
// only at launch and on pull-to-refresh, so a card never migrates from unviewed
// to viewed under the reader mid-session. Within a band the incoming order wins
// (`idx` is the final tie-break), which is what keeps the store's insert-only
// prepend meaningful: a new arrival lands at the TOP of its own band.

import {
  countUnviewedBy,
  isViewedArticle,
  relevanceBandRank,
  sortByPriority,
  type PriorityFacts,
} from '@/lib/feed-ordering/priority-order';
import type { CardStateRecord } from '@/lib/stores/feed-order-store';
import type { FeedListItem } from '@/lib/stores/feed-list-selector';

// The banding + ordering RULE lives in lib/feed-ordering/priority-order — the
// Dashboard applies the identical rule to its section content, and encoding it
// twice would guarantee silent divergence. This module is now just the Feed's
// projection onto that rule.
export { relevanceBandRank };

/** A rendered Feed row. Every row is a real story — the divider entry is gone. */
export type FeedEntry = FeedListItem;

/**
 * True when a laid-out card counts as VIEWED: it carries a lifecycle record
 * (opened, thumbed, saved, handed to Mera, or dwelt on for DWELL_READ_SECONDS),
 * or its exact article was opened on some surface.
 *
 * Exported so `FeedRow`'s read indicator and this sort are decided by ONE
 * predicate — otherwise a card could show the read state while sitting in the
 * unviewed block.
 */
export function isViewedEntry(
  item: FeedListItem,
  cardStates: Record<string, CardStateRecord>,
  openedArticleIds: Set<string>,
): boolean {
  // `item.id` is the feed-order row key (what `cardStates` is stamped under);
  // the opened set is keyed by ARTICLE id. In production they are the same
  // string, but they are different namespaces — pass them separately.
  return isViewedArticle(item.id, item.suggestion.articleId, cardStates, openedArticleIds);
}

/** Project a Feed row onto the shared ordering facts. */
function feedPriorityFacts(
  item: FeedListItem,
  cardStates: Record<string, CardStateRecord>,
  openedArticleIds: Set<string>,
): PriorityFacts {
  return {
    relevance: item.suggestion.relevance ?? 0,
    viewed: isViewedEntry(item, cardStates, openedArticleIds),
  };
}

/**
 * Order the feed: unviewed first (by relevance band, high → low), then viewed
 * (same banding). Ties inside a band keep the incoming `data` order, i.e. the
 * store's insert-only order, so newly-prepended arrivals sit at the top of their
 * band and nothing shuffles between refreshes.
 *
 * Pure and total: returns a NEW array, never mutates `data`, and returns an
 * empty array for an empty feed so the screen's empty-state chain renders.
 */
export function sortFeedEntries(
  data: FeedListItem[],
  cardStates: Record<string, CardStateRecord>,
  openedArticleIds: Set<string>,
): FeedEntry[] {
  if (data.length === 0) return [];
  return sortByPriority(data, (it) => feedPriorityFacts(it, cardStates, openedArticleIds));
}

/** How many rows at the head of a sorted list are unviewed. The boundary is no
 *  longer rendered, but the funnel diagnostic still reports the split. */
export function countUnviewed(
  data: FeedListItem[],
  cardStates: Record<string, CardStateRecord>,
  openedArticleIds: Set<string>,
): number {
  return countUnviewedBy(data, (it) => feedPriorityFacts(it, cardStates, openedArticleIds));
}
