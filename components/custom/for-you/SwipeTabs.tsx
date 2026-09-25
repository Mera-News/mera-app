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
//  - The panel follows the finger damped, slides out, the tab changes, and the
//    new panel slides in from the other side. Under Reduce Motion it just
//    swaps: no drag follow, no slide.

import React, { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import { I18nManager, type LayoutChangeEvent } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
    runOnJS,
    useAnimatedStyle,
    useReducedMotion,
    useSharedValue,
    withSpring,
    withTiming,
} from 'react-native-reanimated';
import { TAB_SWIPE_DAMPING, swipeTarget } from './tab-swipe';

const SwipeTabsBlockerContext = createContext<React.RefObject<any> | null>(null);

/** For a horizontal RNGH scroller inside the swipe area: pass the returned
 *  ref to it, and the tab swipe waits for it. Null outside a SwipeTabs. */
export function useSwipeTabsBlocker(): React.RefObject<any> | null {
    return useContext(SwipeTabsBlockerContext);
}

/** Leaves the screen edges to the system back gesture. */
const EDGE_INSET = 24;
const SLIDE_MS = 180;

export interface SwipeTabsProps {
    readonly index: number;
    readonly count: number;
    readonly onIndexChange: (next: number) => void;
    readonly children: React.ReactNode;
    readonly testID?: string;
}

const SwipeTabs: React.FC<SwipeTabsProps> = ({ index, count, onIndexChange, children, testID }) => {
    const blockerRef = useRef<any>(null);
    const [width, setWidth] = useState(0);
    const tx = useSharedValue(0);
    const reduceMotion = useReducedMotion();
    const rtl = I18nManager.isRTL;

    const onLayout = useCallback((e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width), []);

    // The incoming panel enters from the side opposite the exit.
    const swapIn = useCallback(
        (next: number, enterFrom: number) => {
            onIndexChange(next);
            tx.value = enterFrom;
            tx.value = withTiming(0, { duration: SLIDE_MS });
        },
        [onIndexChange, tx],
    );

    const finish = useCallback(
        (dx: number, vx: number) => {
            const next = swipeTarget({ dx, vx, width, index, count, rtl });
            if (next === null) {
                tx.value = reduceMotion ? 0 : withSpring(0);
                return;
            }
            if (reduceMotion || width <= 0) {
                tx.value = 0;
                onIndexChange(next);
                return;
            }
            const out = dx < 0 ? -width : width;
            tx.value = withTiming(out, { duration: SLIDE_MS }, (finished) => {
                if (finished) runOnJS(swapIn)(next, -out);
            });
        },
        [width, index, count, rtl, reduceMotion, onIndexChange, swapIn, tx],
    );

    const pan = useMemo(
        () =>
            Gesture.Pan()
                .activeOffsetX([-25, 25])
                .failOffsetY([-12, 12])
                .hitSlop({ left: -EDGE_INSET, right: -EDGE_INSET })
                .requireExternalGestureToFail(blockerRef)
                .onUpdate((e) => {
                    if (!reduceMotion) tx.value = e.translationX * TAB_SWIPE_DAMPING;
                })
                .onEnd((e) => {
                    runOnJS(finish)(e.translationX, e.velocityX);
                }),
        [reduceMotion, finish, tx],
    );

    const style = useAnimatedStyle(() => ({ transform: [{ translateX: tx.value }] }));

    return (
        <SwipeTabsBlockerContext.Provider value={blockerRef}>
            <GestureDetector gesture={pan}>
                <Animated.View style={[{ flex: 1 }, style]} onLayout={onLayout} testID={testID}>
                    {children}
                </Animated.View>
            </GestureDetector>
        </SwipeTabsBlockerContext.Provider>
    );
};

export default SwipeTabs;
