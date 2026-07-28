// use-visible-index — the Feed tab's viewability bridge. It owns exactly one
// thing: the SKIP DWELL RULE. A card counts as `skipped` once it has been ≥75%
// on screen for ≥ SKIP_DWELL_MS.
//
// `minimumViewTime` on that pair is deliberately 0. RN's ViewabilityHelper does
// NOT implement minimumViewTime as continuous dwell — it schedules one timeout
// per viewable-SET change and re-checks bare membership when the timer fires,
// with no continuity check. A card visible for 300ms, scrolled away, then
// visible again just under the threshold would still satisfy it. So we take
// clean enter/exit edges and measure dwell ourselves.
//
// This file used to carry a SECOND, looser pair that tracked "the deepest row
// the user has scrolled to" so ingest could freeze everything above it before
// insertion-sorting. That whole approximation is gone: it computed an index into
// `order` while the list renders a PARTITIONED array, so the two index spaces
// diverged the moment any card was seen and it protected the wrong region.
// FlatList's `maintainVisibleContentPosition` solves it correctly in render
// space instead — see FeedScreen.
//
// The callback writes ONLY into refs — no store writes, no DB writes, no state
// updates mid-scroll (the scroll-lag fix). Marks are buffered and flushed on a
// debounce / scroll-end / blur / background / unmount.

import { useCallback, useEffect, useRef } from 'react';
import type { ViewToken } from 'react-native';
import { useFeedOrderStore } from '@/lib/stores/feed-order-store';

/** Seconds a card must stay ≥75% on screen before it counts as VIEWED by dwell.
 *  "Viewed" is opened (tap) OR this much uninterrupted visibility — 3s is a
 *  deliberate read, not a brisk scroll-past. Both signals feed the same
 *  `feed-order-store` card state; only the sort order consumes it, nothing is
 *  ever removed for being viewed. */
export const DWELL_READ_SECONDS = 3;

/** {@link DWELL_READ_SECONDS} in ms — what the dwell timer actually compares. */
export const SKIP_DWELL_MS = DWELL_READ_SECONDS * 1000;

/** Trailing coalesce window for flushing buffered skip marks. */
const SKIP_FLUSH_DEBOUNCE_MS = 1200;

function tokenId(v: ViewToken): string | null {
  if (typeof v.key === 'string') return v.key;
  const item = v.item as { id?: unknown } | null;
  return typeof item?.id === 'string' ? item.id : null;
}

export function useVisibleIndex() {
  /** id → epoch ms it became ≥75% visible (strict pair, currently on screen). */
  const enterAtRef = useRef<Map<string, number>>(new Map());
  /** Dwell-satisfied ids awaiting a flush into the store. */
  const skipBufferRef = useRef<Set<string>>(new Set());
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flushSkips = useCallback(() => {
    if (flushTimerRef.current) {
      clearTimeout(flushTimerRef.current);
      flushTimerRef.current = null;
    }
    // Also drain rows that are STILL on screen but have already earned their
    // dwell — otherwise the card the user is looking at when they leave the tab
    // (or the last card in the list, which never exits) would never be marked.
    const now = Date.now();
    for (const [id, at] of enterAtRef.current) {
      if (now - at >= SKIP_DWELL_MS) {
        skipBufferRef.current.add(id);
        // Re-stamp so a long dwell doesn't re-add on every flush; `markSkipped`
        // is write-once anyway, this just keeps the buffer small.
        enterAtRef.current.set(id, now);
      }
    }
    const buf = skipBufferRef.current;
    if (buf.size === 0) return;
    const ids = Array.from(buf);
    buf.clear();
    // getState(), never a captured action — see the stale-closure note below.
    useFeedOrderStore.getState().markSkipped(ids);
  }, []);

  // The callbacks below live inside a ref-frozen array and therefore capture
  // render 0 forever. Reach live code through this ref, never through a closure
  // over props/state.
  const flushSkipsRef = useRef(flushSkips);
  flushSkipsRef.current = flushSkips;

  // Built ONCE via a ref (FlatList forbids mutating this prop after mount).
  const pairs = useRef([
    {
      // ── Skip dwell. `changed` gives clean enter/exit edges; dwell is measured
      //    here rather than delegated to minimumViewTime (see header). ──
      viewabilityConfig: {
        itemVisiblePercentThreshold: 75,
        minimumViewTime: 0,
      },
      onViewableItemsChanged: ({ changed }: { changed: ViewToken[] }) => {
        const now = Date.now();
        for (const v of changed) {
          const id = tokenId(v);
          if (!id) continue;
          if (v.isViewable) {
            // Only stamp on a genuine enter — a duplicate enter event must not
            // restart the clock on a row already being timed.
            if (!enterAtRef.current.has(id)) enterAtRef.current.set(id, now);
            continue;
          }
          const at = enterAtRef.current.get(id);
          enterAtRef.current.delete(id);
          if (at !== undefined && now - at >= SKIP_DWELL_MS) {
            skipBufferRef.current.add(id);
          }
        }
        // Trailing coalesce, NON-resetting: a re-arming debounce would never
        // fire during a continuous scroll.
        if (flushTimerRef.current) return;
        flushTimerRef.current = setTimeout(() => {
          flushTimerRef.current = null;
          flushSkipsRef.current();
        }, SKIP_FLUSH_DEBOUNCE_MS);
      },
    },
  ]);

  // Flush on unmount so a partially-filled buffer isn't lost.
  useEffect(
    () => () => {
      flushSkipsRef.current();
    },
    [],
  );

  return { viewabilityConfigCallbackPairs: pairs.current, flushSkips };
}
