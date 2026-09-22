import type { SavedItem } from '@/lib/database/services/saved-article-suggestion-service';

/**
 * The WMDB row id backing a saved item (the suggestion `_id`, or the
 * standalone save's own row id).
 *
 * Its own file because BOTH the Saved list and the export wizard key off it,
 * and the two must agree: the wizard's selection is a set of these ids, and
 * the screen resolves them back to rows. Two copies of the rule would drift
 * the day the union grows a third arm, and the failure would be a selection
 * that silently exports the wrong articles. Not put in the screen or the
 * modal because each imports the other's directory and the cycle is avoidable.
 */
export const savedItemId = (item: SavedItem): string =>
  item.origin === 'suggestion' ? item.suggestion._id : item.savedId;
