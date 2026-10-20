// The ONE rule for what a scored row with no note shows, shared by the Feed
// card, the detail screen and the Feed's sort (`isAwaitingNote`). RN-free, so
// the sort and its tests can import it.

import { ArticleSuggestionStatus } from '@/lib/database/article-suggestion-status';
import type { ForYouSuggestion } from '@/lib/stores/for-you-store';

/**
 * The state of a note that is not there yet:
 *  - `writing`: the moving Mera logo beside the fact that found the article
 *    and "Please wait while Mera writes the reason". A `reason_pending` row
 *    always gets its note (the orphaned-reasons sweep re-sends any batch that
 *    did not settle), so this holds between batches too.
 *  - `held`: the day's cloud reading is used up, so the note waits for the
 *    reset; a static line says why and when, with no logo.
 */
export type ReasonNotePendingMode = 'writing' | 'held';

/**
 * Only `reason_pending` without a note is pending. Undefined for no status,
 * unscored, a row with its note, `complete`, and every other status
 * (`reason_skipped` shows its fact chips like a complete note-less row).
 * `held` is the cloud reading hold (`useReadHeld().held`), read once per
 * surface by the host.
 */
export function notePendingMode(
    s: Pick<ForYouSuggestion, 'status' | 'reason'>,
    held: boolean,
): ReasonNotePendingMode | undefined {
    if (s.status !== ArticleSuggestionStatus.ReasonPending || s.reason) return undefined;
    return held ? 'held' : 'writing';
}

/**
 * A scored row finalised with no note (Write notes off on this phone, D35):
 * the card shows the relevance chip alone. Not `reason_skipped` (its fact chips
 * show instead) and not a zero relevance (never scored, or excluded).
 */
export function showsChipOnly(s: Pick<ForYouSuggestion, 'status' | 'reason' | 'relevance'>): boolean {
    return s.status === ArticleSuggestionStatus.Complete && !s.reason && (s.relevance ?? 0) > 0;
}
