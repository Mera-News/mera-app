// feed-story-members — the copies a Feed card counts, for the article page.
//
// A Feed card's "N more reports" is its story's member count minus one
// (feed-row-display.ts). Opened from that card, the article page lists exactly
// those members as its local copies, so the number and the list agree. A story
// the Feed does not hold (opened from World, Search, a fact page) keeps the
// page's own whole-pool grouping.
//
// PURE: no React, no store, no database.

import type { FeedListItem } from '@/lib/stores/feed-list-selector';

interface FeedRows {
  readonly order: readonly string[];
  readonly itemsById: Readonly<Record<string, FeedListItem>>;
}

/** The article ids of the Feed story holding `articleId`, itself included, or
 *  null when no Feed row lists it. The row the article fronts wins over
 *  another row that also lists it (a stale row before the session prunes it). */
export function feedStoryMembersOf(articleId: string, rows: FeedRows): readonly string[] | null {
  const own = rows.itemsById[articleId];
  if (own?.memberIds.includes(articleId)) return own.memberIds;
  for (const id of rows.order) {
    const it = rows.itemsById[id];
    if (it?.memberIds.includes(articleId)) return it.memberIds;
  }
  return null;
}
