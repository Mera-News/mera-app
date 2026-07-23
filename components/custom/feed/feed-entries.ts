// feed-entries — pure display-partition for the Feed tab (RN-free, unit-tested).
//
// The persisted `feed-order-store.order` is the single priority-ordered,
// insert-only source of truth. At render the Feed splits that order by opened
// state and drops an "All Caught Up" divider between the two blocks:
//
//   [ unread stories (priority order) ] → All Caught Up card → [ viewed stories ]
//
// Conceptually the divider has priority 0: unread stories (>0) sit above it, and
// viewed stories (< 0) sit below — a user can scroll past the card to re-read
// everything they've already opened. Viewed stories keep the feed's priority
// order among themselves (their relative order doesn't matter).

import { isSuggestionOpened } from '@/lib/stores/fact-rows-selector';
import type { FeedListItem } from '@/lib/stores/feed-list-selector';

/** Sentinel id for the inline "All Caught Up" divider row. */
export const CAUGHT_UP_ENTRY_ID = '__all_caught_up__';

/** The divider row injected between the unread and viewed blocks. */
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
 * Partition the priority-ordered feed `data` into unread (above) and viewed
 * (below) blocks with the "All Caught Up" divider between them. Each block keeps
 * the incoming order, so the unread block stays in calculated-priority order and
 * viewed stories retain their relative priority order below the divider.
 *
 * Returns an empty array when `data` is empty, so the screen's empty-state chain
 * (loading / preparing / all-caught-up) renders instead of a lone divider.
 */
export function partitionFeedEntries(
  data: FeedListItem[],
  openedIds: Set<string>,
): FeedEntry[] {
  if (data.length === 0) return [];

  const unread: FeedListItem[] = [];
  const viewed: FeedListItem[] = [];
  for (const item of data) {
    if (isSuggestionOpened(item.suggestion, openedIds)) viewed.push(item);
    else unread.push(item);
  }

  return [...unread, { id: CAUGHT_UP_ENTRY_ID, kind: 'caught-up' }, ...viewed];
}
