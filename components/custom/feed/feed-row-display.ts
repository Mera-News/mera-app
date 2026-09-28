// feed-row-display — what one Feed row SHOWS, decided once per reading session.
//
// Two session rules, both about never changing a card under the reader:
//
// 1. THE FRONTING ARTICLE STAYS PUT. A story's representative is re-elected
//    whenever its group changes (a member gets its note, a fresher report
//    joins), and `feed-order-store.ingest` stores the new representative under
//    the row's old id. Displayed as-is, the card's headline, publication and
//    image would swap while someone reads it. So the first representative a row
//    renders with is frozen for the session; the card keeps showing THAT
//    article's live row, including its own note state. A sibling's note never
//    takes over. If the frozen article ends with no note, the card says so.
//
// 2. THE NOTE AREA KEEPS ITS HEIGHT ONLY WHERE IT CAN CHANGE. A card that was
//    pending at any point this session (its status was not yet `complete`)
//    reserves two lines for its note, so the note landing does not grow it. A
//    card already complete at first render keeps its natural height.
//
// Both sets are SESSION state: FeedScreen replaces the whole object in
// `resetSession`, the same moment the partition and the pin reset and the list
// returns to the top, which is what makes re-electing safe.
//
// PURE: no React, no store, no database.

import { ArticleSuggestionStatus } from '@/lib/database/article-suggestion-status';
import type { FeedListItem } from '@/lib/stores/feed-list-selector';
import type { ForYouSuggestion } from '@/lib/stores/for-you-store';

export interface FeedRowSession {
  /** Row id → the suggestion that fronted it when it first rendered (the row
   *  as it was then; its live row is looked up by `_id`). */
  readonly frozenRep: Map<string, ForYouSuggestion>;
  /** The reverse: frozen suggestion id → row id, so a tap or a verdict on the
   *  card resolves to its row even when the store's representative moved on. */
  readonly rowBySuggestion: Map<string, string>;
  /** Row ids whose card was pending at any point this session. */
  readonly wasPending: Set<string>;
}

export function newFeedRowSession(): FeedRowSession {
  return { frozenRep: new Map(), rowBySuggestion: new Map(), wasPending: new Set() };
}

export interface FeedRowDisplay {
  /** The row the card renders: the frozen representative's LIVE row when the
   *  store still holds it, else the list item's own. */
  suggestion: ForYouSuggestion;
  /** Reserve the note area's height (the row was pending this session). */
  reserveNoteSpace: boolean;
}

/**
 * Resolve a row for rendering, recording its first representative and whether
 * it has been pending. Idempotent for a given session, so calling it on every
 * render (and twice under StrictMode) is safe.
 */
export function resolveFeedRowDisplay(
  item: FeedListItem,
  liveById: ReadonlyMap<string, ForYouSuggestion>,
  session: FeedRowSession,
): FeedRowDisplay {
  let frozen = session.frozenRep.get(item.id);
  if (frozen === undefined) {
    frozen = item.suggestion;
    session.frozenRep.set(item.id, frozen);
    session.rowBySuggestion.set(frozen._id, item.id);
  }
  // The frozen article's live row, so its note state is current. When the
  // store no longer holds it (a data clear, the TTL sweep), the row as it was
  // at first render, never the newer representative.
  const suggestion = liveById.get(frozen._id) ?? frozen;
  if (suggestion.status !== ArticleSuggestionStatus.Complete) session.wasPending.add(item.id);
  return { suggestion, reserveNoteSpace: session.wasPending.has(item.id) };
}
