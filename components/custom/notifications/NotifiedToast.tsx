import { Toast, ToastDescription, ToastTitle } from '@/components/ui/toast';
import type { BellAnchor } from '@/lib/notifications/bell-anchor';
import React, { useEffect } from 'react';
import { Dimensions } from 'react-native';
import Animated, {
    useAnimatedStyle,
    useSharedValue,
    withTiming,
} from 'react-native-reanimated';

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
        // Fade-only (reduce-motion / no anchor): slower, no movement.
        // Fly-to-bell: faster translate + shrink + fade.
        progress.value = withTiming(1, { duration: canFly ? 700 : 1500 });
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
        <Animated.View style={animatedStyle}>
            <Toast action={action} variant="solid">
                <ToastTitle>{title}</ToastTitle>
                {body ? <ToastDescription>{body}</ToastDescription> : null}
            </Toast>
        </Animated.View>
    );
};

export default NotifiedToast;
