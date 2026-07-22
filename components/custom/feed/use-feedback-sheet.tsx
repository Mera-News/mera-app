// use-feedback-sheet — the shared FeedbackTreeSheet plumbing behind a card's
// like/dislike action, extracted from FeedScreen so BOTH the For You feed
// (FeedScreen) and the fact feed (FactFeedScreen) drive the sheet identically.
//
// The behavior is byte-equivalent to FeedScreen's original inline plumbing:
//   • a thumb tap records the verdict (fresh / flipped) and floats the sheet;
//   • re-tapping the same thumb REOPENS the sheet on the stored tree path
//     (no re-record);
//   • the inline tree's path edits persist as the user taps;
//   • a terminal (non-openChat) leaf settles briefly, then closes;
//   • an openChat leaf / the sheet's Mera entry escalate to Mera and close.
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

import FeedbackTreeSheet from './FeedbackTreeSheet';
import { swipeCallbacks } from './swipe-callbacks';
import { wireSwipeCallbacks } from '@/lib/services/swipe-feedback';
import type { Verdict } from '@/lib/stores/feed-order-store';
import type { ForYouSuggestion } from '@/lib/stores/for-you-store';
import React, { useCallback, useEffect, useRef, useState } from 'react';

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
  setVerdict: (key: string, verdict: Verdict) => void;
  getPath: (key: string) => string[] | undefined;
  setPath: (key: string, path: string[]) => void;
}

interface ActiveFeedback {
  /** The verdict key (adapter-resolved) — verdict + path are keyed by this. */
  key: string;
  suggestion: ForYouSuggestion;
  verdict: Verdict;
  initialPathIds?: string[];
}

export interface UseFeedbackSheet {
  /** Card action: a thumb was tapped — record + float the sheet. */
  onVerdict: (suggestion: ForYouSuggestion, verdict: Verdict) => void;
  /** Card action: the Mera icon was tapped — open the default article chat. */
  onAskMera: (suggestion: ForYouSuggestion) => void;
  /** The single, screen-level sheet element. Render it once after the list. */
  sheet: React.ReactElement;
}

/**
 * Returns the two card-action handlers (stable across renders) plus the single
 * FeedbackTreeSheet element to mount once at screen level. `adapter` may be
 * recreated each render — it is read through a ref, so the handlers stay stable
 * and the memoized card rows bail out unchanged.
 */
export function useFeedbackSheet(adapter: VerdictStoreAdapter): UseFeedbackSheet {
  const adapterRef = useRef(adapter);
  adapterRef.current = adapter;

  const [activeFeedback, setActiveFeedback] = useState<ActiveFeedback | null>(null);
  const activeFeedbackRef = useRef<ActiveFeedback | null>(null);
  activeFeedbackRef.current = activeFeedback;

  const settleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (settleTimer.current) clearTimeout(settleTimer.current);
    },
    [],
  );

  const onVerdict = useCallback((suggestion: ForYouSuggestion, next: Verdict) => {
    const a = adapterRef.current;
    const key = a.keyFor(suggestion);
    if (!key) return;
    const existing = a.getVerdict(key);
    if (existing === next) {
      // Re-tap of the same thumb — reopen the sheet on the stored path; no re-record.
    } else if (existing != null) {
      a.setVerdict(key, next);
      swipeCallbacks.onVerdictChanged(suggestion, existing, next);
    } else {
      a.setVerdict(key, next);
      swipeCallbacks.onVerdict(suggestion, next);
    }
    setActiveFeedback({
      key,
      suggestion,
      verdict: next,
      initialPathIds: a.getPath(key),
    });
  }, []);

  const onAskMera = useCallback((suggestion: ForYouSuggestion) => {
    swipeCallbacks.onOpenArticleChat(suggestion);
  }, []);

  const closeSheet = useCallback(() => setActiveFeedback(null), []);

  // Path is keyed by the active feedback's verdict key (rep-switch-safe on the
  // feed), taken from the active record rather than re-resolved from the suggestion.
  const handleTreePathChanged = useCallback(
    (s: ForYouSuggestion, v: Verdict, pathIds: string[]) => {
      const key = activeFeedbackRef.current?.key;
      if (key) adapterRef.current.setPath(key, pathIds);
      swipeCallbacks.onTreePathChanged(s, v, pathIds);
    },
    [],
  );

  const handleTreeInvokeMera = useCallback(
    (s: ForYouSuggestion, v: Verdict, pathIds: string[]) => {
      swipeCallbacks.onInvokeMera(s, v, pathIds);
    },
    [],
  );

  // Terminal (non-openChat) leaf: path already recorded — settle briefly, close.
  const handleLeafCommitted = useCallback(
    (s: ForYouSuggestion, v: Verdict, pathIds: string[]) => {
      const key = activeFeedbackRef.current?.key;
      if (key) adapterRef.current.setPath(key, pathIds);
      if (settleTimer.current) clearTimeout(settleTimer.current);
      settleTimer.current = setTimeout(() => setActiveFeedback(null), 250);
    },
    [],
  );

  // The sheet's Mera entry row — verdict + path-primed handoff.
  const handleSheetAskMera = useCallback(() => {
    setActiveFeedback((current) => {
      if (current) {
        const a = adapterRef.current;
        swipeCallbacks.onInvokeMera(
          current.suggestion,
          a.getVerdict(current.key) ?? current.verdict,
          a.getPath(current.key) ?? [],
        );
      }
      return current;
    });
  }, []);

  const sheet = (
    <FeedbackTreeSheet
      suggestion={activeFeedback?.suggestion ?? null}
      verdict={activeFeedback?.verdict ?? null}
      initialPathIds={activeFeedback?.initialPathIds}
      onClose={closeSheet}
      onTreePathChanged={handleTreePathChanged}
      onInvokeMera={handleTreeInvokeMera}
      onLeafCommitted={handleLeafCommitted}
      onAskMera={handleSheetAskMera}
    />
  );

  return { onVerdict, onAskMera, sheet };
}
