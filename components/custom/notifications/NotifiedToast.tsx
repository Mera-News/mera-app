import MeraToast, { type ToastTone } from '@/components/custom/toast/MeraToast';
import { REDUCED_FADE, TOAST_MOTION } from '@/components/custom/toast/deck-motion';
import { markExited } from '@/components/custom/toast/exited-cards';
import { useIsToastFront } from '@/components/ui/toast';
import { useMotionAllowed } from '@/lib/motion-gate';
import { TAB_BAR_HEIGHT } from '@/lib/navigation/tab-bar';
import type { LucideIcon } from 'lucide-react-native';
import React, { useEffect } from 'react';
import { Dimensions, I18nManager } from 'react-native';
import { initialWindowMetrics } from 'react-native-safe-area-context';
import Animated, {
    ReduceMotion,
    useAnimatedStyle,
    useSharedValue,
    withDelay,
    withTiming,
} from 'react-native-reanimated';
import { inboxTabTarget } from './inbox-tab-target';

/**
 * How long the toast sits FULLY OPAQUE before it starts leaving.
 *
 * This used to be zero: the fly-away animation began on mount and had faded
 * the toast to nothing within 700ms, so a notification read as "something flew
 * into the top-right corner" and could not actually be read. The hold is the
 * whole point: the flight is the epilogue, not the message. FinalInbox #1: 4 s.
 */
export const NOTIFIED_TOAST_HOLD_MS = 4000;
/** Fly-to-the-inbox leg (FinalInbox #2: 450 ms). */
export const NOTIFIED_TOAST_FLY_MS = 450;
/** Shrink and fade only in the flight's last 30%: a near miss on the Feed icon
 *  (the floating bar, RTL) is then invisible. */
const FADE_FROM = 0.7;
/** Plain fade-out leg (Lite or Reduce Motion): the deck's reduced fade. */
export const NOTIFIED_TOAST_FADE_MS = TOAST_MOTION.reduced.ms;

/** Total on-screen lifetime, so the caller can size the toast's `duration` to
 *  match exactly — an over-long duration would leave an invisible toast mounted
 *  over the UI after the animation finished. */
export function notifiedToastDurationMs(canFly: boolean): number {
    return NOTIFIED_TOAST_HOLD_MS + (canFly ? NOTIFIED_TOAST_FLY_MS : NOTIFIED_TOAST_FADE_MS);
}

export interface NotifiedToastProps {
    title: string;
    body: string;
    /** From the notice's type (`notice-tone.ts`). */
    tone: ToastTone;
    icon?: LucideIcon;
    /** The queue id, marked as exited once this card's own leave starts. */
    toastId?: string;
    /** The live OS setting; Lite and the launch flag come from the motion gate. */
    reduceMotion: boolean;
    /** Screen reader on: no timed exit; it leaves only when dismissed. */
    persistent?: boolean;
    /** The notice's one button (its row's first action), when it has one. */
    button?: { readonly label: string; readonly onPress: () => void };
    /** false: no flight or fade of its own; the deck's default exit closes it. */
    fly?: boolean;
}

/**
 * The animated body of the "notified" toast. After the hold it flies toward
 * the Feed tab icon while scaling down and fading out: the notice now lives in
 * Feed > Notifications.
 *
 * Lite or Reduce Motion: the same hold, then the deck's 180 ms fade. Both legs
 * pass `ReduceMotion.Never`: LiteMotionConfig (and the OS flag) otherwise make
 * Reanimated skip the delay and land the fade at once, so the notice vanished
 * on mount.
 *
 * The toast's true start position is unknown to this component (it's placed by
 * the toast overlay), so the fly translate is approximated from the top-center
 * of the screen toward the Feed icon (see inbox-tab-target).
 */
const NotifiedToast: React.FC<NotifiedToastProps> = ({
    title,
    body,
    tone,
    icon,
    toastId,
    reduceMotion,
    persistent = false,
    button,
    fly = true,
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
    const canFly = useMotionAllowed() && !reduceMotion;
    const target = inboxTabTarget(
        screenWidth,
        screenHeight,
        initialWindowMetrics?.insets.bottom ?? 0,
        TAB_BAR_HEIGHT,
        I18nManager.isRTL,
    );
    const deltaX = canFly ? target.x - startX : 0;
    const deltaY = canFly ? target.y - startY : 0;

    useEffect(() => {
        if (!fly || !isFront || persistent) return;
        // HOLD fully opaque first so the notification is actually readable, then
        // leave: fly to the inbox (translate + shrink + fade), or the reduced fade.
        progress.value = withDelay(
            NOTIFIED_TOAST_HOLD_MS,
            withTiming(
                1,
                canFly ? { duration: NOTIFIED_TOAST_FLY_MS, reduceMotion: ReduceMotion.Never } : REDUCED_FADE,
            ),
            ReduceMotion.Never,
        );
        // From the leave on, this card's exit is its own: the deck must not
        // replay one from rest. Before it (a button press) the deck's exit runs.
        if (!toastId) return;
        const handle = setTimeout(() => markExited(toastId), NOTIFIED_TOAST_HOLD_MS);
        return () => clearTimeout(handle);
    }, [progress, canFly, isFront, persistent, fly, toastId]);

    const animatedStyle = useAnimatedStyle(() => {
        const p = progress.value;
        if (!canFly) {
            return { opacity: 1 - p };
        }
        const tail = p <= FADE_FROM ? 0 : (p - FADE_FROM) / (1 - FADE_FROM);
        return {
            opacity: 1 - tail,
            transform: [
                { translateX: deltaX * p },
                { translateY: deltaY * p },
                { scale: 1 - 0.8 * tail },
            ],
        };
    });

    return (
        <Animated.View style={animatedStyle}>
            <MeraToast
                tone={tone}
                icon={icon}
                title={title}
                body={body || undefined}
                actions={button ? [{ label: button.label, onPress: button.onPress, primary: true, testID: 'notified-toast-button' }] : []}
            />
        </Animated.View>
    );
};

export default NotifiedToast;
