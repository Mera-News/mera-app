import { useAnimationsActive } from '@/lib/hooks/use-is-focused-safe';
import React, { useEffect, useRef, useState } from 'react';
import {
    AccessibilityInfo,
    StyleSheet,
    Text,
    View,
    type StyleProp,
    type TextStyle,
} from 'react-native';

/** Milliseconds per character while typing. */
const DEFAULT_TYPE_MS = 38;
/** How long a completed line rests before the next one starts. */
const DEFAULT_HOLD_MS = 2600;

export interface CyclingTypewriterTextProps {
    /** Already-translated lines, in speaking order. */
    readonly lines: string[];
    readonly style?: StyleProp<TextStyle>;
    readonly testID?: string;
    readonly typeMs?: number;
    readonly holdMs?: number;
}

/**
 * Types one line out a character at a time, holds it, then moves to the next —
 * cycling forever. Used by `FreeTierCard` and `MeraChatInvite`, which speak the
 * same script (`lib/subscription/free-tier-lines.ts`).
 *
 * ## Four things here are load-bearing. None of them are decoration.
 *
 * **1. Reduced motion.** `AccessibilityInfo.isReduceMotionEnabled()` is read on
 * mount AND subscribed to, because the user can flip it while the app is open.
 * When it is on there is no typing and no cycling at all — one line, rendered
 * whole. A typewriter is precisely the animation that setting exists to stop,
 * and pausing only the character reveal while still swapping lines every few
 * seconds would be worse than either extreme.
 *
 * **2. The screen reader never sees a partial word.** The visible node is the
 * partially-typed prefix, which as an accessible value would be a per-character
 * moving target — VoiceOver would either announce fragments or re-announce the
 * line on every keystroke. So the animated node carries an explicit
 * `accessibilityLabel` of the COMPLETE line and the typed text is presentational.
 *
 * **3. It costs nothing when it cannot be seen.** `useAnimationsActive()` is the
 * repo's existing gate (focused screen AND app foregrounded) — the same one
 * `MeraLogo`'s spotlight uses, and for the same measured reason: tabs stay
 * mounted, so an ungated timer here would keep firing behind whatever the user
 * is actually looking at. `FreeTierCard` is a LIST HEADER on both Feed and
 * Dashboard, so that is two of them. When the gate closes the timer is cleared
 * and the current line is shown whole; when it reopens, typing resumes.
 *
 * **4. It never relayouts the list.** A growing string changes the text block's
 * height every few hundred milliseconds, and inside a list header that
 * relayouts the whole list. So an invisible copy of the LONGEST line reserves
 * the final height once, and the animated text is absolutely positioned over
 * it. The block is therefore a fixed size for the entire cycle. Re-renders stay
 * inside this leaf component — the parent card never re-renders, because the
 * ticking state lives here.
 *
 * The driver is a `setTimeout` chain over React state, matching this repo's
 * existing cycling-text surfaces (`AllCaughtUpCard`, `StreamingIndicator`) and
 * NOT reanimated: reanimated animates style values on the UI thread, and there
 * is no style value here — the thing that changes is the string itself, which
 * only React can commit. This adds the focus gate those two lack.
 */
const CyclingTypewriterText: React.FC<CyclingTypewriterTextProps> = ({
    lines,
    style,
    testID,
    typeMs = DEFAULT_TYPE_MS,
    holdMs = DEFAULT_HOLD_MS,
}) => {
    const animationsActive = useAnimationsActive();
    const [reduceMotion, setReduceMotion] = useState(false);
    const [lineIndex, setLineIndex] = useState(0);
    const [charCount, setCharCount] = useState(0);
    const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    // Read once, then track changes — the setting can be toggled while the app
    // is open, and a component that only sampled it at mount would keep
    // animating for the rest of the session.
    useEffect(() => {
        let cancelled = false;
        void AccessibilityInfo.isReduceMotionEnabled()
            .then((enabled) => {
                if (!cancelled) setReduceMotion(enabled);
            })
            .catch(() => {
                /* default: motion enabled */
            });
        const sub = AccessibilityInfo.addEventListener(
            'reduceMotionChanged',
            (enabled: boolean) => setReduceMotion(enabled),
        );
        return () => {
            cancelled = true;
            sub.remove();
        };
    }, []);

    const count = lines.length;
    // Clamp rather than trust: the line set shrinks when a state-gated line
    // drops out (the user un-saved their last article) and a stale index would
    // read past the end.
    const safeIndex = count === 0 ? 0 : lineIndex % count;
    const current = lines[safeIndex] ?? '';
    const animating = animationsActive && !reduceMotion && count > 0;

    useEffect(() => {
        if (!animating) {
            // Not an early return that leaves a timer behind: whatever was
            // scheduled is dropped, and the line is completed so a paused
            // component never shows a half-typed word.
            if (timerRef.current) {
                clearTimeout(timerRef.current);
                timerRef.current = null;
            }
            return;
        }

        const done = charCount >= current.length;
        timerRef.current = setTimeout(
            () => {
                if (done) {
                    setLineIndex((i) => (i + 1) % count);
                    setCharCount(0);
                } else {
                    setCharCount((c) => c + 1);
                }
            },
            done ? holdMs : typeMs,
        );

        return () => {
            if (timerRef.current) {
                clearTimeout(timerRef.current);
                timerRef.current = null;
            }
        };
    }, [animating, charCount, current.length, count, holdMs, typeMs]);

    // Belt and braces on unmount: the effect above already clears on every
    // re-run, but an unmount mid-flight must not leave a timer holding a
    // setState on a dead component.
    useEffect(
        () => () => {
            if (timerRef.current) clearTimeout(timerRef.current);
        },
        [],
    );

    if (count === 0) return null;

    const visible = animating ? current.slice(0, charCount) : current;
    // Reserves the block's height ONCE, at the tallest line, so no cycle can
    // change the layout. Measured by character count — an approximation, but the
    // lines are one register and one font, so it is the right proxy and costs
    // nothing.
    const longest = lines.reduce((a, b) => (b.length > a.length ? b : a), lines[0]);

    return (
        <View testID={testID}>
            <Text
                style={[style, styles.spacer]}
                accessibilityElementsHidden
                importantForAccessibility="no-hide-descendants"
            >
                {longest}
            </Text>
            <Text
                testID={testID ? `${testID}-text` : undefined}
                style={[style, StyleSheet.absoluteFill]}
                // The COMPLETE line, never the typed prefix — see (2) above.
                accessibilityLabel={current}
                accessibilityRole="text"
            >
                {visible}
            </Text>
        </View>
    );
};

const styles = StyleSheet.create({
    /** Present for measurement only. `opacity: 0` rather than `display: none`
     *  precisely because it must still take up space. */
    spacer: { opacity: 0 },
});

export default CyclingTypewriterText;
