import { DIMMED_OPACITY } from '@/components/custom/cards/press-style';
import { Pressable } from '@/components/ui/pressable';
import { EASE, MOTION } from '@/lib/motion';
import React, { useCallback } from 'react';
import type { GestureResponderEvent } from 'react-native';
import Animated, { useAnimatedStyle, useReducedMotion, useSharedValue, withTiming } from 'react-native-reanimated';
import { useTapGuard } from './use-tap-guard';

type PressableProps = React.ComponentProps<typeof Pressable>;

export interface PressableCardProps extends Omit<PressableProps, 'style'> {
    /** The recorded-verdict treatment (0.75), multiplied by the pressed one. */
    dimmed?: boolean;
}

/** A card dips a little less than a button (FinalRead: "the card lifts a
 *  little, scale 0.98"; buttons use MOTION.press.scale). */
const CARD_PRESS_SCALE = 0.98;

/**
 * A card or row that visibly reacts while held: it dips to 98% and 88%
 * opacity on the UI thread (100 ms in, 150 ms back; Reduce Motion: opacity
 * only). Never a function `style={({ pressed }) => ...}`: that is dropped on
 * device in this app (the css-interop wrapper).
 *
 * It opens on a TAP only (`useTapGuard`): a release after a sideways drag is
 * not a press, or the tab swipe and any stray drag opened the article.
 */
const PressableCard = React.forwardRef<React.ComponentRef<typeof Pressable>, PressableCardProps>(
    function PressableCard({ dimmed = false, onPressIn, onPressOut, onPress, children, ...rest }, ref) {
        const reduceMotion = useReducedMotion();
        const held = useSharedValue(0);
        const markIn = useCallback(
            (e: GestureResponderEvent) => {
                held.value = withTiming(1, { duration: MOTION.press.in, easing: EASE.arrive });
                onPressIn?.(e);
            },
            [held, onPressIn],
        );
        const tap = useTapGuard(onPress, markIn);
        const handleOut = useCallback(
            (e: GestureResponderEvent) => {
                held.value = withTiming(0, { duration: MOTION.press.out, easing: EASE.arrive });
                onPressOut?.(e);
            },
            [held, onPressOut],
        );
        const pressedScale = reduceMotion ? 1 : CARD_PRESS_SCALE;
        const pressStyle = useAnimatedStyle(() => ({
            opacity: 1 - held.value * (1 - MOTION.press.opacity),
            transform: [{ scale: 1 - held.value * (1 - pressedScale) }],
        }));
        return (
            <Pressable
                ref={ref}
                {...rest}
                onPress={tap.onPress}
                onPressIn={tap.onPressIn}
                onPressOut={handleOut}
                style={dimmed ? { opacity: DIMMED_OPACITY } : undefined}
            >
                <Animated.View style={pressStyle}>{children as React.ReactNode}</Animated.View>
            </Pressable>
        );
    },
);

export default PressableCard;
