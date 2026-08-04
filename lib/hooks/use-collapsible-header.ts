// use-collapsible-header — the shared collapsing-header controller for the
// Dashboard. A scroll handler accumulates directional travel and hides the
// whole header once the user has scrolled down past a small threshold (and past
// the header's own height); a slight upward flick — or reaching the top —
// reveals it again. `reveal()` is a JS-callable escape hatch for state
// transitions that must always show the header (errors, offline, sub-tab switch).
//
// Uses Reanimated shared values + a worklet scroll handler so the translate runs
// entirely on the UI thread. The header is expected to be an absolutely
// positioned `Animated.View` whose `translateY` is driven by `headerStyle`, with
// the scrollable content padded by `headerHeight`.

import { useCallback, useState } from 'react';
import type { LayoutChangeEvent } from 'react-native';
import {
  useAnimatedScrollHandler,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';

/** Cumulative downward travel (px) before the header hides. */
const DOWN_THRESHOLD = 24;
/** Cumulative upward travel (px) before the header reveals. */
const UP_THRESHOLD = 12;
const DURATION = 220;

export interface CollapsibleHeader {
  /** Worklet scroll handler — wire to the scrollable's `onScroll`. */
  scrollHandler: ReturnType<typeof useAnimatedScrollHandler>;
  /** Animated style for the absolute header `Animated.View` (translateY only —
   *  kept as this narrow shape so it stays View-style compatible, avoiding the
   *  broad `DefaultStyle` union's `cursor` clash with `Animated.View`). */
  headerStyle: { transform: { translateY: number }[] };
  /** `onLayout` for the header — measures its height (drives both the hide
   *  distance and the content `paddingTop`). */
  onHeaderLayout: (e: LayoutChangeEvent) => void;
  /** Measured header height (React state) — use for the content `paddingTop`. */
  headerHeight: number;
  /** Force the header fully revealed (JS-callable). */
  reveal: () => void;
  /**
   * Tell the handler to treat the NEXT scroll event as a new baseline rather
   * than as travel. JS-callable.
   *
   * Only needed when ONE handler is shared by SEVERAL independently-scrolled
   * lists — the Dashboard, whose four sub-tab panels stay mounted behind
   * `display:'none'` and keep their own offsets. `lastY` is a single shared
   * value, so it holds whichever panel scrolled last; switching to a panel at a
   * different offset makes the first event's `dy` the DIFFERENCE BETWEEN TWO
   * PANELS. With Overview at 1500 and Saved at 800 that is a −690 spurious
   * reveal, and in the other direction the header hides while the user is
   * scrolling up.
   *
   * `reveal()` is not a substitute: it clears the accumulators but not `lastY`,
   * which is the value actually carrying the cross-panel offset.
   *
   * INERT unless called. Feed and Explore each own their own hook instance with
   * a single list, never call this, and are byte-identical to before it existed.
   */
  resetScrollOrigin: () => void;
}

export function useCollapsibleHeader(): CollapsibleHeader {
  // 0 = fully shown, 1 = fully hidden (animated target).
  const hidden = useSharedValue(0);
  const lastY = useSharedValue(0);
  const downAccum = useSharedValue(0);
  const upAccum = useSharedValue(0);
  const headerH = useSharedValue(0);
  // Set by `resetScrollOrigin()`; consumed by the next scroll event. Default
  // false, so a caller that never resets sees the original handler exactly.
  const originStale = useSharedValue(false);
  const [headerHeight, setHeaderHeight] = useState(0);

  const scrollHandler = useAnimatedScrollHandler({
    onScroll: (e) => {
      const y = e.contentOffset.y;
      // Ignore iOS rubber-band overscroll above the top.
      if (y < 0) return;

      // A different list is now driving this handler (Dashboard sub-tab switch).
      // Adopt its offset as the baseline and read NO travel from this event —
      // `dy` here would be the difference between two panels' scroll positions,
      // not anything the user did. Must come before `dy` is computed.
      if (originStale.value) {
        originStale.value = false;
        lastY.value = y;
        return;
      }

      const dy = y - lastY.value;
      lastY.value = y;

      if (y <= 0) {
        // At the very top: always reveal, reset accumulators.
        downAccum.value = 0;
        upAccum.value = 0;
        hidden.value = withTiming(0, { duration: DURATION });
        return;
      }

      if (dy > 0) {
        // Scrolling down — accumulate, reset the opposite direction.
        downAccum.value += dy;
        upAccum.value = 0;
        if (downAccum.value > DOWN_THRESHOLD && y > headerH.value) {
          hidden.value = withTiming(1, { duration: DURATION });
        }
      } else if (dy < 0) {
        upAccum.value += -dy;
        downAccum.value = 0;
        if (upAccum.value > UP_THRESHOLD) {
          hidden.value = withTiming(0, { duration: DURATION });
        }
      }
    },
  });

  const headerStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: -hidden.value * headerH.value }],
  }));

  const onHeaderLayout = useCallback(
    (e: LayoutChangeEvent) => {
      const h = e.nativeEvent.layout.height;
      headerH.value = h;
      setHeaderHeight(h);
    },
    // shared value ref is stable; no deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const reveal = useCallback(() => {
    downAccum.value = 0;
    upAccum.value = 0;
    hidden.value = withTiming(0, { duration: DURATION });
    // Deliberately does NOT touch `lastY` — see `resetScrollOrigin`. Feed and
    // Explore call `reveal()` MID-SCROLL on error/offline states, so rebasing
    // the origin here would make their next event read as a large positive `dy`
    // and hide the header under the user.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const resetScrollOrigin = useCallback(() => {
    originStale.value = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return {
    scrollHandler,
    headerStyle,
    onHeaderLayout,
    headerHeight,
    reveal,
    resetScrollOrigin,
  };
}
