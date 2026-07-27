import { Toast, ToastDescription, ToastTitle } from '@/components/ui/toast';
import type { BellAnchor } from '@/lib/notifications/bell-anchor';
import React, { useEffect } from 'react';
import { Dimensions } from 'react-native';
import Animated, {
    useAnimatedStyle,
    useSharedValue,
    withDelay,
    withTiming,
} from 'react-native-reanimated';

/**
 * How long the toast sits FULLY OPAQUE before it starts leaving.
 *
 * This used to be zero: the fly-to-bell animation began on mount and had faded
 * the toast to nothing within 700ms, so a notification read as "something flew
 * into the top-right corner" and could not actually be read. The hold is the
 * whole point — the flight is the epilogue, not the message.
 */
export const NOTIFIED_TOAST_HOLD_MS = 2000;
/** Fly-to-bell leg (motion enabled + a known bell anchor). */
export const NOTIFIED_TOAST_FLY_MS = 700;
/** Plain fade-out leg (reduce-motion, or no anchor to fly to). */
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
    anchor: BellAnchor | null;
}

/**
 * The animated body of the "notified" toast. On mount it flies toward the
 * notification bell (anchor = bell center from bell-anchor.ts) while scaling
 * down and fading out — a visual hint that the event was filed into the bell.
 *
 * Reduce-motion (or a missing anchor) → a plain fade with no translate.
 *
 * The toast's true start position is unknown to this component (it's placed by
 * the toast overlay), so the fly translate is approximated from the top-center
 * of the screen toward the anchor. Close enough for the "into the bell" read.
 */
const NotifiedToast: React.FC<NotifiedToastProps> = ({
    title,
    body,
    action = 'info',
    reduceMotion,
    anchor,
}) => {
    const progress = useSharedValue(0);

    // Approximate toast start: horizontally centered, near the top where a
    // 'top'-placed toast renders.
    const { width: screenWidth } = Dimensions.get('window');
    const startX = screenWidth / 2;
    const startY = 80;
    const canFly = !reduceMotion && anchor != null;
    const deltaX = canFly ? anchor!.x - startX : 0;
    const deltaY = canFly ? anchor!.y - startY : 0;

    useEffect(() => {
        // HOLD fully opaque first so the notification is actually readable, then
        // leave: fly-to-bell (translate + shrink + fade), or a plain slower fade
        // when motion is reduced / there is no bell to fly to.
        progress.value = withDelay(
            NOTIFIED_TOAST_HOLD_MS,
            withTiming(1, {
                duration: canFly ? NOTIFIED_TOAST_FLY_MS : NOTIFIED_TOAST_FADE_MS,
            }),
        );
    }, [progress, canFly]);

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
