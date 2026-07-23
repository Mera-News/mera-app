// use-feedback-sheet — the shared plumbing behind a card's like/dislike action,
// extracted so BOTH the For You feed (FeedScreen) and the fact feed
// (FactFeedScreen) drive feedback identically.
//
// The reason picker is now an INLINE surface rendered inside the card (above its
// action row) rather than a floating modal — see `CardFeedbackSurface` +
// `InlineFeedbackTree`. This hook owns only the (stable) card-action handlers:
//   • a thumb tap records the verdict (fresh / flipped) — the card then reveals
//     its inline surface (visibility derived from the stored verdict, per row);
//   • re-tapping the SAME thumb REMOVES the verdict and all its feedback;
//   • the inline tree's path edits persist as the user taps;
//   • the surface's × closes it (keeps the verdict) via the session-level
//     `feedback-dismissed-store`; a fresh/flipped verdict un-dismisses it.
//
// The one thing that differs per surface is WHERE verdicts live. That is behind
// the `VerdictStoreAdapter`: FeedScreen backs it with the persisted
// `feed-order-store` (verdicts keyed by the rep-switch-safe list-item id);
// FactFeedScreen backs it with a component-local store keyed by articleId. The
// signal PERSISTENCE (article_feedback rows + Mera handoff) is shared via
// `swipeCallbacks` for every surface.
//
// Known accepted limitation: `lib/services/swipe-feedback.ts` hardcodes the
// analytics surface as 'swipe' for every verdict row it writes — so a fact-feed
// verdict is tagged 'swipe' too. This is deliberate (renaming would fragment the
// live feedback analytics); it is NOT re-plumbed here.

import { swipeCallbacks } from './swipe-callbacks';
import { wireSwipeCallbacks } from '@/lib/services/swipe-feedback';
import type { Verdict } from '@/lib/stores/feed-order-store';
import { useFeedbackDismissedStore } from '@/lib/stores/feedback-dismissed-store';
import type { ForYouSuggestion } from '@/lib/stores/for-you-store';
import { useCallback, useMemo, useRef } from 'react';

// Install the real Feed-signal implementations onto the swipe-callbacks contract
// once, when this module loads (before any render). Idempotent — mirrors the
// module-level call FeedScreen used to make directly.
wireSwipeCallbacks();

/**
 * Where a surface's verdicts + tree paths live. Every method keys off the
 * surface's STABLE verdict key (feed: the list-item id; fact feed: the article
 * id) resolved from the suggestion via {@link keyFor}.
 */
export interface VerdictStoreAdapter {
  /** The stable verdict key for a suggestion (list-item id / article id). */
  keyFor: (s: ForYouSuggestion) => string | null;
  getVerdict: (key: string) => Verdict | null;
  /** Set the verdict, or clear it when `verdict` is null (un-vote). */
  setVerdict: (key: string, verdict: Verdict | null) => void;
  getPath: (key: string) => string[] | undefined;
  setPath: (key: string, path: string[]) => void;
}

/**
 * The stable per-card feedback callbacks a card wires into its inline surface.
 * Every method takes the suggestion (not a bound thunk) so the object identity
 * stays stable across renders — the memoized card rows bail out unchanged.
 */
export interface CardFeedbackHandlers {
  /** The surface's × was tapped — hide it (keep the verdict). */
  onClose: (s: ForYouSuggestion) => void;
  /** A tree node was tapped — persist the tapped node-id path. */
  onPathChanged: (s: ForYouSuggestion, v: Verdict, pathIds: string[]) => void;
  /** An openChat leaf / Mera escalation — hand off to the chat. */
  onInvokeMera: (s: ForYouSuggestion, v: Verdict, pathIds: string[]) => void;
  /** A terminal (non-openChat) leaf settled — persist the path (no auto-close). */
  onLeafCommitted: (s: ForYouSuggestion, v: Verdict, pathIds: string[]) => void;
}

export interface UseFeedbackSheet {
  /** Card action: a thumb was tapped — record / flip / un-vote. */
  onVerdict: (suggestion: ForYouSuggestion, verdict: Verdict) => void;
  /** Card action: the Mera icon was tapped — open the default article chat. */
  onAskMera: (suggestion: ForYouSuggestion) => void;
  /** Stable handlers the card wires into its inline feedback surface. */
  feedbackHandlers: CardFeedbackHandlers;
}

/**
 * Returns the card-action handlers (stable across renders) plus the stable
 * inline-surface handlers. `adapter` may be recreated each render — it is read
 * through a ref, so the handlers stay stable and the memoized card rows bail out
 * unchanged.
 */
export function useFeedbackSheet(adapter: VerdictStoreAdapter): UseFeedbackSheet {
  const adapterRef = useRef(adapter);
  adapterRef.current = adapter;

  const onVerdict = useCallback((suggestion: ForYouSuggestion, next: Verdict) => {
    const a = adapterRef.current;
    const key = a.keyFor(suggestion);
    if (!key) return;
    const existing = a.getVerdict(key);
    const dismiss = useFeedbackDismissedStore.getState();
    if (existing === next) {
      // Re-tap of the same thumb — un-vote: drop the verdict + its feedback.
      a.setVerdict(key, null);
      a.setPath(key, []);
      dismiss.undismiss(key);
      swipeCallbacks.onVerdictRemoved(suggestion, next);
    } else if (existing != null) {
      // Flip like↔dislike — reset the path and reopen the surface fresh.
      a.setVerdict(key, next);
      a.setPath(key, []);
      dismiss.undismiss(key);
      swipeCallbacks.onVerdictChanged(suggestion, existing, next);
    } else {
      // Fresh verdict — record + reveal the surface.
      a.setVerdict(key, next);
      dismiss.undismiss(key);
      swipeCallbacks.onVerdict(suggestion, next);
    }
  }, []);

  const onAskMera = useCallback((suggestion: ForYouSuggestion) => {
    swipeCallbacks.onOpenArticleChat(suggestion);
  }, []);

  const feedbackHandlers = useMemo<CardFeedbackHandlers>(
    () => ({
      onClose: (s) => {
        const key = adapterRef.current.keyFor(s);
        if (key) useFeedbackDismissedStore.getState().dismiss(key);
      },
      onPathChanged: (s, v, pathIds) => {
        const key = adapterRef.current.keyFor(s);
        if (key) adapterRef.current.setPath(key, pathIds);
        swipeCallbacks.onTreePathChanged(s, v, pathIds);
      },
      onInvokeMera: (s, v, pathIds) => {
        swipeCallbacks.onInvokeMera(s, v, pathIds);
        // Escalating to the chat is a terminal action — close the surface.
        const key = adapterRef.current.keyFor(s);
        if (key) useFeedbackDismissedStore.getState().dismiss(key);
      },
      onLeafCommitted: (s, v, pathIds) => {
        // The last input in the tree — persist the path, then close the surface.
        const key = adapterRef.current.keyFor(s);
        if (key) {
          adapterRef.current.setPath(key, pathIds);
          useFeedbackDismissedStore.getState().dismiss(key);
        }
      },
    }),
    [],
  );

  return { onVerdict, onAskMera, feedbackHandlers };
}
