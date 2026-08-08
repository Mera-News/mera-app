import React, { useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, {
    Easing,
    cancelAnimation,
    useAnimatedStyle,
    useSharedValue,
    withDelay,
    withRepeat,
    withTiming,
} from 'react-native-reanimated';

import { useAnimationsActive } from '@/lib/hooks/use-is-focused-safe';
import {
    BREATH_MS,
    SCENE_HEIGHT,
    TUTORIAL_ACCENT_EDGE,
    TUTORIAL_ACCENT_SOFT,
    TUTORIAL_MUTED,
    TUTORIAL_MUTED_EDGE,
} from '../theme';

/**
 * One card skeleton. Its own component so each card owns its own shared value —
 * a parent looping `useSharedValue` per card would be a conditional hook.
 */
const DriftingCard: React.FC<{
    readonly index: number;
    readonly accent: boolean;
    readonly active: boolean;
}> = ({ index, accent, active }) => {
    const drift = useSharedValue(0);

    useEffect(() => {
        if (!active) {
            cancelAnimation(drift);
            drift.value = 0;
            return;
        }
        drift.value = withDelay(
            index * 220,
            withRepeat(
                withTiming(1, { duration: BREATH_MS, easing: Easing.inOut(Easing.quad) }),
                -1,
                true,
            ),
        );
        return () => cancelAnimation(drift);
    }, [active, drift, index]);

    const style = useAnimatedStyle(() => ({
        transform: [{ translateY: -4 + drift.value * 8 }],
        opacity: 0.65 + drift.value * 0.35,
    }));

    return (
        <Animated.View
            style={[
                styles.card,
                accent ? styles.cardAccent : styles.cardMuted,
                style,
            ]}
        >
            <View style={[styles.line, styles.lineWide, accent && styles.lineAccent]} />
            <View style={[styles.line, styles.lineNarrow]} />
        </Animated.View>
    );
};

/**
 * `{ kind: 'cards' }` — a small stack of card skeletons breathing out of phase,
 * for anything about the feed. The FIRST card is accented: these slides are
 * usually about one card among many.
 *
 * ⚠️ No branching on `placeholder.kind` here — see `IconPlaceholder`.
 */
const CardsPlaceholder: React.FC<{ readonly count?: number }> = ({ count = 3 }) => {
    const active = useAnimationsActive();
    // Clamp: the scene block is a fixed height and four cards is already tight.
    const total = Math.max(1, Math.min(4, count));

    return (
        <View style={styles.root} pointerEvents="none">
            {Array.from({ length: total }, (_, i) => (
                <DriftingCard key={i} index={i} accent={i === 0} active={active} />
            ))}
        </View>
    );
};

const styles = StyleSheet.create({
    root: {
        height: SCENE_HEIGHT,
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
    },
    card: {
        width: 190,
        borderRadius: 10,
        borderWidth: 1,
        paddingHorizontal: 12,
        paddingVertical: 10,
        gap: 6,
    },
    cardAccent: {
        backgroundColor: TUTORIAL_ACCENT_SOFT,
        borderColor: TUTORIAL_ACCENT_EDGE,
    },
    cardMuted: {
        backgroundColor: TUTORIAL_MUTED,
        borderColor: TUTORIAL_MUTED_EDGE,
    },
    line: {
        height: 6,
        borderRadius: 3,
        backgroundColor: 'rgba(255,255,255,0.22)',
    },
    lineAccent: {
        backgroundColor: TUTORIAL_ACCENT_EDGE,
    },
    lineWide: { width: '82%' },
    lineNarrow: { width: '48%' },
});

export default CardsPlaceholder;
