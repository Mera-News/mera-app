import React, { useEffect, useMemo, useState } from 'react';
import { StyleSheet, Text, View, type StyleProp, type TextStyle, type ViewStyle } from 'react-native';
import Animated, { FadeIn, FadeOut, useReducedMotion } from 'react-native-reanimated';

import i18n from '@/lib/i18n';
import { useAnimationsActive } from '@/lib/hooks/use-is-focused-safe';
import { MOTION } from '@/lib/motion';

import { languageHeadingOrder } from './language-heading-order';

const KEY = 'auth.track.chooseLanguage';
const HOLD_MS = 2000;
const FADE_MS = MOTION.themeCrossfade.duration;
const RTL = new Set(['ar', 'he']);

/**
 * "Choose your language" in every language the app has, one at a time: the
 * phone's language first, each held 2s, crossfading 300ms. Each line is that
 * locale's own `auth.track.chooseLanguage`.
 *
 * Screen readers get ONE stable heading in the phone's language and never
 * hear the rotation (the rotator is hidden from them, no live region). The
 * box keeps the tallest line's height, so a wrapping language never moves the
 * list. Reduce Motion, the app in the background or the step out of focus:
 * it holds the phone's language and stops.
 */
export default function RotatingLanguageHeading({
    phone,
    style,
    containerStyle,
}: {
    phone: string;
    /** The line's text style, without margins (the box is absolutely laid out). */
    style: StyleProp<TextStyle>;
    containerStyle?: StyleProp<ViewStyle>;
}) {
    const reduceMotion = useReducedMotion();
    const active = useAnimationsActive();
    const lines = useMemo(() => {
        const codes = Object.keys(i18n.options.resources ?? {});
        return languageHeadingOrder(phone, codes).map((code) => ({ code, text: i18n.getFixedT(code)(KEY) }));
    }, [phone]);
    const [index, setIndex] = useState(0);
    const [heights, setHeights] = useState<Record<string, number>>({});
    const rotating = active && !reduceMotion && lines.length > 1;

    useEffect(() => {
        if (!rotating) {
            setIndex(0);
            return;
        }
        const id = setInterval(() => setIndex((i) => (i + 1) % lines.length), HOLD_MS + FADE_MS);
        return () => clearInterval(id);
    }, [rotating, lines.length]);

    const tallest = Math.max(0, ...Object.values(heights));
    const line = lines[index];
    const dir = (code: string) => (RTL.has(code) ? 'rtl' : 'ltr');

    return (
        <View accessible accessibilityRole="header" accessibilityLabel={lines[0].text} style={[containerStyle, { minHeight: tallest }]}>
            {/* Every line laid out unseen, only to find the tallest. */}
            <View style={styles.measure} pointerEvents="none" importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
                {lines.map((l) => (
                    <Text
                        key={l.code}
                        style={[style, styles.ghost, { writingDirection: dir(l.code) }]}
                        onLayout={(e) => {
                            const h = e.nativeEvent.layout.height;
                            setHeights((prev) => (prev[l.code] === h ? prev : { ...prev, [l.code]: h }));
                        }}
                    >
                        {l.text}
                    </Text>
                ))}
            </View>
            <View importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
                <Animated.Text
                    key={line.code}
                    entering={rotating ? FadeIn.duration(FADE_MS) : undefined}
                    exiting={rotating ? FadeOut.duration(FADE_MS) : undefined}
                    style={[style, styles.line, { writingDirection: dir(line.code) }]}
                >
                    {line.text}
                </Animated.Text>
            </View>
        </View>
    );
}

const styles = StyleSheet.create({
    measure: { position: 'absolute', left: 0, right: 0, top: 0, opacity: 0 },
    ghost: { position: 'absolute', left: 0, right: 0 },
    line: { position: 'absolute', left: 0, right: 0 },
});
