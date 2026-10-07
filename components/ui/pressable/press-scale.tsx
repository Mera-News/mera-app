import React from 'react';
import { Pressable, type GestureResponderEvent, type PressableProps, type StyleProp, type ViewStyle } from 'react-native';
import Animated, { useAnimatedStyle, useReducedMotion, useSharedValue, withTiming } from 'react-native-reanimated';

import { EASE, MOTION } from '@/lib/motion';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

export type PressScaleProps = Omit<PressableProps, 'style'> & {
    /** A plain style. A function style is dropped on device, so it is not accepted. */
    style?: StyleProp<ViewStyle>;
};

/**
 * The FinalMotion "Press": scale to 0.97 and 88% opacity on touch down, 100 ms
 * in, 150 ms back, ease out. Reduce Motion: opacity only. On the UI thread,
 * never a style function (dropped on device).
 *
 * Use it only where a board shows the press; it is not on every Button.
 */
export function PressScale({ style, onPressIn, onPressOut, children, ...rest }: PressScaleProps) {
    const reduceMotion = useReducedMotion();
    const p = useSharedValue(0);
    const animated = useAnimatedStyle(() => ({
        opacity: 1 - p.value * (1 - MOTION.press.opacity),
        transform: reduceMotion ? [] : [{ scale: 1 - p.value * (1 - MOTION.press.scale) }],
    }));
    return (
        <AnimatedPressable
            {...rest}
            onPressIn={(e: GestureResponderEvent) => {
                p.value = withTiming(1, { duration: MOTION.press.in, easing: EASE.arrive });
                onPressIn?.(e);
            }}
            onPressOut={(e: GestureResponderEvent) => {
                p.value = withTiming(0, { duration: MOTION.press.out, easing: EASE.arrive });
                onPressOut?.(e);
            }}
            style={[style, animated]}
        >
            {children}
        </AnimatedPressable>
    );
}
