import React, { useEffect } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Animated, {
    Easing,
    cancelAnimation,
    useAnimatedStyle,
    useSharedValue,
    withDelay,
    withRepeat,
    withSequence,
    withTiming,
} from 'react-native-reanimated';

import { useAnimationsActive } from '@/lib/hooks/use-is-focused-safe';
import {
    SCENE_HEIGHT,
    TUTORIAL_ACCENT,
    TUTORIAL_ACCENT_EDGE,
    TUTORIAL_ACCENT_SOFT,
    TUTORIAL_MUTED_EDGE,
} from '../theme';

const STEP_MS = 900;
const HOLD_MS = 1800;

/**
 * One numbered row. Own component so each row owns its own shared value.
 */
const StepRow: React.FC<{
    readonly index: number;
    readonly total: number;
    readonly label: string;
    readonly active: boolean;
}> = ({ index, total, label, active }) => {
    const lit = useSharedValue(0);

    useEffect(() => {
        if (!active) {
            cancelAnimation(lit);
            // At rest every row reads as lit — the frozen frame must look
            // finished, not half-drawn.
            lit.value = 1;
            return;
        }
        const cycle = total * STEP_MS + HOLD_MS;
        lit.value = withDelay(
            index * STEP_MS,
            withRepeat(
                withSequence(
                    withTiming(1, { duration: STEP_MS, easing: Easing.out(Easing.quad) }),
                    withTiming(1, { duration: cycle - STEP_MS * 2 }),
                    withTiming(0.25, { duration: STEP_MS }),
                ),
                -1,
                false,
            ),
        );
        return () => cancelAnimation(lit);
    }, [active, index, lit, total]);

    const style = useAnimatedStyle(() => ({ opacity: 0.25 + lit.value * 0.75 }));
    const badgeStyle = useAnimatedStyle(() => ({
        transform: [{ scale: 0.9 + lit.value * 0.1 }],
    }));

    return (
        <Animated.View style={[styles.row, style]}>
            <Animated.View style={[styles.badge, badgeStyle]}>
                <Text style={styles.badgeText}>{index + 1}</Text>
            </Animated.View>
            <View style={styles.rowBody}>
                <Text style={styles.label} numberOfLines={2}>
                    {label}
                </Text>
            </View>
        </Animated.View>
    );
};

/**
 * `{ kind: 'steps' }` — the fifth placeholder kind, added because twelve
 * chapters on four kinds reads as repetitive where seven on four did not.
 *
 * A short vertical run of numbered rows that light up one after another and
 * then reset, for any slide teaching a SEQUENCE: where to tap, then what
 * happens. Unlike the other four it carries real copy, so the labels come in
 * resolved (`tutorials.chapters.<slug>.slides.<id>.steps.<n>`) — this component
 * never touches i18n itself.
 *
 * ⚠️ No branching on `placeholder.kind` here — see `IconPlaceholder`.
 */
const StepsPlaceholder: React.FC<{ readonly labels: readonly string[] }> = ({ labels }) => {
    const active = useAnimationsActive();
    const rows = labels.slice(0, 4);

    return (
        <View style={styles.root} pointerEvents="none">
            {rows.map((label, i) => (
                <StepRow
                    key={i}
                    index={i}
                    total={rows.length}
                    label={label}
                    active={active}
                />
            ))}
        </View>
    );
};

const BADGE = 26;

const styles = StyleSheet.create({
    root: {
        minHeight: SCENE_HEIGHT,
        justifyContent: 'center',
        paddingHorizontal: 8,
        gap: 10,
    },
    row: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
    },
    badge: {
        width: BADGE,
        height: BADGE,
        borderRadius: BADGE / 2,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: TUTORIAL_ACCENT_SOFT,
        borderWidth: 1,
        borderColor: TUTORIAL_ACCENT_EDGE,
    },
    badgeText: {
        color: TUTORIAL_ACCENT,
        fontSize: 12,
        fontWeight: '700',
    },
    rowBody: {
        flex: 1,
        borderRadius: 10,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: TUTORIAL_MUTED_EDGE,
        paddingHorizontal: 12,
        paddingVertical: 10,
    },
    label: {
        color: '#ffffff',
        fontSize: 13,
        lineHeight: 18,
    },
});

export default StepsPlaceholder;
