// The page swipe: one row of full-size panels a finger drags sideways,
// between THIS tab's pages only. Past the first or last page the row resists
// and springs back; a swipe never changes the bottom tab (owner).
//
//  - Windowed: the active panel, its neighbours and any keep-mounted page
//    (`swipeWindow`), the ACTIVE ONE FIRST (react-native-screens and UIKit walk
//    `subviews[0]`). Each panel is keyed by its page id and positioned at
//    dir*i*W in one row translated to -dir*index*W, so a reorder or the
//    window moving never remounts a page that stays.
//  - One RNGH pan: activates on a clear sideways move (activeOffsetX 25) and
//    fails on a vertical one (failOffsetY 12), so lists still scroll. No page
//    holds a horizontal scroller: nothing negotiates with this pan.
//  - Built ONCE: its worklets read the page and width from shared values and
//    the end of a drag calls the latest `finish` through a ref, because RNGH
//    applies a rebuilt gesture's callbacks asynchronously (B4c).
//  - 24pt edge insets leave the screen edges to the system back gesture.
//  - Off-screen panels get no touches and are hidden from accessibility; a
//    page gates its own work on `active`. While a drag or slide is in flight
//    no panel takes a touch, so a sideways drag never opens a card.
//  - Any other page change (a tap on the track, a deep link) SLIDES too
//    (TAP_SLIDE_MS, ease-out), never a jump. Skipping pages (Feed ->
//    Notifications), the picked panel borrows the slot NEXT to the old page
//    (tapTransit), so the row moves one width and no middle page shows; the
//    page that owns that slot hides. Placement and hiding are animated styles
//    on the shared `transit`, and the slide's end clears it and moves the row
//    to the real slot in ONE UI-thread callback, so the hand-off has no frame
//    where React and the row disagree. The old page stays mounted until then.
//    `progress` maps the one-width slide onto from -> to (transitProgress),
//    so the track's fill moves straight from option to option.
//  - LITE KEEPS THESE MOTIONS (owner exception to the Lite rule: a tab's
//    page change still slides); only the system's Reduce Motion snaps. Every
//    timing here says ReduceMotion.Never, because LiteMotionConfig forces
//    Reanimated's own reduce-motion on in Lite and would land them at once.
//  - Reduce Motion: no drag follow and no slide; a
//    change snaps. A second tap mid-slide snaps too.

import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { I18nManager, StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  Easing,
  ReduceMotion,
  runOnJS,
  useAnimatedReaction,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSpring,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';

import { notifyScrollTick } from '@/lib/visibility-tick';

import {
  dragFollow,
  NO_TRANSIT,
  SWIPE_ACTIVATE_PX,
  SWIPE_VERTICAL_FAIL_PX,
  swipeOutcome,
  swipeWindow,
  tapTransit,
  transitPanel,
  transitProgress,
  type Transit,
} from './tab-swipe';

/** Leaves the screen edges to the system back gesture. */
const EDGE_INSET = 24;
const SLIDE_MS = 180;
/** A tap's slide to the picked page. */
const TAP_SLIDE_MS = 300;
/** After the active page changes, when to re-measure: the row has landed. */
const ARRIVAL_TICK_MS = 50;

export interface PagePagerProps {
  readonly index: number;
  readonly count: number;
  readonly keyOf: (i: number) => string;
  readonly renderPanel: (i: number, active: boolean) => React.ReactNode;
  /** Indices never unmounted (the Feed). */
  readonly keep: readonly number[];
  readonly onIndexChange: (next: number) => void;
  /** False while the Arrange overlay is open: no page swipe. */
  readonly enabled: boolean;
  /** Fractional page index, for readers outside the tree (Mera button). */
  readonly progress: SharedValue<number>;
  readonly testID?: string;
}

const PagePager: React.FC<PagePagerProps> = ({
  index,
  count,
  keyOf,
  renderPanel,
  keep,
  onIndexChange,
  enabled,
  progress,
  testID,
}) => {
  const [width, setWidth] = useState(0);
  const [moving, setMoving] = useState(false);
  // The system setting only (Reanimated's hook ignores LiteMotionConfig):
  // Lite keeps the tab transitions (owner).
  const reduceMotion = !!useReducedMotion();
  const rtl = I18nManager.isRTL;
  const dir = rtl ? -1 : 1;
  const base = -dir * index * width;
  const offset = useSharedValue(base);
  const transit = useSharedValue<Transit>(NO_TRANSIT);
  // A swipe that lands changes the index itself: that is no tap slide.
  const landing = useRef(false);
  // JS truth for "a tap slide is in flight". Never read `transit.value` on
  // JS: a write from JS reaches the UI thread a tick later, so reading it
  // back returns the OLD value.
  const sliding = useRef(false);
  // Which slide an end belongs to: a late end of a cut-short slide must not
  // end a newer one.
  const slideId = useRef(0);
  // The page a tap slide leaves stays mounted until the slide lands. Decided
  // while rendering the new index, so the old page is never dropped for a
  // frame (and its scroll position kept).
  const [shown, setShown] = useState({ index, leaving: -1 });
  if (shown.index !== index) {
    const slides = !landing.current && !reduceMotion && width > 0 && !sliding.current;
    setShown({ index, leaving: slides ? shown.index : -1 });
  }
  const leaving = shown.index === index ? shown.leaving : -1;

  // What the UI thread reads mid-gesture. RNGH applies a NEW gesture's
  // callbacks asynchronously, so a pan built over render values (index,
  // width) ran STALE ones for a touch right after a page or tab change: a
  // fling just after arriving on a page was judged against the previous page
  // (or a 0 width before the first layout) and silently sprang back (B4c,
  // captured). The pan is therefore built once and reads these.
  const indexSV = useSharedValue(index);
  const widthSV = useSharedValue(width);
  const countSV = useSharedValue(count);
  const reduceMotionSV = useSharedValue(!!reduceMotion);
  const endSlide = useCallback((id: number) => {
    if (id !== slideId.current) return;
    sliding.current = false;
    setShown((s) => ({ index: s.index, leaving: -1 }));
    setMoving(false);
  }, []);
  // Before the sync below, so a slide it starts is not snapped back.
  useLayoutEffect(() => {
    landing.current = false;
    if (leaving < 0) {
      // A second tap mid-slide: the slide is dropped and the row snaps (the
      // sync effect below); its callback sees finished=false.
      if (sliding.current) {
        slideId.current++;
        sliding.current = false;
        setMoving(false);
      }
      transit.value = NO_TRANSIT;
      return;
    }
    const t = tapTransit(leaving, index);
    const id = ++slideId.current;
    sliding.current = true;
    setMoving(true);
    transit.value = t;
    offset.value = withTiming(
      -dir * t[2] * width,
      { duration: TAP_SLIDE_MS, easing: Easing.out(Easing.cubic), reduceMotion: ReduceMotion.Never },
      (finished) => {
        // Landed: the picked page back in its own slot and the row moved to
        // it, in this ONE UI-thread callback. Cut short: the snap that cut
        // it already placed the row; just let go of the slide.
        transit.value = NO_TRANSIT;
        if (finished) offset.value = -dir * indexSV.value * widthSV.value;
        runOnJS(endSlide)(id);
      },
    );
    // Only a new index (and the decision made for it) starts a slide.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index]);
  useLayoutEffect(() => {
    if (!sliding.current) {
      offset.value = base;
      progress.value = index;
    }
    indexSV.value = index;
    widthSV.value = width;
    countSV.value = count;
    reduceMotionSV.value = !!reduceMotion;
  }, [base, offset, progress, index, width, count, indexSV, widthSV, countSV, reduceMotion, reduceMotionSV, transit]);

  // The arriving panel's translated titles were measured a width away (off
  // screen), and nothing ticks on arrival until the reader scrolls.
  // A tap slide arrives when it lands (leaving back to -1).
  const firstIndex = useRef(true);
  useEffect(() => {
    if (firstIndex.current) {
      firstIndex.current = false;
      return;
    }
    if (leaving >= 0) return;
    const id = setTimeout(notifyScrollTick, ARRIVAL_TICK_MS);
    return () => clearTimeout(id);
  }, [index, leaving]);

  const onLayout = useCallback((e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width), []);

  const settle = useCallback(() => setMoving(false), []);
  const land = useCallback(
    (next: number) => {
      setMoving(false);
      onIndexChange(next);
    },
    [onIndexChange],
  );

  // `progress` follows the row itself, so a reader (the segmented strip's
  // orange pill, the Mera button's fade) tracks the drag AND the slide after
  // it, never jumping to the landing index.
  useAnimatedReaction(
    () => offset.value,
    (o) => {
      if (widthSV.value > 0) progress.value = transitProgress((-dir * o) / widthSV.value, transit.value);
    },
  );

  const springBack = useCallback(() => {
    if (reduceMotion) {
      offset.value = base;
      setMoving(false);
      return;
    }
    offset.value = withSpring(base, { reduceMotion: ReduceMotion.Never }, (finished) => {
      if (finished) runOnJS(settle)();
    });
  }, [reduceMotion, base, offset, settle]);

  const finish = useCallback(
    (dx: number, vx: number) => {
      const outcome = swipeOutcome({ dx, vx, width, index, count, rtl });
      if (outcome === null) {
        springBack();
        return;
      }
      const target = -dir * outcome.index * width;
      landing.current = outcome.index !== index;
      if (reduceMotion || width <= 0) {
        offset.value = target;
        land(outcome.index);
        return;
      }
      offset.value = withTiming(target, { duration: SLIDE_MS, reduceMotion: ReduceMotion.Never }, (finished) => {
        if (finished) runOnJS(land)(outcome.index);
      });
    },
    [width, index, count, rtl, springBack, offset, dir, reduceMotion, land],
  );

  // The JS side of the end of a drag always runs the LATEST `finish`.
  const finishRef = useRef(finish);
  finishRef.current = finish;
  const onDragEnd = useCallback((dx: number, vx: number) => finishRef.current(dx, vx), []);

  const pan = useMemo(
    () =>
      Gesture.Pan()
        .enabled(enabled)
        .activeOffsetX([-SWIPE_ACTIVATE_PX, SWIPE_ACTIVATE_PX])
        .failOffsetY([-SWIPE_VERTICAL_FAIL_PX, SWIPE_VERTICAL_FAIL_PX])
        .hitSlop({ left: -EDGE_INSET, right: -EDGE_INSET })
        .onStart(() => {
          runOnJS(setMoving)(true);
        })
        // A drag that starts during a tap slide does nothing (the slide owns
        // the row until it lands).
        .onUpdate((e) => {
          if (transit.value[0] >= 0) return;
          if (!reduceMotionSV.value) {
            offset.value =
              -dir * indexSV.value * widthSV.value + dragFollow(e.translationX, indexSV.value, countSV.value, dir === -1);
          }
        })
        .onEnd((e) => {
          if (transit.value[0] >= 0) return;
          runOnJS(onDragEnd)(e.translationX, e.velocityX);
        }),
    [enabled, dir, indexSV, widthSV, countSV, reduceMotionSV, offset, onDragEnd, transit],
  );

  const rowStyle = useAnimatedStyle(() => ({ transform: [{ translateX: offset.value }] }));

  // Until the width is known a neighbour would land on top of the active
  // panel, so only the active one (and kept pages) is drawn.
  const window = swipeWindow(index, count, keep).filter((i) => width > 0 || i === index || keep.includes(i));
  const mounted = leaving >= 0 && !window.includes(leaving) ? [...window, leaving] : window;

  return (
      <GestureDetector gesture={pan}>
        <View style={styles.viewport} onLayout={onLayout} testID={testID}>
          <Animated.View style={[StyleSheet.absoluteFill, rowStyle]} testID={testID ? `${testID}-row` : undefined}>
            {mounted.map((i) => {
              const active = i === index;
              const key = keyOf(i);
              return (
                <Panel
                  key={key}
                  i={i}
                  step={dir * width}
                  transit={transit}
                  testID={testID ? `${testID}-panel-${key}` : undefined}
                  pointerEvents={active && !moving ? 'auto' : 'none'}
                  accessibilityElementsHidden={!active}
                  importantForAccessibility={active ? 'auto' : 'no-hide-descendants'}
                >
                  {renderPanel(i, active)}
                </Panel>
              );
            })}
          </Animated.View>
        </View>
      </GestureDetector>
  );
};

/** One page in the row, at its slot (or the slot a tap slide lends it). */
function Panel({
  i,
  step,
  transit,
  children,
  ...rest
}: {
  i: number;
  step: number;
  transit: SharedValue<Transit>;
  children: React.ReactNode;
  testID?: string;
  pointerEvents: 'auto' | 'none';
  accessibilityElementsHidden: boolean;
  importantForAccessibility: 'auto' | 'no-hide-descendants';
}) {
  const place = useAnimatedStyle(() => {
    const p = transitPanel(i, transit.value);
    return { opacity: p.hidden ? 0 : 1, transform: [{ translateX: p.slot * step }] };
  }, [i, step]);
  return (
    <Animated.View {...rest} style={[StyleSheet.absoluteFill, place]}>
      {children}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  viewport: { flex: 1, overflow: 'hidden' },
});

export default PagePager;
