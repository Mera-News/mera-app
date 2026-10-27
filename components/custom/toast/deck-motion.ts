import { Easing, ReduceMotion } from 'react-native-reanimated';

/**
 * The toast motion spec (design "Toasts and notifications", Motion board), one
 * name per row, shared by the deck and the Undo swap so a review checks a
 * number against the board, not against a literal typed twice.
 *
 * REDUCED is `!useMotionAllowed()`: Lite, or the system's Reduce Motion (it
 * reads the same launch flag Reanimated's `useReducedMotion` returns, and the
 * global jest mock has no `useReducedMotion`). Reduced is opacity only, 180 ms, and
 * every reduced fade passes `ReduceMotion.Never`: LiteMotionConfig forces
 * Reanimated's own reduce flag on in Lite, which would land a default fade at
 * once, and the board wants a fade there, not a cut.
 */

/** Arrive and every settle: cubic-bezier(0.22, 1, 0.36, 1), ease-out, no bounce. */
export const EASE_SETTLE = Easing.bezier(0.22, 1, 0.36, 1);
/** Leave: cubic-bezier(0.4, 0, 1, 1), ease-in. */
export const EASE_LEAVE = Easing.bezier(0.4, 0, 1, 1);

export const TOAST_MOTION = {
    /** Into an empty deck: slides down from translateY(-150%) scale .96, opacity 0. */
    arrive: { ms: 420, fromHeightShare: -1.5, fromScale: 0.96 },
    /** Lifts to translateY(-150%) and fades. */
    leave: { ms: 260, toHeightShare: -1.5 },
    /** The next in line rises out of its strip: from translateY(14) scale .94 opacity .4. */
    rise: { ms: 320, fromY: 14, fromScale: 0.94, fromOpacity: 0.4 },
    /** A strip fading in as its card queues: from translateY(-8), opacity 0. */
    strip: { ms: 320, fromY: -8 },
    /** The Undo face swapping in: from translateY(4), opacity 0. */
    swap: { ms: 220, fromY: 4 },
    reduced: { ms: 180 },
    /** Past this upward travel a released swipe dismisses; less springs back. */
    dismissPt: 36,
    /** A fast upward flick dismisses whatever the distance (pt/s). */
    dismissVelocity: 600,
    /** A downward pull moves the card this share of the finger's travel. */
    pullDamping: 0.2,
} as const;

/** The reduced fade's timing config. */
export const REDUCED_FADE = {
    duration: TOAST_MOTION.reduced.ms,
    easing: Easing.linear,
    reduceMotion: ReduceMotion.Never,
};

/** The card's offset for a finger at `translationY`: up follows 1:1, down is damped. */
export function dragOffset(translationY: number): number {
    'worklet';
    return translationY < 0 ? translationY : translationY * TOAST_MOTION.pullDamping;
}

/** Whether a released swipe dismisses the card. */
export function swipeDismisses(translationY: number, velocityY: number): boolean {
    'worklet';
    return -translationY > TOAST_MOTION.dismissPt || -velocityY > TOAST_MOTION.dismissVelocity;
}

