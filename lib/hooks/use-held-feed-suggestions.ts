// use-held-feed-suggestions — focus-aware "hold new arrivals" gate for the
// For-You feed.
//
// The live suggestion array (`for-you-store.suggestions`) mutates constantly:
// rows are rescored in place, removed, and NEW rows are inserted as sync lands.
// Injecting insertions mid-scroll is jarring, so this hook HOLDS insertions and
// surfaces them as a count the screen renders as a "N new stories" pill — while
// still letting in-place rescores and removals flow through immediately (the
// rendered rows are always the LIVE objects, filtered to the adopted id set).
//
// Focus model (mirrors use-focus-coalesced-value's timer logic):
//   • FIRST MOUNT — adopt everything (cold start shows the whole feed, no pill).
//   • FOCUSED     — re-derive from live promptly (in a transition); new ids stay
//                   held (pill grows), adopted rows update/remove in place. But
//                   if that would render an EMPTY screen while live is non-empty
//                   (e.g. cold start: tab mounts before the store hydrates, so
//                   the first-mount adopt saw []), adopt everything instead —
//                   holding only makes sense when there are rows to disturb.
//   • BLUR (edge) — advance the watermark over the outgoing rendered rows and
//                   adopt every live id (leaving the tab clears the pill).
//   • BLURRED     — trailing-coalesce the rendered value at `blurredIntervalMs`
//                   so the offscreen tree stays warm without paying per-update.
//   • REFOCUS     — adopt the latest live immediately (transition); nothing that
//                   arrived while you were away is "new".
//
// `adoptPending()` is the pill's press handler: it advances the watermark over
// the outgoing rows, adopts every live id, and returns true so the caller can
// scroll to top.

import { startTransition, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useIsFocused } from '@react-navigation/native';
import { ArticleSuggestionStatus } from '@/lib/database/article-suggestion-status';
import { useFeedWatermarkStore } from '@/lib/stores/feed-watermark-store';
import type { ForYouSuggestion } from '@/lib/stores/for-you-store';

/** Default trailing-coalesce window while blurred (ms). Matches the focus-
 *  coalesced value hook. */
const DEFAULT_BLURRED_INTERVAL_MS = 5000;

/** Only arrivals published within this window count toward the pending pill. */
const PENDING_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Held rows above this relevance count as renderable (unscored always count —
 *  they render progressively). Matches the feed's 0.3 render gate. */
const PENDING_RELEVANCE_GATE = 0.3;

export interface UseHeldFeedSuggestionsResult {
  /** The rows to render: live filtered to the adopted id set. */
  suggestions: ForYouSuggestion[];
  /** Count of held (not-yet-adopted) renderable arrivals, deduped by story. */
  pendingNewCount: number;
  /** Adopt every held arrival + advance the watermark. Returns true (caller
   *  should scroll to top). */
  adoptPending: () => boolean;
}

function createdAtMsOf(iso: string): number {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : 0;
}

/** Max `createdAt` (epoch ms) over a rendered array — the watermark candidate. */
function maxCreatedAtMs(arr: ForYouSuggestion[]): number {
  let max = 0;
  for (const s of arr) {
    const t = createdAtMsOf(s.createdAt);
    if (t > max) max = t;
  }
  return max;
}

/** Stable dedup key for a suggestion: its top stable cluster id, else its _id. */
function storyKeyOf(s: ForYouSuggestion): string {
  return s.clusters.find((c) => c.stableClusterId)?.stableClusterId ?? s._id;
}

export function useHeldFeedSuggestions(
  live: ForYouSuggestion[],
  opts?: { focused?: boolean; blurredIntervalMs?: number },
): UseHeldFeedSuggestionsResult {
  const hasOverride = opts?.focused !== undefined;
  // `useIsFocused` is only skipped when a `focused` override is supplied (a
  // testability escape hatch — it throws outside a navigator). Real callers never
  // pass it, so for any mounted instance this call is effectively unconditional.
  // eslint-disable-next-line react-hooks/rules-of-hooks
  const navFocused = hasOverride ? false : useIsFocused();
  const isFocused = hasOverride ? (opts?.focused as boolean) : navFocused;
  const blurredIntervalMs = opts?.blurredIntervalMs ?? DEFAULT_BLURRED_INTERVAL_MS;

  // The adopted id set — rows whose insertion has been let through. Held in a
  // ref (never triggers a render on its own; renders are driven by setRendered).
  const adoptedIdsRef = useRef<Set<string>>(new Set());
  const initedRef = useRef(false);
  if (!initedRef.current) {
    // FIRST MOUNT: adopt everything so a cold start shows the whole feed, no pill.
    adoptedIdsRef.current = new Set(live.map((s) => s._id));
    initedRef.current = true;
  }

  const deriveRendered = useCallback(
    (arr: ForYouSuggestion[]) => arr.filter((s) => adoptedIdsRef.current.has(s._id)),
    [],
  );

  const [rendered, setRendered] = useState<ForYouSuggestion[]>(() => deriveRendered(live));

  // Latest live + latest rendered, read from event handlers / timers.
  const latestRef = useRef(live);
  latestRef.current = live;
  const renderedRef = useRef(rendered);
  renderedRef.current = rendered;

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prevFocusedRef = useRef(isFocused);

  const advanceOver = useCallback((arr: ForYouSuggestion[]) => {
    useFeedWatermarkStore.getState().advance(maxCreatedAtMs(arr));
  }, []);

  const adoptAll = useCallback((arr: ForYouSuggestion[]) => {
    adoptedIdsRef.current = new Set(arr.map((s) => s._id));
    startTransition(() => setRendered(arr.slice()));
  }, []);

  const adoptPending = useCallback(() => {
    // Advance the watermark over the OUTGOING rendered rows, then adopt live.
    advanceOver(renderedRef.current);
    adoptAll(latestRef.current);
    return true;
  }, [advanceOver, adoptAll]);

  useEffect(() => {
    const wasFocused = prevFocusedRef.current;
    prevFocusedRef.current = isFocused;

    if (isFocused) {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      if (!wasFocused) {
        // REFOCUS: adopt the latest immediately (nothing seen while away is new).
        adoptAll(latestRef.current);
      } else {
        // Focused live update: re-derive with the CURRENT adopted set — new ids
        // stay held (pill grows), adopted rows update/remove in place.
        const derived = deriveRendered(latestRef.current);
        if (derived.length === 0 && latestRef.current.length > 0) {
          // Empty screen while live is non-empty (cold-start hydration, post-
          // logout store repopulation): holding disturbs nothing, so adopt all.
          adoptAll(latestRef.current);
        } else {
          startTransition(() => setRendered(derived));
        }
      }
      return;
    }

    if (wasFocused) {
      // BLUR edge: mark the outgoing rows presented + adopt live (clears the pill).
      advanceOver(renderedRef.current);
      adoptAll(latestRef.current);
      return;
    }

    // Already blurred, live changed: arm a single trailing coalesce timer.
    if (timerRef.current) return;
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      adoptAll(latestRef.current);
    }, blurredIntervalMs);
  }, [live, isFocused, blurredIntervalMs, deriveRendered, advanceOver, adoptAll]);

  useEffect(() => {
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, []);

  // Held renderable arrivals, deduped by story. Recomputes when live changes or
  // when adoption changes (rendered identity changes on every adopt/coalesce).
  const pendingNewCount = useMemo(() => {
    const cutoff = Date.now() - PENDING_WINDOW_MS;
    const seenKeys = new Set<string>();
    let count = 0;
    for (const s of live) {
      if (adoptedIdsRef.current.has(s._id)) continue; // only HELD rows
      const renderable =
        s.status === ArticleSuggestionStatus.Unscored || s.relevance > PENDING_RELEVANCE_GATE;
      if (!renderable) continue;
      const pub = Date.parse(s.firstPubDate);
      if (!Number.isFinite(pub) || pub < cutoff) continue;
      const key = storyKeyOf(s);
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);
      count += 1;
    }
    return count;
    // `rendered` is an intentional dep: adoptedIdsRef is a ref (non-reactive), so
    // recomputing on adoption (which changes `rendered`'s identity) is what keeps
    // the pill count correct after adopt/coalesce.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live, rendered]);

  return { suggestions: rendered, pendingNewCount, adoptPending };
}

export default useHeldFeedSuggestions;
