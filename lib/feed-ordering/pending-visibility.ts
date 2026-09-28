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
// Deliberately NOT widened to `unscored`: with no relevance there is no band to
// sort by and no gate to clear, and most of a fetch scores below the gate.
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
