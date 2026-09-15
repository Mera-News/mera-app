import React, { useEffect } from 'react';
import { View } from 'react-native';
import Animated, {
    Easing,
    cancelAnimation,
    useAnimatedStyle,
    useSharedValue,
    withRepeat,
    withTiming,
} from 'react-native-reanimated';

import { PROCESSING_SCENE_SIZE, type StageFallbackKind } from './types';

/**
 * What a stage draws when it has no animation file.
 *
 * Six kinds, SIX COMPONENTS, and a pure dispatcher at the bottom that does the
 * only `switch`. That shape is not tidiness: `reactCompiler: true` is on, so a
 * single component that branched on `kind` and also called `useSharedValue`
 * would have a conditional hook. `components/custom/MeraLogo.tsx` documents the
 * same discipline and `components/custom/tutorials/ScenePlaceholder.tsx`
 * follows it for the tutorials placeholders.
 *
 * Each kind mirrors its stage's real animation at a glance, so a device with
 * Reduce Motion on or a stage whose asset has been commented out still says the
 * same thing in the same visual language, just with fewer moving parts.
 *
 * `active` is `useAnimationsActive() && !isStatic` resolved by the caller. When
 * it is false every loop is cancelled and the composition holds its first
 * frame, which is a legitimate still rather than an arbitrary slice.
 */

const SIZE = PROCESSING_SCENE_SIZE;
const ACCENT = 'rgb(231, 138, 83)';
const DIM = 'rgba(255, 255, 255, 0.22)';

/** One shared loop driver. Each kind owns exactly one of these. */
function useLoop(active: boolean, durationMs: number) {
    const t = useSharedValue(0);
    useEffect(() => {
        if (!active) {
            cancelAnimation(t);
            t.value = 0;
            return;
        }
        t.value = 0;
        t.value = withRepeat(
            withTiming(1, { duration: durationMs, easing: Easing.inOut(Easing.ease) }),
            -1,
            false,
        );
        return () => cancelAnimation(t);
    }, [active, durationMs, t]);
    return t;
}

const dotStyle = (size: number, colour: string) => ({
    position: 'absolute' as const,
    width: size,
    height: size,
    borderRadius: size / 2,
    backgroundColor: colour,
});

/** fetching — marks arriving from the rim toward one centre. */
const ConvergeFallback: React.FC<{ active: boolean }> = ({ active }) => {
    const t = useLoop(active, 3200);
    const style = useAnimatedStyle(() => ({
        opacity: 0.35 + t.value * 0.55,
        transform: [{ scale: 1 - t.value * 0.45 }],
    }));
    return (
        <View style={{ width: SIZE, height: SIZE, alignItems: 'center', justifyContent: 'center' }}>
            <View style={dotStyle(22, ACCENT)} />
            <Animated.View
                style={[
                    {
                        position: 'absolute',
                        width: SIZE * 0.86,
                        height: SIZE * 0.86,
                        borderRadius: SIZE,
                        borderWidth: 2,
                        borderColor: ACCENT,
                    },
                    style,
                ]}
            />
        </View>
    );
};

/** downloading — articles landing on a shelf that is already partly full. */
const DescendFallback: React.FC<{ active: boolean }> = ({ active }) => {
    const t = useLoop(active, 2400);
    const style = useAnimatedStyle(() => ({
        opacity: t.value < 0.15 || t.value > 0.85 ? 0 : 0.95,
        transform: [{ translateY: -SIZE * 0.34 + t.value * SIZE * 0.5 }],
    }));
    return (
        <View style={{ width: SIZE, height: SIZE, alignItems: 'center', justifyContent: 'center' }}>
            <View style={{ position: 'absolute', bottom: SIZE * 0.2, gap: 6 }}>
                <View style={{ width: SIZE * 0.72, height: 8, borderRadius: 4, backgroundColor: DIM }} />
                <View style={{ width: SIZE * 0.72, height: 8, borderRadius: 4, backgroundColor: ACCENT, opacity: 0.6 }} />
            </View>
            <Animated.View
                style={[
                    { width: SIZE * 0.72, height: 8, borderRadius: 4, backgroundColor: ACCENT },
                    style,
                ]}
            />
        </View>
    );
};

/** grouping — many marks becoming fewer. */
const MergeFallback: React.FC<{ active: boolean }> = ({ active }) => {
    const t = useLoop(active, 3000);
    const style = useAnimatedStyle(() => ({
        opacity: t.value < 0.1 || t.value > 0.9 ? 0 : 0.9,
        transform: [{ translateX: SIZE * 0.34 * (1 - t.value) }],
    }));
    const mirrored = useAnimatedStyle(() => ({
        opacity: t.value < 0.1 || t.value > 0.9 ? 0 : 0.9,
        transform: [{ translateX: -SIZE * 0.34 * (1 - t.value) }],
    }));
    return (
        <View style={{ width: SIZE, height: SIZE, alignItems: 'center', justifyContent: 'center' }}>
            <View
                style={{
                    width: SIZE * 0.4,
                    height: SIZE * 0.4,
                    borderRadius: SIZE,
                    borderWidth: 2,
                    borderColor: DIM,
                }}
            />
            <Animated.View style={[dotStyle(16, ACCENT), style]} />
            <Animated.View style={[dotStyle(16, ACCENT), mirrored]} />
        </View>
    );
};

/** analysing — a reading sweep crossing a still field. */
const SweepFallback: React.FC<{ active: boolean }> = ({ active }) => {
    const t = useLoop(active, 2600);
    const style = useAnimatedStyle(() => ({
        opacity: t.value < 0.08 || t.value > 0.92 ? 0 : 0.7,
        transform: [{ translateX: -SIZE * 0.4 + t.value * SIZE * 0.8 }],
    }));
    return (
        <View style={{ width: SIZE, height: SIZE, alignItems: 'center', justifyContent: 'center' }}>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', width: SIZE * 0.7, gap: 10, justifyContent: 'center' }}>
                {[0, 1, 2, 3, 4, 5, 6, 7, 8].map((i) => (
                    <View key={i} style={{ width: 12, height: 12, borderRadius: 6, backgroundColor: DIM }} />
                ))}
            </View>
            <Animated.View
                style={[
                    { position: 'absolute', width: 3, height: SIZE * 0.66, borderRadius: 2, backgroundColor: ACCENT },
                    style,
                ]}
            />
        </View>
    );
};

/** summarising — a line writing itself inside a note. */
const WriteFallback: React.FC<{ active: boolean }> = ({ active }) => {
    const t = useLoop(active, 2800);
    const style = useAnimatedStyle(() => ({
        opacity: t.value > 0.9 ? 0 : 1,
        width: SIZE * 0.5 * Math.min(1, t.value * 1.4),
    }));
    return (
        <View style={{ width: SIZE, height: SIZE, alignItems: 'center', justifyContent: 'center' }}>
            <View
                style={{
                    width: SIZE * 0.66,
                    height: SIZE * 0.76,
                    borderRadius: 14,
                    borderWidth: 2,
                    borderColor: ACCENT,
                    opacity: 0.55,
                    justifyContent: 'center',
                    paddingHorizontal: 12,
                    gap: 8,
                }}
            >
                <View style={{ width: SIZE * 0.42, height: 5, borderRadius: 3, backgroundColor: DIM }} />
                <Animated.View style={[{ height: 5, borderRadius: 3, backgroundColor: ACCENT }, style]} />
                <View style={{ width: SIZE * 0.3, height: 5, borderRadius: 3, backgroundColor: DIM }} />
            </View>
        </View>
    );
};

/** preparing — cards squaring up into a deck. */
const StackFallback: React.FC<{ active: boolean }> = ({ active }) => {
    const t = useLoop(active, 2600);
    const style = useAnimatedStyle(() => ({
        opacity: t.value < 0.12 || t.value > 0.88 ? 0 : 0.95,
        transform: [{ translateX: SIZE * 0.26 * (1 - t.value) }],
    }));
    return (
        <View style={{ width: SIZE, height: SIZE, alignItems: 'center', justifyContent: 'center', gap: 8 }}>
            <View style={{ width: SIZE * 0.66, height: 16, borderRadius: 8, borderWidth: 2, borderColor: DIM }} />
            <Animated.View
                style={[
                    { width: SIZE * 0.66, height: 16, borderRadius: 8, borderWidth: 2, borderColor: ACCENT },
                    style,
                ]}
            />
            <View style={{ width: SIZE * 0.66, height: 16, borderRadius: 8, borderWidth: 2, borderColor: DIM }} />
        </View>
    );
};

interface StageFallbackProps {
    readonly kind: StageFallbackKind;
    /** `useAnimationsActive() && !isStatic`, resolved by the caller. */
    readonly active: boolean;
}

/** The only `switch`, and it calls no hook. */
const StageFallback: React.FC<StageFallbackProps> = ({ kind, active }) => {
    switch (kind) {
        case 'converge':
            return <ConvergeFallback active={active} />;
        case 'descend':
            return <DescendFallback active={active} />;
        case 'merge':
            return <MergeFallback active={active} />;
        case 'sweep':
            return <SweepFallback active={active} />;
        case 'write':
            return <WriteFallback active={active} />;
        case 'stack':
            return <StackFallback active={active} />;
    }
};

export default StageFallback;
