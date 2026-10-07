import React, { useEffect, useState } from 'react';
import { StyleSheet, Text, View, type DimensionValue, type StyleProp, type TextStyle, type ViewStyle } from 'react-native';
import Animated, {
    cancelAnimation,
    useAnimatedStyle,
    useReducedMotion,
    useSharedValue,
    withRepeat,
    withTiming,
} from 'react-native-reanimated';
import Svg, { Defs, LinearGradient, Rect, Stop } from 'react-native-svg';

import { useAnimationsActive } from '@/lib/hooks/use-is-focused-safe';
import { EASE, MOTION } from '@/lib/motion';
import { useDisplayPrefsStore } from '@/lib/stores/display-prefs-store';
import { useColors } from '@/lib/theme/tokens';

/**
 * The shared loading light (FinalMotion "Loading placeholders"): a soft band
 * sweeps across, 1.6 s linear, only after the first 200 ms, and never under
 * Reduce Motion, Lite, or while the screen is not being looked at.
 *
 * Two uses only: grey placeholders (`Shimmer`) and the "Updating your feed"
 * status title (`ShimmerText`). Never on the card note.
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

function useSweepAllowed(): boolean {
    const reduceMotion = useReducedMotion();
    const lite = useDisplayPrefsStore((s) => s.liteMode);
    const active = useAnimationsActive();
    return !reduceMotion && !lite && active;
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
    children: string;
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
export function ShimmerText({ children, style, numberOfLines, testID }: ShimmerTextProps) {
    const colors = useColors();
    const [w, setW] = useState(0);
    const allowed = useSweepAllowed();
    const t = useSweep(allowed && w > 0);
    const band = w * BAND;
    const bandStyle = useAnimatedStyle(() => ({ transform: [{ translateX: -band + t.value * (w + band) }] }));
    const counterStyle = useAnimatedStyle(() => ({ transform: [{ translateX: band - t.value * (w + band) }] }));

    if (!allowed) {
        return (
            <Text testID={testID} numberOfLines={numberOfLines} style={[style, { color: colors.ink }]}>
                {children}
            </Text>
        );
    }
    return (
        <View testID={testID} onLayout={(e) => setW(e.nativeEvent.layout.width)}>
            <Text numberOfLines={numberOfLines} style={[style, { color: colors.ink2 }]}>
                {children}
            </Text>
            {w > 0 ? (
                <Animated.View
                    pointerEvents="none"
                    accessibilityElementsHidden
                    importantForAccessibility="no-hide-descendants"
                    style={[styles.textBand, { width: band }, bandStyle]}
                >
                    <Animated.View style={[{ width: w }, counterStyle]}>
                        <Text numberOfLines={numberOfLines} style={[style, { color: colors.ink }]}>
                            {children}
                        </Text>
                    </Animated.View>
                </Animated.View>
            ) : null}
        </View>
    );
}

const styles = StyleSheet.create({
    band: { position: 'absolute', top: 0, bottom: 0, left: 0 },
    textBand: { position: 'absolute', top: 0, bottom: 0, left: 0, overflow: 'hidden' },
});
