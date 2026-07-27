// feed-entries — pure display-partition for the Feed tab (RN-free, unit-tested).
//
// The persisted `feed-order-store.order` is the single priority-ordered,
// insert-only source of truth. At render the Feed splits that order by SEEN
// state and drops an "All Caught Up" divider between the two blocks:
//
//   [ unseen stories (priority order) ] → All Caught Up card → [ seen stories ]
//
// Nothing is ever removed — a seen card sinks, it does not disappear. The user
// can always scroll past the divider to re-read everything they have already
// been shown.
//
// "Seen" is the card's own LIFECYCLE STATE (`skipped` = dwelt on in the
// viewport, `viewed` = interacted with), plus an exact-article open recorded on
// any surface. It is deliberately NOT the cluster-wide opened set: a
// `stableClusterId` identifies an ONGOING story, so a brand-new article would
// be pre-sunk below the divider merely because the user read a DIFFERENT
// article in the same story up to 30 days ago.

import type { CardStateRecord } from '@/lib/stores/feed-order-store';
import type { FeedListItem } from '@/lib/stores/feed-list-selector';

/** Sentinel id for the inline "All Caught Up" divider row. */
export const CAUGHT_UP_ENTRY_ID = '__all_caught_up__';

/** The divider row injected between the unseen and seen blocks. */
export interface CaughtUpEntry {
  id: typeof CAUGHT_UP_ENTRY_ID;
  kind: 'caught-up';
}

/** A rendered Feed row: either a real story item or the divider. */
export type FeedEntry = FeedListItem | CaughtUpEntry;

/** Type guard for the divider entry (real items have no `kind`). */
export function isCaughtUpEntry(entry: FeedEntry): entry is CaughtUpEntry {
  return (entry as CaughtUpEntry).kind === 'caught-up';
}

/**
 * True when a laid-out card should render below the divider: it carries a
 * lifecycle record, or its exact article was opened on some surface.
 *
 * Exported so `FeedRow`'s read indicator and this partition are decided by ONE
 * predicate — otherwise a card could show the read-eye while sitting in the
 * unseen block.
 */
export function isSeenEntry(
  item: FeedListItem,
  cardStates: Record<string, CardStateRecord>,
  openedArticleIds: Set<string>,
): boolean {
  if (cardStates[item.id]) return true;
  const articleId = item.suggestion.articleId;
  return !!articleId && openedArticleIds.has(articleId);
}

/**
 * Partition the priority-ordered feed `data` into unseen (above) and seen
 * (below) blocks with the "All Caught Up" divider between them. Each block
 * keeps the incoming order, so the unseen block stays in calculated-priority
 * order and seen stories retain their relative priority order below.
 *
 * Returns an empty array when `data` is empty, so the screen's empty-state chain
 * (loading / preparing / all-caught-up) renders instead of a lone divider.
 */
export function partitionFeedEntries(
  data: FeedListItem[],
  cardStates: Record<string, CardStateRecord>,
  openedArticleIds: Set<string>,
): FeedEntry[] {
  if (data.length === 0) return [];

  const unseen: FeedListItem[] = [];
  const seen: FeedListItem[] = [];
  for (const item of data) {
    if (isSeenEntry(item, cardStates, openedArticleIds)) seen.push(item);
    else unseen.push(item);
  }

  return [...unseen, { id: CAUGHT_UP_ENTRY_ID, kind: 'caught-up' }, ...seen];
}
