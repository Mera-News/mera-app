import { MaterialIcons } from '@expo/vector-icons';
import React, { useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, {
    Easing,
    cancelAnimation,
    useAnimatedStyle,
    useSharedValue,
    withRepeat,
    withTiming,
} from 'react-native-reanimated';

import { useAnimationsActive } from '@/lib/hooks/use-is-focused-safe';
import type { MaterialIconName } from '@/lib/tutorials/types';
import {
    BREATH_MS,
    SCENE_HEIGHT,
    TUTORIAL_ACCENT,
    TUTORIAL_ACCENT_EDGE,
    TUTORIAL_ACCENT_SOFT,
} from '../theme';

/**
 * `{ kind: 'icon' }` — one accent glyph inside a breathing disc, with a second
 * ring that expands and fades like a slow sonar ping.
 *
 * ⚠️ `reactCompiler: true`. This component NEVER branches on `placeholder.kind`
 * — it is one of five siblings, each owning its own `useSharedValue` calls, and
 * the hook-free `ScenePlaceholder` switch is what picks between them. Branching
 * on the kind inside a single component with shared values is the highest
 * probability bug in this module; `components/custom/MeraLogo.tsx:20-27`
 * documents the same discipline.
 */
const IconPlaceholder: React.FC<{ readonly name: MaterialIconName }> = ({ name }) => {
    const breath = useSharedValue(0);
    const ping = useSharedValue(0);
    const active = useAnimationsActive();

    useEffect(() => {
        if (!active) {
            cancelAnimation(breath);
            cancelAnimation(ping);
            breath.value = 0;
            ping.value = 0;
            return;
        }
        breath.value = withRepeat(
            withTiming(1, { duration: BREATH_MS, easing: Easing.inOut(Easing.quad) }),
            -1,
            true,
        );
        ping.value = withRepeat(
            withTiming(1, { duration: BREATH_MS * 1.5, easing: Easing.out(Easing.quad) }),
            -1,
            false,
        );
        return () => {
            cancelAnimation(breath);
            cancelAnimation(ping);
        };
    }, [active, breath, ping]);

    const discStyle = useAnimatedStyle(() => ({
        transform: [{ scale: 1 + breath.value * 0.06 }],
    }));

    const pingStyle = useAnimatedStyle(() => ({
        opacity: 0.5 * (1 - ping.value),
        transform: [{ scale: 1 + ping.value * 0.55 }],
    }));

    return (
        <View style={styles.root} pointerEvents="none">
            <Animated.View style={[styles.ring, pingStyle]} />
            <Animated.View style={[styles.disc, discStyle]}>
                <MaterialIcons name={name} size={52} color={TUTORIAL_ACCENT} />
            </Animated.View>
        </View>
    );
};

const DISC = 132;

const styles = StyleSheet.create({
    root: {
        height: SCENE_HEIGHT,
        alignItems: 'center',
        justifyContent: 'center',
    },
    disc: {
        width: DISC,
        height: DISC,
        borderRadius: DISC / 2,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: TUTORIAL_ACCENT_SOFT,
        borderWidth: 1,
        borderColor: TUTORIAL_ACCENT_EDGE,
    },
    ring: {
        position: 'absolute',
        width: DISC,
        height: DISC,
        borderRadius: DISC / 2,
        borderWidth: 1,
        borderColor: TUTORIAL_ACCENT_EDGE,
    },
});

export default IconPlaceholder;
