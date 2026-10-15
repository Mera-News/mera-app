// pending-visibility — the Feed-only widening of the visibility gate.
//
// `isVisible` (lib/stores/fact-rows-selector.ts) admits a row only once its
// note exists (`status === complete`). That rule is shared by the Dashboard,
// the swipe stack and the fact feed, and it stays as it is. The Feed alone also
// shows a row whose RELEVANCE is known and clears the render gate while its
// note is still being written (`reason_pending`), so articles whose relevance
// arrived in the background are readable the moment the app opens. The card's
// note field then says "Writing a note" until the note lands.
//
// `unscored` rows (Mera has not read them) are admitted separately, by
// `isUnscoredVisible`, in the Continuous view only: every article reaches the
// Feed and plans meter only Mera's reading, so a row Mera has not read yet is
// shown after every scored card (the not-read tail, feed/not-read-tail.ts).
// There is no band and no gate for it, only the window.
//
// PURE: RN-free, no store or database imports beyond the pure selector module.

import { ArticleSuggestionStatus } from '@/lib/database/article-suggestion-status';
import { isWithinWindow, passesRenderGate } from '@/lib/stores/fact-rows-selector';
import type { ForYouSuggestion } from '@/lib/stores/for-you-store';

/** A scored row whose note is still pending, inside the render gate and the
 *  publication window. The same gate and window `isVisible` applies, minus its
 *  `complete` requirement. */
export function isReasonPendingVisible(s: ForYouSuggestion, cutoffMs: number): boolean {
  return (
    s.status === ArticleSuggestionStatus.ReasonPending &&
    passesRenderGate(s) &&
    isWithinWindow(s, cutoffMs)
  );
}

/** Mera has not read this row yet. The ONE predicate for the not-read tail,
 *  the card's "hasn't read" line and the detail screen's. */
export function isNotRead(s: Pick<ForYouSuggestion, 'status'>): boolean {
  return s.status === ArticleSuggestionStatus.Unscored;
}

/** A row Mera has not read, inside the publication window. Continuous view
 *  only (`buildFeedList`'s `includeUnscored`). Terminal states never pass. */
export function isUnscoredVisible(s: ForYouSuggestion, cutoffMs: number): boolean {
  return isNotRead(s) && isWithinWindow(s, cutoffMs);
}
