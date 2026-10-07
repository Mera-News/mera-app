import { Toast, ToastDescription, ToastTitle, useIsToastFront } from '@/components/ui/toast';
import { TAB_BAR_HEIGHT } from '@/lib/navigation/tab-bar';
import React, { useEffect } from 'react';
import { Dimensions, I18nManager } from 'react-native';
import { initialWindowMetrics } from 'react-native-safe-area-context';
import Animated, {
    useAnimatedStyle,
    useSharedValue,
    withDelay,
    withTiming,
} from 'react-native-reanimated';
import { youTabTarget } from './you-tab-target';

/**
 * How long the toast sits FULLY OPAQUE before it starts leaving.
 *
 * This used to be zero: the fly-away animation began on mount and had faded
 * the toast to nothing within 700ms, so a notification read as "something flew
 * into the top-right corner" and could not actually be read. The hold is the
 * whole point — the flight is the epilogue, not the message.
 */
export const NOTIFIED_TOAST_HOLD_MS = 2000;
/** Fly-to-You leg (motion enabled). */
export const NOTIFIED_TOAST_FLY_MS = 700;
/** Plain fade-out leg (reduce motion). */
export const NOTIFIED_TOAST_FADE_MS = 1500;

/** Total on-screen lifetime, so the caller can size the toast's `duration` to
 *  match exactly — an over-long duration would leave an invisible toast mounted
 *  over the UI after the animation finished. */
export function notifiedToastDurationMs(canFly: boolean): number {
    return NOTIFIED_TOAST_HOLD_MS + (canFly ? NOTIFIED_TOAST_FLY_MS : NOTIFIED_TOAST_FADE_MS);
}

export interface NotifiedToastProps {
    title: string;
    body: string;
    action?: 'info' | 'success' | 'error';
    reduceMotion: boolean;
    /** Screen reader on: no timed exit; it leaves only when dismissed. */
    persistent?: boolean;
}

/**
 * The animated body of the "notified" toast. After the hold it flies toward
 * the You tab icon while scaling down and fading out: the notice now lives in
 * You > Notifications.
 *
 * Reduce motion: a plain fade with no translate.
 *
 * The toast's true start position is unknown to this component (it's placed by
 * the toast overlay), so the fly translate is approximated from the top-center
 * of the screen toward the You icon (see you-tab-target).
 */
const NotifiedToast: React.FC<NotifiedToastProps> = ({
    title,
    body,
    action = 'info',
    reduceMotion,
    persistent = false,
}) => {
    const progress = useSharedValue(0);
    // The deck can hold this card BEHIND another one. Its lifetime is sized to
    // this animation exactly (`notifiedToastDurationMs`), and the queue only
    // starts that clock once the card reaches the front — so the animation has
    // to wait for the same moment, or the toast holds and flies away
    // while it is an unreadable sliver and expires having never been seen.
    const isFront = useIsToastFront();

    // Approximate toast start: horizontally centered, near the top where a
    // 'top'-placed toast renders.
    const { width: screenWidth, height: screenHeight } = Dimensions.get('window');
    const startX = screenWidth / 2;
    const startY = 80;
    const canFly = !reduceMotion;
    const target = youTabTarget(
        screenWidth,
        screenHeight,
        initialWindowMetrics?.insets.bottom ?? 0,
        TAB_BAR_HEIGHT,
        I18nManager.isRTL,
    );
    const deltaX = canFly ? target.x - startX : 0;
    const deltaY = canFly ? target.y - startY : 0;

    useEffect(() => {
        if (!isFront || persistent) return;
        // HOLD fully opaque first so the notification is actually readable, then
        // leave: fly to You (translate + shrink + fade), or a plain slower fade
        // when motion is reduced.
        progress.value = withDelay(
            NOTIFIED_TOAST_HOLD_MS,
            withTiming(1, {
                duration: canFly ? NOTIFIED_TOAST_FLY_MS : NOTIFIED_TOAST_FADE_MS,
            }),
        );
    }, [progress, canFly, isFront, persistent]);

    const animatedStyle = useAnimatedStyle(() => {
        const p = progress.value;
        if (!canFly) {
            return { opacity: 1 - p };
        }
        return {
            opacity: 1 - p,
            transform: [
                { translateX: deltaX * p },
                { translateY: deltaY * p },
                { scale: 1 - 0.6 * p },
            ],
        };
    });

    return (
        // Purely informational and self-dismissing — it must never swallow a tap
        // aimed at the chrome behind it, least of all during the fade where it
        // is present but invisible.
        <Animated.View style={animatedStyle} pointerEvents="none">
            <Toast action={action} variant="solid">
                <ToastTitle>{title}</ToastTitle>
                {body ? <ToastDescription>{body}</ToastDescription> : null}
            </Toast>
        </Animated.View>
    );
};

export default NotifiedToast;
