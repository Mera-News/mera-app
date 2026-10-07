import React, { useEffect, useRef } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';
import Animated, {
    useAnimatedStyle,
    useReducedMotion,
    useSharedValue,
    withDelay,
    withTiming,
} from 'react-native-reanimated';

import { hapticError, hapticSuccess } from '@/lib/haptics';
import { shakeX } from '@/lib/motion';
import { useColors } from '@/lib/theme/tokens';

export type OtpState = 'idle' | 'wrong' | 'right';

export interface OtpBoxesProps {
    /** Digits typed so far, 0 to 6. */
    value: string;
    onChange: (value: string) => void;
    /** The sixth digit landed; submit it. */
    onComplete: (code: string) => void;
    /** 'wrong': red with a shake; 'right': green, box by box. */
    state: OtpState;
    /** "6-digit code". */
    a11yLabel: string;
    autoFocus?: boolean;
    editable?: boolean;
    testID?: string;
}

const LENGTH = 6;
const RIGHT_STAGGER_MS = 30;

/**
 * Six boxes over ONE hidden TextInput (Journey #22, #23). The one input keeps
 * iOS's "From Mail" one-time-code autofill and the Android SMS hint, and the
 * keyboard never drops between boxes. A wrong code shakes and turns red and
 * clears nothing; the next digit typed starts a fresh code.
 */
export function OtpBoxes({ value, onChange, onComplete, state, a11yLabel, autoFocus, editable = true, testID }: OtpBoxesProps) {
    const colors = useColors();
    const reduceMotion = useReducedMotion();
    const shake = useSharedValue(0);
    const prev = useRef<OtpState>(state);

    useEffect(() => {
        if (prev.current === state) return;
        prev.current = state;
        if (state === 'wrong') {
            void hapticError();
            if (!reduceMotion) shake.value = shakeX();
        } else if (state === 'right') {
            void hapticSuccess();
        }
    }, [state, reduceMotion, shake]);

    const row = useAnimatedStyle(() => ({ transform: [{ translateX: shake.value }] }));

    const handle = (text: string) => {
        const digits = text.replace(/\D/g, '');
        // After a wrong code, typing starts over with the new digit.
        let next = state === 'wrong' && digits.length > value.length ? digits.slice(value.length) : digits;
        next = next.slice(0, LENGTH);
        onChange(next);
        if (next.length === LENGTH) onComplete(next);
    };

    return (
        <View testID={testID}>
            <Animated.View style={[styles.row, row]} pointerEvents="none">
                {Array.from({ length: LENGTH }, (_, i) => (
                    <Box
                        key={i}
                        index={i}
                        digit={value[i] ?? ''}
                        active={state === 'idle' && editable && i === Math.min(value.length, LENGTH - 1)}
                        state={state}
                        colors={colors}
                    />
                ))}
            </Animated.View>
            <TextInput
                value={value}
                onChangeText={handle}
                keyboardType="number-pad"
                textContentType="oneTimeCode"
                autoComplete="one-time-code"
                autoFocus={autoFocus}
                editable={editable}
                caretHidden
                accessibilityLabel={a11yLabel}
                testID={testID ? `${testID}-input` : undefined}
                style={styles.hidden}
            />
        </View>
    );
}

function Box({
    index,
    digit,
    active,
    state,
    colors,
}: {
    index: number;
    digit: string;
    active: boolean;
    state: OtpState;
    colors: ReturnType<typeof useColors>;
}) {
    const green = useSharedValue(0);
    useEffect(() => {
        green.value = state === 'right' ? withDelay(index * RIGHT_STAGGER_MS, withTiming(1, { duration: 120 })) : 0;
    }, [state, index, green]);
    const border =
        state === 'wrong' ? colors.negative : active ? colors.accent : colors.line;
    const greenStyle = useAnimatedStyle(() => ({ opacity: green.value }));
    return (
        <View style={[styles.box, { borderColor: border, backgroundColor: colors.surface }]}>
            <Animated.View
                pointerEvents="none"
                style={[StyleSheet.absoluteFill, styles.boxGreen, { borderColor: colors.positive }, greenStyle]}
            />
            <Text style={[styles.digit, { color: state === 'wrong' ? colors.negative : colors.ink }]}>{digit}</Text>
        </View>
    );
}

const styles = StyleSheet.create({
    row: { flexDirection: 'row', gap: 8, justifyContent: 'center' },
    box: {
        width: 44,
        height: 52,
        borderRadius: 10,
        borderWidth: 1.5,
        alignItems: 'center',
        justifyContent: 'center',
    },
    boxGreen: { borderRadius: 10, borderWidth: 1.5 },
    digit: { fontSize: 22, fontWeight: '700' },
    // Covers the boxes so a tap anywhere focuses the input; the text itself is invisible.
    hidden: { ...StyleSheet.absoluteFillObject, opacity: 0.011, color: 'transparent' },
});
