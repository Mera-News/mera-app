// The app's motion, one name per row of the FinalMotion board, so a design
// review checks a screen against a name rather than a number someone typed.
//
// Rules from the board: arrive ease-out, leave ease-in and about 30% faster,
// move across ease-in-out, springs only where a finger lets go. Reduce Motion
// turns movement into fades; Lite stops decorative loops. Animate transform
// and opacity on the UI thread, never layout.

import { I18nManager } from 'react-native';
import { Easing, withSequence, withTiming } from 'react-native-reanimated';

export const EASE = {
    /** Things arriving: cubic-bezier(0.16, 1, 0.3, 1). */
    arrive: Easing.bezier(0.16, 1, 0.3, 1),
    /** Things leaving. */
    leave: Easing.in(Easing.cubic),
    /** Moving across the screen: cubic-bezier(0.65, 0, 0.35, 1). */
    across: Easing.bezier(0.65, 0, 0.35, 1),
    linear: Easing.linear,
} as const;

export const SPRING = {
    /** Like and Not for me: the one small bounce. */
    like: { damping: 14, stiffness: 260 },
    /** Switches and modals: a whisper of overshoot. */
    settle: { damping: 18, stiffness: 250 },
    /** A drag released (the Mera button landing in a corner). */
    drag: { damping: 16, stiffness: 220 },
} as const;

/** Durations in ms, keyed by the FinalMotion row they implement. */
export const MOTION = {
    press: { scale: 0.97, opacity: 0.88, in: 100, out: 150 },
    pill: { duration: 240 },
    articleOpen: { open: 380, back: 300, reduce: 200 },
    sheet: { open: 320, close: 220, reduce: 150 },
    smallModal: { fromScale: 0.96, toScale: 0.98, in: 220, out: 160 },
    status: { open: 260, close: 180 },
    cardsLand: { duration: 220, stagger: 60, max: 4, rise: 10 },
    relatedStagger: { duration: 220, stagger: 120, rise: 8 },
    supportSubList: { duration: 250 },
    themeCrossfade: { duration: 300 },
    pinShake: { offsets: [8, -8, 7, -7, 5, -5, 3, -3, 0], duration: 300 },
    checkbox: { fill: 120, tick: 180 },
    launchLogo: { duration: 300 },
    savedToCounter: { duration: 300 },
    halo: { fade: 600 },
    glow: { fade: 400 },
    shimmer: { loop: 1600, delay: 200, contentFade: 150 },
    chat: { open: 320, close: 200, reduce: 200 },
    /** Chat answer words fading in. */
    wordFade: { duration: 120 },
    /** The card note's reason resolving word by word (FinalRead #3); its chip
     *  pops in on SPRING.like. */
    noteReveal: { word: 250, stagger: 40 },
    stage: { duration: 600 },
} as const;

/** The wrong-PIN / wrong-code shake (FinalMotion): left and right, decaying,
 *  300 ms in all. Assign it to a translateX shared value. */
export function shakeX(): number {
    const { offsets, duration } = MOTION.pinShake;
    const step = duration / offsets.length;
    const [first, ...rest] = offsets.map((o) => withTiming(o, { duration: step }));
    return withSequence(first, ...rest);
}

/**
 * 'logical' follows the reading direction; 'physical' never mirrors. The Mera
 * button's corners are physical (owner rule), everything that means "toward
 * the end of the line" is logical.
 */
export type InlineMode = 'logical' | 'physical';

/** +1 when the reading end is to the right, -1 in RTL. Physical is always +1.
 *  Plain JS: read it on the JS thread and capture the number in a worklet. */
export function inlineSign(mode: InlineMode = 'logical'): 1 | -1 {
    return mode === 'logical' && I18nManager.isRTL ? -1 : 1;
}

/** A horizontal offset toward the reading end, mirrored in RTL. */
export function inlineX(x: number, mode: InlineMode = 'logical'): number {
    return x * inlineSign(mode);
}
