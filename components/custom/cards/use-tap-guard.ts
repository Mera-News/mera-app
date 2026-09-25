// A card or row opens on a TAP, never on a drag (owner, in prod: "swipe right
// left is also a gesture to open article"). RN's Pressable fires onPress on
// any release inside its rect, however far the finger travelled, and a
// full-width card holds the whole of a sideways drag (the Dashboard and
// Explore tab swipe, or a stray drag on the Feed). A vertical drag never gets
// here: the list's ScrollView takes the responder first.
//
// Same slop RN's Pressability uses to cancel a long press on movement, so a
// press and a long press give up at the same distance.

import { useCallback, useRef } from 'react';
import type { GestureResponderEvent } from 'react-native';

/** Points of finger travel, either axis, beyond which a release is a drag. */
export const TAP_SLOP = 10;

type Point = { x: number; y: number };

function pointOf(e: GestureResponderEvent | undefined): Point | null {
    const n = e?.nativeEvent;
    if (!n || typeof n.pageX !== 'number' || typeof n.pageY !== 'number') return null;
    return { x: n.pageX, y: n.pageY };
}

/**
 * Wraps a press handler so it runs only for a tap. A press with no coordinates
 * (an accessibility activate, a programmatic press) always runs.
 */
export function useTapGuard(
    onPress: ((e: GestureResponderEvent) => void) | null | undefined,
    onPressIn?: ((e: GestureResponderEvent) => void) | null,
): {
    onPressIn: (e: GestureResponderEvent) => void;
    onPress: ((e: GestureResponderEvent) => void) | undefined;
} {
    const start = useRef<Point | null>(null);
    const handleIn = useCallback(
        (e: GestureResponderEvent) => {
            start.current = pointOf(e);
            onPressIn?.(e);
        },
        [onPressIn],
    );
    const handlePress = useCallback(
        (e: GestureResponderEvent) => {
            const from = start.current;
            start.current = null;
            const to = pointOf(e);
            if (from && to && (Math.abs(to.x - from.x) > TAP_SLOP || Math.abs(to.y - from.y) > TAP_SLOP)) return;
            onPress?.(e);
        },
        [onPress],
    );
    return { onPressIn: handleIn, onPress: onPress ? handlePress : undefined };
}
