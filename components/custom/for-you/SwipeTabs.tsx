// Swipe left/right between tabs (ux2 B3), for the Dashboard pills and the
// Explore scopes. No pager library: an RNGH Pan on the CONTENT only (never the
// header, whose pill row scrolls horizontally itself), and Reanimated for the
// slide. Both are in the binary, so this ships over the air.
//
//  - The pan activates only on a clear horizontal move (activeOffsetX 25) and
//    fails on a vertical one (failOffsetY 12), so list scrolling and
//    pull-to-refresh keep working. A 24pt edge inset (negative hitSlop) leaves
//    the screen edges to the system back gesture.
//  - A horizontal scroller INSIDE the content (the Dashboard's breaking strip)
//    registers through `useSwipeTabsBlocker()`: the pan waits for it to fail,
//    so the strip scrolls on its own.
//  - Where the drag lands is the pure `swipeTarget` (tab-swipe.ts): ~30% of
//    the width or a flick commits, anything less springs back; RTL mirrors.
//  - A windowed pager (owner: "cache 1 screen next and 1 screen before and
//    warm up 1 screen next and 1 screen before, terminal screens would only
//    warm up and cache 1 screen"): the active panel and its neighbours
//    (`swipeWindow`) are mounted, each a keyed full-size panel at s*i*W in ONE
//    row translated to -s*index*W (s = -1 in RTL). A drag moves the row, so
//    the real neighbour follows the finger; a commit slides the row onto the
//    already-drawn neighbour and only then changes the tab. Positions are per
//    index, so the window shifting never jumps and a kept panel never
//    remounts. At most 3 are mounted; the ends keep 2.
//  - Off-screen panels are told they are inactive (`renderPanel(i, false)`),
//    take no touches and are hidden from VoiceOver. A panel gates its own
//    scroll-tick, pagination and re-read work on `active`. TranslatableDynamic
//    counts a node on screen only inside the screen's width, so the warmed
//    neighbours start no translations; the pager ticks once a panel lands.
//  - Under Reduce Motion there is no drag follow and no slide: a commit, like
//    a pill tap, snaps the row.

import React, { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { I18nManager, StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
    runOnJS,
    useAnimatedStyle,
    useReducedMotion,
    useSharedValue,
    withSpring,
    withTiming,
} from 'react-native-reanimated';
import { notifyScrollTick } from '@/lib/visibility-tick';
import { TAB_SWIPE_DAMPING, swipeTarget, swipeWindow } from './tab-swipe';

const SwipeTabsBlockerContext = createContext<React.RefObject<any> | null>(null);

/** For a horizontal RNGH scroller inside the swipe area: pass the returned
 *  ref to it, and the tab swipe waits for it. Null outside a SwipeTabs. */
export function useSwipeTabsBlocker(): React.RefObject<any> | null {
    return useContext(SwipeTabsBlockerContext);
}

/** Leaves the screen edges to the system back gesture. */
const EDGE_INSET = 24;
const SLIDE_MS = 180;
/** After the active tab changes, when to re-measure: the row has landed. */
const ARRIVAL_TICK_MS = 50;

export interface SwipeTabsProps {
    readonly index: number;
    readonly count: number;
    readonly onIndexChange: (next: number) => void;
    /** A stable key per tab: a panel kept in the window keeps its key, so it
     *  is never remounted as the window moves. */
    readonly keyOf: (i: number) => string;
    /** Draws tab `i`. `active` is false for a warmed or cached neighbour, which
     *  must not start scroll-tick, polling or refresh work. */
    readonly renderPanel: (i: number, active: boolean) => React.ReactNode;
    readonly testID?: string;
}

const SwipeTabs: React.FC<SwipeTabsProps> = ({ index, count, onIndexChange, keyOf, renderPanel, testID }) => {
    const blockerRef = useRef<any>(null);
    const [width, setWidth] = useState(0);
    const reduceMotion = useReducedMotion();
    const rtl = I18nManager.isRTL;
    const dir = rtl ? -1 : 1;
    // The row offset that shows `index`. Panels sit at dir*i*width.
    const base = -dir * index * width;
    const offset = useSharedValue(base);

    // A pill tap (any distance), the commit landing, or a new width: put the
    // row on the active panel. After a commit it is already there.
    useLayoutEffect(() => {
        offset.value = base;
    }, [base, offset]);

    // The arriving panel's translated titles were measured while it sat a
    // width away (off screen, by TranslatableDynamic's horizontal bound), and
    // nothing ticks on arrival until the reader scrolls. Tick once it landed.
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

    const land = useCallback((next: number) => onIndexChange(next), [onIndexChange]);

    const finish = useCallback(
        (dx: number, vx: number) => {
            const next = swipeTarget({ dx, vx, width, index, count, rtl });
            if (next === null) {
                offset.value = reduceMotion ? base : withSpring(base);
                return;
            }
            const target = -dir * next * width;
            if (reduceMotion || width <= 0) {
                offset.value = target;
                onIndexChange(next);
                return;
            }
            // The neighbour is already mounted and drawn: slide onto it, then
            // change the tab. Positions are per index, so nothing jumps.
            offset.value = withTiming(target, { duration: SLIDE_MS }, (finished) => {
                if (finished) runOnJS(land)(next);
            });
        },
        [width, index, count, rtl, dir, base, reduceMotion, onIndexChange, land, offset],
    );

    const pan = useMemo(
        () =>
            Gesture.Pan()
                .activeOffsetX([-25, 25])
                .failOffsetY([-12, 12])
                .hitSlop({ left: -EDGE_INSET, right: -EDGE_INSET })
                .requireExternalGestureToFail(blockerRef)
                .onUpdate((e) => {
                    if (!reduceMotion) offset.value = base + e.translationX * TAB_SWIPE_DAMPING;
                })
                .onEnd((e) => {
                    runOnJS(finish)(e.translationX, e.velocityX);
                }),
        [reduceMotion, finish, offset, base],
    );

    const rowStyle = useAnimatedStyle(() => ({ transform: [{ translateX: offset.value }] }));

    // Until the width is known a neighbour would land on top of the active
    // panel, so only the active one is drawn.
    const mounted = width > 0 ? swipeWindow(index, count) : swipeWindow(index, count).slice(0, 1);

    return (
        <SwipeTabsBlockerContext.Provider value={blockerRef}>
            <GestureDetector gesture={pan}>
                <View style={{ flex: 1, overflow: 'hidden' }} onLayout={onLayout} testID={testID}>
                    <Animated.View style={[StyleSheet.absoluteFill, rowStyle]} testID={testID ? `${testID}-row` : undefined}>
                        {mounted.map((i) => {
                            const active = i === index;
                            const key = keyOf(i);
                            return (
                                <View
                                    key={key}
                                    testID={testID ? `${testID}-panel-${key}` : undefined}
                                    style={[StyleSheet.absoluteFill, { transform: [{ translateX: dir * i * width }] }]}
                                    pointerEvents={active ? 'auto' : 'none'}
                                    accessibilityElementsHidden={!active}
                                    importantForAccessibility={active ? 'auto' : 'no-hide-descendants'}
                                >
                                    {renderPanel(i, active)}
                                </View>
                            );
                        })}
                    </Animated.View>
                </View>
            </GestureDetector>
        </SwipeTabsBlockerContext.Provider>
    );
};

export default SwipeTabs;
