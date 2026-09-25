// use-visible-index — the Feed tab's viewability bridge. It owns the SEEN RULE
// (ux2 B2, owner): a card counts as `skipped` (seen by dwell) only while its
// BOTTOM EDGE sits inside the visible band [the header's bottom edge, the
// window height minus the tab bar clearance], continuously for
// DWELL_READ_SECONDS. A card only 75% visible with its end still under the tab
// bar has not been read; a tall card qualifies once its end scrolls into view.
//
// Mechanism: a low-threshold viewability pair says which rows are on screen
// at all; on each scroll tick (lib/visibility-tick) those rows alone are
// measured (`measureInWindow`) and their band entry/exit feed the dwell clock.
// An unmeasured row (height 0, or a Fabric measure that never calls back) is
// retried on a short ladder after the on-screen set changes, then on every tick.
// Dwell is measured here, never through `minimumViewTime`, because RN's
// ViewabilityHelper does not implement it as continuous dwell.
//
// It ALSO tracks the deepest story the user has actually seen, as an ID — the
// anchor for the Feed's pinned prefix (the static region). See the note on
// `deepestSeenIdRef` below for why this is not the tracker described next.
//
// This file used to carry a SECOND, looser pair that tracked "the deepest row
// the user has scrolled to" so ingest could freeze everything above it before
// insertion-sorting. That whole approximation is gone: it computed an index into
// `order` while the list renders a PARTITIONED array, so the two index spaces
// diverged the moment any card was seen and it protected the wrong region.
//
// The callback writes ONLY into refs — no store writes, no DB writes, no state
// updates mid-scroll (the scroll-lag fix). Marks are buffered and flushed on a
// debounce / scroll-end / blur / background / unmount.

import { useCallback, useEffect, useRef } from 'react';
import type { ViewToken } from 'react-native';
import { useFeedOrderStore } from '@/lib/stores/feed-order-store';
import { subscribeScrollTick } from '@/lib/visibility-tick';

/** The visible band a card's bottom edge must sit in, in window coordinates. */
export interface SeenBand {
  top: number;
  bottom: number;
}

/** A row view that can say where it is on screen. */
interface MeasurableRow {
  measureInWindow?: (cb: (x: number, y: number, w: number, h: number) => void) => void;
}

/** Seconds a card's bottom edge must stay inside the visible band (see the
 *  header) before it counts as VIEWED by dwell: the configured duration.
 *  "Viewed" is opened (tap) OR this much uninterrupted visibility. Both signals
 *  feed the same `feed-order-store` card state; only the sort order consumes it,
 *  nothing is ever removed for being viewed.
 *
 *  Was 3s ("a deliberate read, not a brisk scroll-past"). Halved because the
 *  tiers now make this consequential: a card marked seen sinks below the
 *  caught-up divider, so too LONG a dwell leaves the unseen tier full of cards
 *  the user has already scrolled past, and the boundary never climbs. 1.5s is
 *  still a pause rather than a glance.
 *
 *  The bottom-edge band rule is what keeps the shorter window honest: a card
 *  whose end is still under the tab bar does not count. */
export const DWELL_READ_SECONDS = 1.5;

/** {@link DWELL_READ_SECONDS} in ms — what the dwell timer actually compares. */
export const SKIP_DWELL_MS = DWELL_READ_SECONDS * 1000;

/** Re-measure delays after the on-screen set changes (TranslatableDynamic's
 *  ladder): a Fabric cell with no committed position yet never calls back. */
const MEASURE_RETRY_LADDER_MS = [150, 450] as const;

/** Trailing coalesce window for flushing buffered skip marks. */
const SKIP_FLUSH_DEBOUNCE_MS = 1200;

function tokenId(v: ViewToken): string | null {
  if (typeof v.key === 'string') return v.key;
  const item = v.item as { id?: unknown } | null;
  return typeof item?.id === 'string' ? item.id : null;
}

/**
 * @param renderedIdsRef live ref to the CURRENT rendered STORY ids, top-to-bottom
 *   (story ids only — never a union array containing divider sentinels, or a
 *   divider would consume a pin slot). MUST be a ref created once with `useRef`
 *   by the caller: the viewability callbacks below live inside a ref-frozen
 *   array and capture render 0 forever, so this argument's OBJECT IDENTITY has
 *   to be stable for its lifetime. It is stored into a local ref on first render
 *   and read only through that.
 */
export function useVisibleIndex(
  renderedIdsRef?: { current: readonly string[] },
  /** Live ref to the band getter (FeedScreen: header bottom .. window height
   *  minus the tab clearance). Absent: nothing is ever timed as seen. */
  bandRef?: { current: () => SeenBand },
) {
  /** id → epoch ms its bottom edge entered the band (and has stayed since). */
  const enterAtRef = useRef<Map<string, number>>(new Map());
  /** Rows the low-threshold pair reports as on screen: the only ones measured. */
  const onScreenRef = useRef<Set<string>>(new Set());
  /** id → its row view, for `measureInWindow`. */
  const rowNodesRef = useRef<Map<string, MeasurableRow>>(new Map());
  /** Stable per-id ref callbacks, so a row's `ref` prop never churns. */
  const rowRefCallbacksRef = useRef<Map<string, (node: MeasurableRow | null) => void>>(new Map());
  const bandHolderRef = useRef(bandRef);
  if (bandHolderRef.current === undefined) bandHolderRef.current = bandRef;
  /** The deepest story (by rendered position) that has been ≥75% visible this
   *  session — the pinned-prefix anchor. An ID, never an index: an index would
   *  have to survive a re-sort and a sentinel-row splice, which are two
   *  different index spaces (that divergence is what killed the old tracker
   *  described in the header). Resolved against the rendered order only in the
   *  same tick it is consumed, by `extendPinnedIds`. */
  const deepestSeenIdRef = useRef<string | null>(null);
  /** First-render capture of the caller's ref — see the @param note. Never read
   *  the argument binding inside the frozen callbacks. */
  const renderedIdsHolderRef = useRef(renderedIdsRef);
  if (renderedIdsHolderRef.current === undefined) renderedIdsHolderRef.current = renderedIdsRef;

  /** Drop the anchor — called when the partition re-freezes (pull-to-refresh,
   *  session resume), since the rendered order is about to be rebuilt. */
  const resetDeepestSeen = useCallback(() => {
    deepestSeenIdRef.current = null;
  }, []);
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
  const measureOnScreenRef = useRef<() => void>(() => {});

  /** Trailing coalesce, NON-resetting: a re-arming debounce would never fire
   *  during a continuous scroll. */
  const scheduleFlush = useCallback(() => {
    if (flushTimerRef.current) return;
    flushTimerRef.current = setTimeout(() => {
      flushTimerRef.current = null;
      flushSkipsRef.current();
    }, SKIP_FLUSH_DEBOUNCE_MS);
  }, []);

  /** The bottom edge left the band (or the row left the screen): buffer it if
   *  it stayed for the full dwell. Refs only, never a store write. */
  const exitBand = useCallback(
    (id: string, now: number) => {
      const at = enterAtRef.current.get(id);
      if (at === undefined) return;
      enterAtRef.current.delete(id);
      if (now - at >= SKIP_DWELL_MS) {
        skipBufferRef.current.add(id);
        scheduleFlush();
      }
    },
    [scheduleFlush],
  );
  const exitBandRef = useRef(exitBand);
  exitBandRef.current = exitBand;

  /** Measure the on-screen rows and move each in or out of the band. */
  const measureOnScreen = useCallback(() => {
    const getBand = bandHolderRef.current?.current;
    if (!getBand) return;
    const band = getBand();
    for (const id of onScreenRef.current) {
      const node = rowNodesRef.current.get(id);
      if (!node || typeof node.measureInWindow !== 'function') continue;
      try {
        node.measureInWindow((_x, y, _w, h) => {
          // Not laid out yet: retried (ladder, then ticks), never timed.
          if (!(h > 0)) return;
          const bottom = y + h;
          const inBand = bottom >= band.top && bottom <= band.bottom;
          const now = Date.now();
          if (inBand) {
            if (!enterAtRef.current.has(id)) enterAtRef.current.set(id, now);
          } else {
            exitBandRef.current(id, now);
          }
        });
      } catch {
        // A row unmounting mid-measure: nothing to time.
      }
    }
  }, []);

  measureOnScreenRef.current = measureOnScreen;
  useEffect(() => subscribeScrollTick(measureOnScreen), [measureOnScreen]);

  /** Pending ladder re-measures; cleared on unmount. */
  const ladderTimersRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());
  const measureLadderRef = useRef(() => {});
  measureLadderRef.current = () => {
    measureOnScreenRef.current();
    for (const ms of MEASURE_RETRY_LADDER_MS) {
      const t = setTimeout(() => {
        ladderTimersRef.current.delete(t);
        measureOnScreenRef.current();
      }, ms);
      ladderTimersRef.current.add(t);
    }
  };

  /** `ref={registerRow(id)}` on each row's outer view. Stable per id. */
  const registerRow = useCallback((id: string) => {
    let cb = rowRefCallbacksRef.current.get(id);
    if (!cb) {
      cb = (node: MeasurableRow | null) => {
        if (node) rowNodesRef.current.set(id, node);
        else rowNodesRef.current.delete(id);
      };
      rowRefCallbacksRef.current.set(id, cb);
    }
    return cb;
  }, []);

  // Built ONCE via a ref (FlatList forbids mutating this prop after mount).
  const pairs = useRef([
    {
      // ── The pinned-prefix ANCHOR only (75%, unchanged), so where arrivals
      //    land does not move. It no longer times "seen". ──
      viewabilityConfig: {
        itemVisiblePercentThreshold: 75,
        minimumViewTime: 0,
      },
      onViewableItemsChanged: ({ changed }: { changed: ViewToken[] }) => {
        const renderedIds = renderedIdsHolderRef.current?.current;
        if (!renderedIds || renderedIds.length === 0) return;
        for (const v of changed) {
          if (!v.isViewable) continue;
          const id = tokenId(v);
          if (!id) continue;
          // Depth is resolved against the CURRENT rendered story order, never
          // the token's own `index` (which counts divider sentinels the pin's
          // story-only array does not have).
          const next = renderedIds.indexOf(id);
          if (next < 0) continue;
          const cur = deepestSeenIdRef.current ? renderedIds.indexOf(deepestSeenIdRef.current) : -1;
          // `cur === -1` (anchor row dropped) lets any viewable row win. Safe:
          // the pin itself is monotonic in `extendPinnedIds`.
          if (next > cur) deepestSeenIdRef.current = id;
        }
      },
    },
    {
      // ── Which rows are on screen AT ALL: the only ones measured on a tick.
      //    Leaving the screen ends a row's time in the band. ──
      viewabilityConfig: {
        itemVisiblePercentThreshold: 1,
        minimumViewTime: 0,
      },
      onViewableItemsChanged: ({ changed }: { changed: ViewToken[] }) => {
        const now = Date.now();
        for (const v of changed) {
          const id = tokenId(v);
          if (!id) continue;
          if (v.isViewable) {
            onScreenRef.current.add(id);
          } else {
            onScreenRef.current.delete(id);
            exitBandRef.current(id, now);
          }
        }
        // A list at rest is not waiting for a scroll: measure now, then on
        // TranslatableDynamic's retry ladder, because under Fabric a freshly
        // mounted cell's `measureInWindow` can return without ever calling back.
        measureLadderRef.current();
      },
    },
  ]);

  // Flush on unmount so a partially-filled buffer isn't lost.
  useEffect(
    () => () => {
      for (const t of ladderTimersRef.current) clearTimeout(t);
      ladderTimersRef.current.clear();
      flushSkipsRef.current();
    },
    [],
  );

  return {
    viewabilityConfigCallbackPairs: pairs.current,
    flushSkips,
    deepestSeenIdRef,
    resetDeepestSeen,
    registerRow,
  };
}
