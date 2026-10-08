import { MaterialIcons } from '@expo/vector-icons';
import React, { useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, {
    cancelAnimation,
    useAnimatedStyle,
    useReducedMotion,
    useSharedValue,
    withDelay,
    withRepeat,
    withSequence,
    withTiming,
} from 'react-native-reanimated';

import { useAnimationsActive } from '@/lib/hooks/use-is-focused-safe';
import { useDisplayPrefsStore } from '@/lib/stores/display-prefs-store';
import { COLORS } from '@/lib/theme/tokens';

const SIZE = 52;
/** iOS's download control is a filled blue circle; the light theme's `info`
 *  blue, since this sits on the notice's white card in both themes. */
const BLUE = COLORS.light.info;
const LOOP_MS = 1600;
const PRESS_MS = 200;
const RIPPLE_MS = 700;

/**
 * A picture of the iOS Translate sheet's ↓ button being pressed, over and
 * over: it dips to 88% and darkens, a ring spreads out of it, then a pause.
 * Decoration only (the notice's text carries the instruction): no touch, no
 * screen-reader stop. Still under Reduce Motion, in Lite mode, and whenever
 * nobody is looking (backgrounded or off screen).
 */
export default function DownloadPressIllustration() {
    const reduceMotion = useReducedMotion();
    const liteMode = useDisplayPrefsStore((s) => s.liteMode);
    const active = useAnimationsActive();
    const moving = active && !reduceMotion && !liteMode;
    const press = useSharedValue(0);
    const ripple = useSharedValue(0);

    useEffect(() => {
        if (!moving) {
            cancelAnimation(press);
            cancelAnimation(ripple);
            press.value = 0;
            ripple.value = 0;
            return;
        }
        press.value = withRepeat(
            withSequence(
                withTiming(1, { duration: PRESS_MS }),
                withTiming(0, { duration: PRESS_MS }),
                withDelay(LOOP_MS - 2 * PRESS_MS, withTiming(0, { duration: 0 })),
            ),
            -1,
        );
        ripple.value = withRepeat(
            withSequence(
                withDelay(PRESS_MS, withTiming(1, { duration: RIPPLE_MS })),
                withTiming(0, { duration: 0 }),
                withDelay(LOOP_MS - PRESS_MS - RIPPLE_MS, withTiming(0, { duration: 0 })),
            ),
            -1,
        );
    }, [moving, press, ripple]);

    const buttonStyle = useAnimatedStyle(() => ({ transform: [{ scale: 1 - 0.12 * press.value }] }));
    const darkenStyle = useAnimatedStyle(() => ({ opacity: 0.22 * press.value }));
    const rippleStyle = useAnimatedStyle(() => ({
        opacity: ripple.value === 0 ? 0 : 0.45 * (1 - ripple.value),
        transform: [{ scale: 1 + 0.6 * ripple.value }],
    }));

    return (
        <View
            style={styles.box}
            pointerEvents="none"
            accessible={false}
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
        >
            <Animated.View style={[styles.ring, rippleStyle]} />
            <Animated.View style={[styles.button, buttonStyle]}>
                <MaterialIcons name="arrow-downward" size={30} color="#FFFFFF" />
                <Animated.View style={[styles.darken, darkenStyle]} />
            </Animated.View>
        </View>
    );
}

const styles = StyleSheet.create({
    box: { width: SIZE, height: SIZE, alignItems: 'center', justifyContent: 'center' },
    button: {
        width: SIZE,
        height: SIZE,
        borderRadius: SIZE / 2,
        backgroundColor: BLUE,
        alignItems: 'center',
        justifyContent: 'center',
        overflow: 'hidden',
    },
    darken: { ...StyleSheet.absoluteFillObject, backgroundColor: '#000000' },
    ring: { position: 'absolute', width: SIZE, height: SIZE, borderRadius: SIZE / 2, borderWidth: 3, borderColor: BLUE },
});
