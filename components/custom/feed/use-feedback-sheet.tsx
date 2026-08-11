// use-feedback-sheet — the shared plumbing behind a card's like/dislike action,
// extracted so BOTH the For You feed (FeedScreen) and the fact feed
// (FactFeedScreen) drive feedback identically.
//
// The reason picker is now an INLINE surface rendered inside the card (above its
// action row) rather than a floating modal — see `CardFeedbackSurface` +
// `InlineFeedbackTree`. This hook owns only the (stable) card-action handlers:
//   • a thumb tap records the verdict (fresh / flipped) — the card then reveals
//     its inline surface (visibility derived from the stored verdict, per row).
//     That verdict is PROVISIONAL until the user gives it a reason: the thumb
//     stays hollow and the row is discarded rather than speculated on (D15).
//     The commit discriminator is a COMMITTED flag set only when a terminal leaf
//     settles (or the user escalates to Mera) — NOT the stored tree path, which
//     a mere branch descent also writes and which therefore filled the thumb
//     while the caption was still promising the tap would be discarded (F2);
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
import { recordOpen } from '@/lib/database/services/story-impression-service';
import type { FeedbackNudge } from '@/lib/news-harness/feedback-tree';
import type { Verdict } from '@/lib/stores/feed-order-store';
import { useFeedbackDismissedStore } from '@/lib/stores/feedback-dismissed-store';
import { useOpenedStoriesStore } from '@/lib/stores/opened-stories-store';
import type { ForYouSuggestion } from '@/lib/stores/for-you-store';
import { useCallback, useMemo, useRef } from 'react';

/**
 * Giving feedback on a suggestion counts as reading it — mark it opened (the
 * same optimistic-dim + persisted-open-row path a tap uses), so it gets the read
 * treatment and drops from the unopened surfaces. Tagged `swipe` (the feedback
 * surface). Idempotent, so a flip re-marking is harmless.
 */
function markSuggestionRead(suggestion: ForYouSuggestion): void {
  const stableClusterId =
    suggestion.clusters?.find((c) => c.stableClusterId)?.stableClusterId ?? null;
  useOpenedStoriesStore.getState().markOpened(suggestion.articleId, stableClusterId);
  void recordOpen({
    articleId: suggestion.articleId,
    suggestionId: suggestion._id,
    stableClusterId,
    titleNorm: (suggestion.title_en ?? '').toLowerCase().trim().replace(/\s+/g, ' ') || null,
    surface: 'swipe',
  });
}

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
  /** True once a terminal leaf committed for this key — the ONLY thing a filled
   *  thumb may be derived from. Separate from `getPath` on purpose: a path
   *  exists the moment a branch is opened. */
  getCommitted: (key: string) => boolean;
  /** Mark (or, on un-vote / flip, unmark) the verdict as committed. */
  setCommitted: (key: string, committed: boolean) => void;
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
  /** A `nudge` leaf settled — act on the SUGGESTION it carries. Fired after
   *  `onLeafCommitted`, which has already committed the verdict and dismissed
   *  the surface, so this only has to do the navigation. */
  onNudge: (s: ForYouSuggestion, nudge: FeedbackNudge) => void;
}

/**
 * Host wiring the hook cannot derive. Read through a ref (like `adapter`), so it
 * may be recreated every render without destabilising the returned handlers.
 */
export interface UseFeedbackSheetOptions {
  /** Open a suggestion's detail screen. The 'browse_related' nudge routes here:
   *  the related coverage lives in the detail screen's footer, and this is the
   *  same call the card's own tap-to-open makes, so the card lifecycle
   *  (markViewed / recordOpen) is stamped identically. Omitted ⇒ the nudge just
   *  closes the surface, which is what `onLeafCommitted` already did. */
  onOpenSuggestion?: (s: ForYouSuggestion) => void;
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
export function useFeedbackSheet(
  adapter: VerdictStoreAdapter,
  options?: UseFeedbackSheetOptions,
): UseFeedbackSheet {
  const adapterRef = useRef(adapter);
  adapterRef.current = adapter;
  const optionsRef = useRef(options);
  optionsRef.current = options;

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
      a.setCommitted(key, false);
      dismiss.undismiss(key);
      swipeCallbacks.onVerdictRemoved(suggestion, next);
    } else if (existing != null) {
      // Flip like↔dislike — reset the path and reopen the surface fresh. The
      // old sentiment's row (and its commitment) is destroyed by
      // `changeSwipeVerdict`, so the new one starts uncommitted.
      a.setVerdict(key, next);
      a.setPath(key, []);
      a.setCommitted(key, false);
      dismiss.undismiss(key);
      swipeCallbacks.onVerdictChanged(suggestion, existing, next);
      markSuggestionRead(suggestion);
    } else {
      // Fresh verdict — record + reveal the surface.
      a.setVerdict(key, next);
      dismiss.undismiss(key);
      swipeCallbacks.onVerdict(suggestion, next);
      markSuggestionRead(suggestion);
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
        // Escalating to the chat is context the user supplied, so it COMMITS
        // (the design lists it alongside picking a reason). Note this is a
        // forward promise: the chat stamps the row only once the user confirms
        // the agent's proposals.
        swipeCallbacks.onLeafCommitted(s, v, pathIds);
        swipeCallbacks.onInvokeMera(s, v, pathIds);
        // Escalating to the chat is a terminal action — close the surface.
        const key = adapterRef.current.keyFor(s);
        if (key) {
          adapterRef.current.setCommitted(key, true);
          useFeedbackDismissedStore.getState().dismiss(key);
        }
      },
      onLeafCommitted: (s, v, pathIds) => {
        // The last input in the tree — this, and only this, fills the thumb.
        // The DB write lives here too: `onTreePathChanged` cannot carry it,
        // because a branch descent goes through the same callback (F2).
        swipeCallbacks.onLeafCommitted(s, v, pathIds);
        const key = adapterRef.current.keyFor(s);
        if (key) {
          adapterRef.current.setPath(key, pathIds);
          adapterRef.current.setCommitted(key, true);
          useFeedbackDismissedStore.getState().dismiss(key);
        }
      },
      onNudge: (s, nudge) => {
        // Two nudges are deliberately ignored, for different reasons:
        //  • 'subscribe' — the current tree authors no such leaf, so it is only
        //    reachable from a tree cached before that change, and there is
        //    nothing honest for the app to do with it (there never was a
        //    subscribe flow; the old leaf only ever showed a toast).
        //  • 'manage_publication' — already HANDLED. It has one destination on
        //    every surface and takes no per-suggestion argument, so
        //    InlineFeedbackTree navigates before calling this (see
        //    feedback-tree/open-publication-preferences). A `router.push` here
        //    would double-push.
        if (nudge !== 'browse_related') return;
        // `onLeafCommitted` already fired for this leaf, so the verdict is
        // committed and the surface dismissed; all that is left is to take the
        // user to the related coverage, which lives on the detail screen.
        optionsRef.current?.onOpenSuggestion?.(s);
      },
    }),
    [],
  );

  return { onVerdict, onAskMera, feedbackHandlers };
}
