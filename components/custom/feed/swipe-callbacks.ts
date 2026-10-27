// swipe-callbacks — the mutable callback contract between the Feed deck UI and
// the (P4) signal-persistence layer. THIS phase ships NO-OP defaults so the deck
// is fully interactive without any persistence; P4 replaces `swipeCallbacks`'s
// members with the real signal writers + Mera invocation.
//
// Kept as a single mutable object (rather than prop-drilling) so P4 can wire the
// persistence layer in one place without touching the deck components. The deck
// imports `swipeCallbacks` and calls its methods; P4 assigns real functions onto
// it (e.g. `Object.assign(swipeCallbacks, realImpl)`), or replaces individual
// members.

import type { Verdict } from '@/lib/stores/feed-order-store';
import type { ForYouSuggestion } from '@/lib/stores/for-you-store';
import type { FeedbackAnswersHandoff } from '@/lib/news-harness/core/types';

export type { Verdict };

export interface SwipeCallbacks {
  /** A verdict was recorded for a card (quick swipe OR a VerdictBar pill tap). */
  onVerdict: (suggestion: ForYouSuggestion, verdict: Verdict) => void;
  /** A revisited card's verdict was flipped from one pill to the other. */
  onVerdictChanged: (
    suggestion: ForYouSuggestion,
    from: Verdict,
    to: Verdict,
  ) => void;
  /** A card's verdict was removed (re-tapping the same thumb un-votes it) —
   *  destroys the stored feedback row (verdict + any tree path). */
  onVerdictRemoved: (suggestion: ForYouSuggestion, verdict: Verdict) => void;
  /** Tell Mera from a card's feedback sheet: the chat opens primed with
   *  every answer the reader gave so far. */
  onInvokeMera: (
    suggestion: ForYouSuggestion,
    verdict: Verdict,
    path: string[],
    answers?: FeedbackAnswersHandoff,
  ) => void;
  /** The VerdictBar's Mera icon was tapped — open the DEFAULT article chat
   *  (pinned card + starter chips, NO verdict/path, NO auto-sent message). */
  onOpenArticleChat: (suggestion: ForYouSuggestion) => void;
}

/** Live contract object. No-op defaults this phase; P4 fills the members. */
export const swipeCallbacks: SwipeCallbacks = {
  onVerdict: () => {},
  onVerdictChanged: () => {},
  onVerdictRemoved: () => {},
  onInvokeMera: () => {},
  onOpenArticleChat: () => {},
};
