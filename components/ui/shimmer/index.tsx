import React, { useEffect, useState, type ReactNode } from 'react';
import { StyleSheet, Text, View, type DimensionValue, type StyleProp, type TextStyle, type ViewStyle } from 'react-native';
import Animated, {
    cancelAnimation,
    useAnimatedStyle,
    useSharedValue,
    withRepeat,
    withTiming,
} from 'react-native-reanimated';
import Svg, { Defs, LinearGradient, Rect, Stop } from 'react-native-svg';

import { useAnimationsActive } from '@/lib/hooks/use-is-focused-safe';
import { EASE, MOTION } from '@/lib/motion';
import { useMotionAllowed } from '@/lib/motion-gate';
import { useColors } from '@/lib/theme/tokens';

/**
 * The shared loading light (FinalMotion "Loading placeholders"): a soft band
 * sweeps across, 1.6 s linear, only after the first 200 ms, and never under
 * Reduce Motion, Lite, or while the screen is not being looked at.
 *
 * Three uses only: grey placeholders (`Shimmer`), the "Updating your feed"
 * status title and a text whose translation is in flight (`ShimmerText`).
 *
 * Both move a transform on the UI thread; nothing is redrawn per frame.
 */

/** The band's width, as a share of what it crosses. */
const BAND = 0.45;

/** 0 → 1 on a loop while `on`, starting after the board's 200 ms delay. */
function useSweep(on: boolean) {
    const t = useSharedValue(0);
    useEffect(() => {
        if (!on) {
            cancelAnimation(t);
            t.value = 0;
            return;
        }
        const id = setTimeout(() => {
            t.value = 0;
            t.value = withRepeat(withTiming(1, { duration: MOTION.shimmer.loop, easing: EASE.linear }), -1, false);
        }, MOTION.shimmer.delay);
        return () => {
            clearTimeout(id);
            cancelAnimation(t);
        };
    }, [on, t]);
    return t;
}

/** Whether the sweep may run: motion allowed and the screen being looked at. */
export function useSweepAllowed(): boolean {
    const motion = useMotionAllowed();
    const active = useAnimationsActive();
    return motion && active;
}

export interface ShimmerProps {
    width?: DimensionValue;
    height?: DimensionValue;
    radius?: number;
    style?: StyleProp<ViewStyle>;
}

/** A grey placeholder block with the sweep. */
export function Shimmer({ width = '100%', height = 16, radius = 6, style }: ShimmerProps) {
    const colors = useColors();
    const [w, setW] = useState(0);
    const t = useSweep(useSweepAllowed() && w > 0);
    const band = w * BAND;
    const bandStyle = useAnimatedStyle(() => ({
        transform: [{ translateX: -band + t.value * (w + band) }],
    }));
    return (
        <View
            onLayout={(e) => setW(e.nativeEvent.layout.width)}
            style={[{ width, height, borderRadius: radius, backgroundColor: colors.surface, overflow: 'hidden' }, style]}
        >
            {w > 0 ? (
                <Animated.View style={[styles.band, { width: band }, bandStyle]}>
                    <Svg width="100%" height="100%">
                        <Defs>
                            <LinearGradient id="shimmer-band" x1="0" y1="0" x2="1" y2="0">
                                <Stop offset="0" stopColor={colors.ink} stopOpacity={0} />
                                <Stop offset="0.5" stopColor={colors.ink} stopOpacity={0.08} />
                                <Stop offset="1" stopColor={colors.ink} stopOpacity={0} />
                            </LinearGradient>
                        </Defs>
                        <Rect width="100%" height="100%" fill="url(#shimmer-band)" />
                    </Svg>
                </Animated.View>
            ) : null}
        </View>
    );
}

export interface ShimmerTextProps {
    children?: string;
    /** Draws each copy itself, in the colour given, so a caller keeps its own
     *  Text or Heading (size, class, line clamp). Replaces `children`. */
    renderText?: (color: string) => ReactNode;
    /** Font, size and layout. The colour is the kit's: ink2 under, ink in the light. */
    style?: StyleProp<TextStyle>;
    numberOfLines?: number;
    testID?: string;
}

/**
 * A line of text the light passes over. Drawn twice: the dim copy, and a
 * bright copy inside a band that moves one way while the copy inside it moves
 * back the other way, so the bright letters stay exactly over the dim ones and
 * light falls only on letters. Static (plain ink) when the sweep is off.
 *
 * ponytail: the band has hard edges (no mask library in the binary); a soft
 * edge needs masked-view, a native change.
 */
export function ShimmerText({ children, renderText, style, numberOfLines, testID }: ShimmerTextProps) {
    const colors = useColors();
    const [w, setW] = useState(0);
    const allowed = useSweepAllowed();
    const t = useSweep(allowed && w > 0);
    const band = w * BAND;
    const bandStyle = useAnimatedStyle(() => ({ transform: [{ translateX: -band + t.value * (w + band) }] }));
    const counterStyle = useAnimatedStyle(() => ({ transform: [{ translateX: band - t.value * (w + band) }] }));
    const copy = (color: string) =>
        renderText ? renderText(color) : (
            <Text numberOfLines={numberOfLines} style={[style, { color }]}>
                {children}
            </Text>
        );

    if (!allowed) {
        return renderText ? (
            <View testID={testID}>{renderText(colors.ink)}</View>
        ) : (
            <Text testID={testID} numberOfLines={numberOfLines} style={[style, { color: colors.ink }]}>
                {children}
            </Text>
        );
    }
    return (
        <View testID={testID} onLayout={(e) => setW(e.nativeEvent.layout.width)}>
            {copy(colors.ink2)}
            {w > 0 ? (
                <Animated.View
                    pointerEvents="none"
                    accessibilityElementsHidden
                    importantForAccessibility="no-hide-descendants"
                    style={[styles.textBand, { width: band }, bandStyle]}
                >
                    <Animated.View style={[{ width: w }, counterStyle]}>{copy(colors.ink)}</Animated.View>
                </Animated.View>
            ) : null}
        </View>
    );
}

const styles = StyleSheet.create({
    band: { position: 'absolute', top: 0, bottom: 0, left: 0 },
    textBand: { position: 'absolute', top: 0, bottom: 0, left: 0, overflow: 'hidden' },
});
