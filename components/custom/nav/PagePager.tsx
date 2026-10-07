// The page swipe: one row of full-size panels a finger drags sideways, and,
// past a tab's last (or before its first) page, an edge label naming the
// next tab that takes over once pulled far enough.
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
//  - Reduce Motion: no drag follow and no slide; a commit snaps.

import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { I18nManager, StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  runOnJS,
  useAnimatedReaction,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSpring,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';
import { MaterialIcons } from '@expo/vector-icons';

import { Text } from '@/components/ui/text';
import { useColors } from '@/lib/theme/tokens';
import { notifyScrollTick } from '@/lib/visibility-tick';

import {
  SWIPE_ACTIVATE_PX,
  SWIPE_DAMPING,
  SWIPE_VERTICAL_FAIL_PX,
  swipeOutcome,
  swipeWindow,
} from './tab-swipe';

/** Leaves the screen edges to the system back gesture. */
const EDGE_INSET = 24;
const SLIDE_MS = 180;
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
  /** Called past the ends; omit a label for "no tab that way". */
  readonly onTabStep: (step: 1 | -1) => void;
  readonly prevTabLabel?: string;
  readonly nextTabLabel?: string;
  /** False while the Arrange overlay is open: no page swipe. */
  readonly enabled: boolean;
  /** Fractional page index, for readers outside the tree (Mera button). */
  readonly progress: SharedValue<number>;
  /** Opacity of the page row (the cross-tab arrival fade). Applied on the
   *  row itself, so the pager adds no wrapper view: the native scroll-view
   *  walks (`subviews[0]`) see the same depth the old SwipeTabs had. */
  readonly contentOpacity?: SharedValue<number>;
  readonly testID?: string;
}

const PagePager: React.FC<PagePagerProps> = ({
  index,
  count,
  keyOf,
  renderPanel,
  keep,
  onIndexChange,
  onTabStep,
  prevTabLabel,
  nextTabLabel,
  enabled,
  progress,
  contentOpacity,
  testID,
}) => {
  const colors = useColors();
  const [width, setWidth] = useState(0);
  const [moving, setMoving] = useState(false);
  const reduceMotion = useReducedMotion();
  const rtl = I18nManager.isRTL;
  const dir = rtl ? -1 : 1;
  const base = -dir * index * width;
  const offset = useSharedValue(base);

  // What the UI thread reads mid-gesture. RNGH applies a NEW gesture's
  // callbacks asynchronously, so a pan built over render values (index,
  // width) ran STALE ones for a touch right after a page or tab change: a
  // fling just after arriving on a page was judged against the previous page
  // (or a 0 width before the first layout) and silently sprang back (B4c,
  // captured). The pan is therefore built once and reads these.
  const indexSV = useSharedValue(index);
  const widthSV = useSharedValue(width);
  const reduceMotionSV = useSharedValue(!!reduceMotion);
  useLayoutEffect(() => {
    offset.value = base;
    progress.value = index;
    indexSV.value = index;
    widthSV.value = width;
    reduceMotionSV.value = !!reduceMotion;
  }, [base, offset, progress, index, width, indexSV, widthSV, reduceMotion, reduceMotionSV]);

  // The arriving panel's translated titles were measured a width away (off
  // screen), and nothing ticks on arrival until the reader scrolls.
  const firstIndex = useRef(true);
  useEffect(() => {
    if (firstIndex.current) {
      firstIndex.current = false;
      return;
    }
    const id = setTimeout(notifyScrollTick, ARRIVAL_TICK_MS);
    return () => clearTimeout(id);
  }, [index]);

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
      if (widthSV.value > 0) progress.value = (-dir * o) / widthSV.value;
    },
  );

  const springBack = useCallback(() => {
    if (reduceMotion) {
      offset.value = base;
      setMoving(false);
      return;
    }
    offset.value = withSpring(base, undefined, (finished) => {
      if (finished) runOnJS(settle)();
    });
  }, [reduceMotion, base, offset, settle]);

  const finish = useCallback(
    (dx: number, vx: number) => {
      const outcome = swipeOutcome({
        dx,
        vx,
        width,
        index,
        count,
        rtl,
        hasPrevTab: prevTabLabel !== undefined,
        hasNextTab: nextTabLabel !== undefined,
      });
      if (outcome === null) {
        springBack();
        return;
      }
      if (outcome.kind === 'tab') {
        // The next tab takes over; this one is left as it was.
        offset.value = base;
        setMoving(false);
        onTabStep(outcome.step);
        return;
      }
      const target = -dir * outcome.index * width;
      if (reduceMotion || width <= 0) {
        offset.value = target;
        land(outcome.index);
        return;
      }
      offset.value = withTiming(target, { duration: SLIDE_MS }, (finished) => {
        if (finished) runOnJS(land)(outcome.index);
      });
    },
    [width, index, count, rtl, prevTabLabel, nextTabLabel, springBack, offset, base, onTabStep, dir, reduceMotion, land],
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
        .onUpdate((e) => {
          if (!reduceMotionSV.value) {
            offset.value = -dir * indexSV.value * widthSV.value + e.translationX * SWIPE_DAMPING;
          }
        })
        .onEnd((e) => {
          runOnJS(onDragEnd)(e.translationX, e.velocityX);
        }),
    [enabled, dir, indexSV, widthSV, reduceMotionSV, offset, onDragEnd],
  );

  const rowStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: offset.value }],
    opacity: contentOpacity ? contentOpacity.value : 1,
  }));

  // Until the width is known a neighbour would land on top of the active
  // panel, so only the active one (and kept pages) is drawn.
  const mounted = swipeWindow(index, count, keep).filter(
    (i) => width > 0 || i === index || keep.includes(i),
  );

  const edgeLabel = (at: number, label: string, side: 'prev' | 'next') => (
    <View
      key={`edge-${side}`}
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      testID={testID ? `${testID}-edge-${side}` : undefined}
      style={[
        StyleSheet.absoluteFill,
        styles.edge,
        { transform: [{ translateX: dir * at * width }], alignItems: side === 'next' ? 'flex-start' : 'flex-end' },
      ]}
    >
      <View style={styles.edgeRow}>
        {side === 'prev' ? (
          <MaterialIcons name={rtl ? 'chevron-right' : 'chevron-left'} size={22} color={colors.ink} />
        ) : null}
        <Text size="lg" bold className="text-ink">
          {label}
        </Text>
        {side === 'next' ? (
          <MaterialIcons name={rtl ? 'chevron-left' : 'chevron-right'} size={22} color={colors.ink} />
        ) : null}
      </View>
    </View>
  );

  return (
      <GestureDetector gesture={pan}>
        <View style={styles.viewport} onLayout={onLayout} testID={testID}>
          <Animated.View style={[StyleSheet.absoluteFill, rowStyle]} testID={testID ? `${testID}-row` : undefined}>
            {mounted.map((i) => {
              const active = i === index;
              const key = keyOf(i);
              return (
                <View
                  key={key}
                  testID={testID ? `${testID}-panel-${key}` : undefined}
                  style={[StyleSheet.absoluteFill, { transform: [{ translateX: dir * i * width }] }]}
                  pointerEvents={active && !moving ? 'auto' : 'none'}
                  accessibilityElementsHidden={!active}
                  importantForAccessibility={active ? 'auto' : 'no-hide-descendants'}
                >
                  {renderPanel(i, active)}
                </View>
              );
            })}
            {width > 0 && index === count - 1 && nextTabLabel ? edgeLabel(count, nextTabLabel, 'next') : null}
            {width > 0 && index === 0 && prevTabLabel ? edgeLabel(-1, prevTabLabel, 'prev') : null}
          </Animated.View>
        </View>
      </GestureDetector>
  );
};

const styles = StyleSheet.create({
  viewport: { flex: 1, overflow: 'hidden' },
  edge: { justifyContent: 'center', paddingHorizontal: 20 },
  edgeRow: { flexDirection: 'row', alignItems: 'center', gap: 2 },
});

export default PagePager;
