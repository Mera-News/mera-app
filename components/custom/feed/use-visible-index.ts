// use-visible-index — the Feed tab's viewability bridge. It owns two things,
// via two independent viewabilityConfigCallbackPairs on the same FlatList:
//
//  1. The INGEST FREEZE BOUNDARY (loose pair, 10% / 0ms). Records the id of
//     every row that has ever been on screen. The screen turns that into
//     "the deepest index the user has scrolled to" against the LIVE order, and
//     ingest freezes everything at or above it before insertion-sorting new
//     completes into the tail.
//
//     Ids, not a max index: the old monotonic integer never decreased, so once
//     the lifecycle sweep started removing rows, `frozenThroughIndex` would
//     exceed `order.length`, ingest's scan loop would never execute, and every
//     new card would append to the bottom of the feed forever.
//
//  2. The SKIP DWELL RULE (strict pair, 75% visible). A card counts as
//     `skipped` once it has been ≥75% on screen for ≥2s.
//
//     Note `minimumViewTime` is deliberately 0 on that pair. RN's
//     ViewabilityHelper does NOT implement minimumViewTime as continuous
//     dwell — it schedules one timeout per viewable-SET change and re-checks
//     bare membership when the timer fires, with no continuity check. A card
//     visible for 300ms, scrolled away, then visible again at 1900ms would
//     satisfy `minimumViewTime: 2000`. So we take clean enter/exit edges and
//     measure dwell ourselves.
//
// Both callbacks write ONLY into refs — no store writes, no DB writes, no state
// updates mid-scroll (the scroll-lag fix). Marks are buffered and flushed on a
// debounce / scroll-end / blur / background / unmount.

import { useCallback, useEffect, useRef } from 'react';
import type { ViewToken } from 'react-native';
import { useFeedOrderStore } from '@/lib/stores/feed-order-store';

/** How long a card must stay ≥75% visible before it counts as skipped. */
export const SKIP_DWELL_MS = 2000;

/** Trailing coalesce window for flushing buffered skip marks. */
const SKIP_FLUSH_DEBOUNCE_MS = 1200;

function tokenId(v: ViewToken): string | null {
  if (typeof v.key === 'string') return v.key;
  const item = v.item as { id?: unknown } | null;
  return typeof item?.id === 'string' ? item.id : null;
}

export function useVisibleIndex() {
  /** Every row id that has been on screen this session (loose pair). */
  const seenIdsRef = useRef<Set<string>>(new Set());
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
      // ── Freeze boundary. Loose on purpose: a row that so much as peeked into
      //    the viewport must not have new cards inserted above it. ──
      viewabilityConfig: {
        itemVisiblePercentThreshold: 10,
        minimumViewTime: 0,
      },
      onViewableItemsChanged: ({ viewableItems }: { viewableItems: ViewToken[] }) => {
        for (const v of viewableItems) {
          const id = tokenId(v);
          if (id) seenIdsRef.current.add(id);
        }
      },
    },
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

  return { viewabilityConfigCallbackPairs: pairs.current, seenIdsRef, flushSkips };
}

/**
 * The ingest freeze boundary: the deepest index in `order` that the user has
 * actually reached, + 2. Recomputed against the LIVE order every time, so
 * evicting rows (which shifts every index below them) degrades gracefully
 * instead of pinning the boundary past the end of a now-shorter list.
 *
 * Returns 1 when nothing has been seen yet (freeze nothing but the very top).
 */
export function frozenThroughIndexFor(order: string[], seenIds: Set<string>): number {
  if (seenIds.size === 0) return 1;
  let deepest = -1;
  for (let i = order.length - 1; i >= 0; i--) {
    if (seenIds.has(order[i])) {
      deepest = i;
      break;
    }
  }
  return deepest + 2;
}
