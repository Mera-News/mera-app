// The page swipe: one row of full-size panels a finger drags sideways, and,
// past a tab's last (or before its first) page, an edge label naming the
// next tab that takes over once pulled far enough.
//
//  - Windowed: the active panel, its neighbours and any keep-mounted page
//    (`swipeWindow`), the ACTIVE ONE FIRST (react-native-screens and UIKit walk
//    `subviews[0]`). Each panel is keyed by its page id and positioned at
//    dir*i*W in one row translated to -dir*index*W, so a reorder or the
//    window moving never remounts a page that stays.
//  - Manual activation: a touch is decided on its FIRST movement
//    (`swipeDecision`), before a fast fling ends. Inside a registered
//    horizontal scroller (the Stats pager) the swipe takes over only at that
//    scroller's edge in the drag's OWN direction (at the last card a drag
//    toward the next page hands off, a drag back stays in the scroller); a
//    bouncing ScrollView never fails, so waiting for it cannot work. The
//    scroller is known at touch DOWN (a Manual gesture), never at its pan's
//    begin, which comes after the decision.
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
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSpring,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';
import { MaterialIcons } from '@expo/vector-icons';

import { Text } from '@/components/ui/text';
import { notifyScrollTick } from '@/lib/visibility-tick';

import { SwipeBlockerContext } from './swipe-blocker';
import { SWIPE_DAMPING, fractionalIndex, swipeDecision, swipeOutcome, swipeWindow } from './tab-swipe';
import type { SwipeBlocker } from './types';

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
  const [width, setWidth] = useState(0);
  const [moving, setMoving] = useState(false);
  const reduceMotion = useReducedMotion();
  const rtl = I18nManager.isRTL;
  const dir = rtl ? -1 : 1;
  const base = -dir * index * width;
  const offset = useSharedValue(base);

  useLayoutEffect(() => {
    offset.value = base;
    progress.value = index;
  }, [base, offset, progress, index]);

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

  // ── The registered horizontal scroller (Stats pager) ──
  // "The touch started inside the scroller" must be known at TOUCH DOWN. A
  // Native gesture's `onBegin` arrives only once the scroll view's own pan
  // begins, after its slop, i.e. AFTER the page swipe has already decided:
  // measured on device, a right fling on the last card read as "outside the
  // scroller" and changed page instead of card. A Manual gesture reports its
  // touches at once and never activates, so it never blocks the scroll view.
  const inScroller = useSharedValue(false);
  const atStart = useSharedValue(true);
  const atEnd = useSharedValue(true);
  const blockerRef = useRef<unknown>(null);
  const scrollerGesture = useMemo(
    () =>
      Gesture.Manual()
        .onTouchesDown(() => {
          inScroller.value = true;
        })
        .onTouchesUp((e) => {
          if (e.numberOfTouches === 0) inScroller.value = false;
        })
        .onTouchesCancelled(() => {
          inScroller.value = false;
        })
        .onFinalize(() => {
          inScroller.value = false;
        }),
    [inScroller],
  );
  const blocker = useMemo<SwipeBlocker>(
    () => ({
      gesture: scrollerGesture,
      ref: blockerRef,
      setEdge: (e) => {
        atStart.value = e.start;
        atEnd.value = e.end;
      },
    }),
    [scrollerGesture, atStart, atEnd],
  );

  const onLayout = useCallback((e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width), []);

  const settle = useCallback(() => setMoving(false), []);
  const land = useCallback(
    (next: number) => {
      setMoving(false);
      onIndexChange(next);
    },
    [onIndexChange],
  );

  const springBack = useCallback(() => {
    progress.value = index;
    if (reduceMotion) {
      offset.value = base;
      setMoving(false);
      return;
    }
    offset.value = withSpring(base, undefined, (finished) => {
      if (finished) runOnJS(settle)();
    });
  }, [reduceMotion, base, offset, settle, progress, index]);

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
        progress.value = index;
        setMoving(false);
        onTabStep(outcome.step);
        return;
      }
      const target = -dir * outcome.index * width;
      progress.value = outcome.index;
      if (reduceMotion || width <= 0) {
        offset.value = target;
        land(outcome.index);
        return;
      }
      offset.value = withTiming(target, { duration: SLIDE_MS }, (finished) => {
        if (finished) runOnJS(land)(outcome.index);
      });
    },
    [width, index, count, rtl, prevTabLabel, nextTabLabel, springBack, offset, base, progress, onTabStep, dir, reduceMotion, land],
  );

  const startX = useSharedValue(0);
  const startY = useSharedValue(0);
  const decided = useSharedValue(false);

  const pan = useMemo(
    () =>
      Gesture.Pan()
        .enabled(enabled)
        .manualActivation(true)
        .hitSlop({ left: -EDGE_INSET, right: -EDGE_INSET })
        .simultaneousWithExternalGesture(scrollerGesture)
        .onTouchesDown((e) => {
          const t = e.allTouches[0];
          if (!t) return;
          startX.value = t.absoluteX;
          startY.value = t.absoluteY;
          decided.value = false;
        })
        .onTouchesMove((e, state) => {
          if (decided.value) return;
          const t = e.allTouches[0];
          if (!t) return;
          const decision = swipeDecision({
            dx: t.absoluteX - startX.value,
            dy: t.absoluteY - startY.value,
            inScroller: inScroller.value,
            atStart: atStart.value,
            atEnd: atEnd.value,
            rtl,
          });
          if (decision === 'wait') return;
          decided.value = true;
          if (decision === 'fail') state.fail();
          else state.activate();
        })
        .onStart(() => {
          runOnJS(setMoving)(true);
        })
        .onUpdate((e) => {
          progress.value = fractionalIndex(index, e.translationX, width, rtl);
          if (!reduceMotion) offset.value = base + e.translationX * SWIPE_DAMPING;
        })
        .onEnd((e) => {
          runOnJS(finish)(e.translationX, e.velocityX);
        }),
    [enabled, scrollerGesture, startX, startY, decided, inScroller, atStart, atEnd, rtl, progress, index, width, reduceMotion, offset, base, finish],
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
          <MaterialIcons name={rtl ? 'chevron-right' : 'chevron-left'} size={22} color="#FFFFFF" />
        ) : null}
        <Text size="lg" bold className="text-white">
          {label}
        </Text>
        {side === 'next' ? (
          <MaterialIcons name={rtl ? 'chevron-left' : 'chevron-right'} size={22} color="#FFFFFF" />
        ) : null}
      </View>
    </View>
  );

  return (
    <SwipeBlockerContext.Provider value={blocker}>
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
    </SwipeBlockerContext.Provider>
  );
};

const styles = StyleSheet.create({
  viewport: { flex: 1, overflow: 'hidden' },
  edge: { justifyContent: 'center', paddingHorizontal: 20 },
  edgeRow: { flexDirection: 'row', alignItems: 'center', gap: 2 },
});

export default PagePager;
