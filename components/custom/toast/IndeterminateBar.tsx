import React, { useEffect } from 'react';
import { View } from 'react-native';
import Animated, {
    Easing,
    cancelAnimation,
    useAnimatedStyle,
    useSharedValue,
    withRepeat,
    withTiming,
} from 'react-native-reanimated';
import { useColors } from '@/lib/theme/tokens';
import { useMotionAllowed } from '@/lib/motion-gate';

/** One full sweep, left edge to past the right edge. */
const SWEEP_MS = 1400;
/** The moving segment, as a share of the track. */
const SEGMENT_SHARE = 0.35;

export interface IndeterminateBarProps {
    /**
     * REQUIRED and explicit, in points. A toast sizes to its content with
     * `flexShrink: 1`, so a bar asking for `width: '100%'` or `flex: 1` has
     * nothing to resolve against and measures zero (the same collapse that once
     * shrank every toast to an icon).
     */
    width: number;
    height?: number;
    /** The moving segment's colour. Default: the toast's body ink. */
    color?: string;
    /** No default: a reusable primitive's shared id would collide. The moving
     *  segment takes `${testID}-segment`. */
    testID?: string;
}

/**
 * Work in flight with no measurable progress: a segment sweeping a track,
 * forever, on the UI thread (reanimated `withRepeat`, a transform only, so no
 * layout per frame). Under the OS Reduce Motion setting the loop never starts
 * and the segment holds still in the middle of the track, which still reads as
 * "a bar" rather than an empty box. Lite mode holds it still the same way.
 */
export default function IndeterminateBar({ width, height = 3, color, testID }: IndeterminateBarProps) {
    const c = useColors();
    const reduceMotion = !useMotionAllowed();
    const segment = Math.round(width * SEGMENT_SHARE);
    const restX = Math.round((width - segment) / 2);
    const x = useSharedValue(reduceMotion ? restX : -segment);

    useEffect(() => {
        if (reduceMotion) {
            cancelAnimation(x);
            x.value = restX;
            return;
        }
        x.value = -segment;
        x.value = withRepeat(withTiming(width, { duration: SWEEP_MS, easing: Easing.linear }), -1, false);
        return () => cancelAnimation(x);
    }, [reduceMotion, width, segment, restX, x]);

    const segmentStyle = useAnimatedStyle(() => ({ transform: [{ translateX: x.value }] }));

    return (
        <View
            testID={testID}
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            style={{
                width,
                height,
                borderRadius: height / 2,
                overflow: 'hidden',
                backgroundColor: c.surfaceRaised,
            }}
        >
            <Animated.View
                testID={testID ? `${testID}-segment` : undefined}
                style={[
                    { width: segment, height, borderRadius: height / 2, backgroundColor: color ?? c.ink2 },
                    segmentStyle,
                ]}
            />
        </View>
    );
}
