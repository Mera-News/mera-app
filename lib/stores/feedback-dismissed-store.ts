// feedback-dismissed-store — session-only UI state tracking which cards have had
// their inline feedback surface CLOSED (the × button) while keeping the verdict.
//
// Keyed by the card's verdict key (the feed's list-item id / the fact feed's
// article id — whatever the surface's `adapter.keyFor` returns). Not persisted:
// a dismissed surface reopens on the next app launch, which is fine — the verdict
// itself lives in `article_feedback` and is unaffected. Re-voting a card
// un-dismisses it so a fresh action always reopens the surface.

import { create } from 'zustand';

interface FeedbackDismissedState {
  dismissed: Record<string, true>;
  /** Hide the surface for `key` (keeps the verdict). */
  dismiss: (key: string) => void;
  /** Re-show the surface for `key` (on a fresh/flipped/removed verdict). */
  undismiss: (key: string) => void;
}

export const useFeedbackDismissedStore = create<FeedbackDismissedState>((set) => ({
  dismissed: {},
  dismiss: (key) =>
    set((s) => (s.dismissed[key] ? s : { dismissed: { ...s.dismissed, [key]: true } })),
  undismiss: (key) =>
    set((s) => {
      if (!s.dismissed[key]) return s;
      const next = { ...s.dismissed };
      delete next[key];
      return { dismissed: next };
    }),
}));
