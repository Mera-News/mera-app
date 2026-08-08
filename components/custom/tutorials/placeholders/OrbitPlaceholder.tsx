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
    SCENE_HEIGHT,
    TUTORIAL_ACCENT,
    TUTORIAL_ACCENT_EDGE,
    TUTORIAL_ACCENT_SOFT,
    TUTORIAL_MUTED_EDGE,
} from '../theme';

const ORBIT_MS = 9000;
const RADIUS = 76;
const DOTS = 5;

/**
 * `{ kind: 'orbit' }` — small dots circling a central glyph, for "many things
 * gathering around one thing" (one fact fanning into topics, developments
 * collecting on a story, decoys around a real phrase).
 *
 * The whole ring rotates as ONE view: five independently-animated dots would be
 * five shared values and five worklets for a shape the eye reads as one object.
 * Each dot is a plain static child, positioned once.
 *
 * ⚠️ No branching on `placeholder.kind` here — see `IconPlaceholder`.
 */
const OrbitPlaceholder: React.FC<{ readonly name: MaterialIconName }> = ({ name }) => {
    const spin = useSharedValue(0);
    const active = useAnimationsActive();

    useEffect(() => {
        if (!active) {
            cancelAnimation(spin);
            return;
        }
        spin.value = withRepeat(
            withTiming(1, { duration: ORBIT_MS, easing: Easing.linear }),
            -1,
            false,
        );
        return () => cancelAnimation(spin);
    }, [active, spin]);

    const ringStyle = useAnimatedStyle(() => ({
        transform: [{ rotate: `${spin.value * 360}deg` }],
    }));

    return (
        <View style={styles.root} pointerEvents="none">
            <View style={styles.track} />
            <Animated.View style={[styles.ring, ringStyle]}>
                {Array.from({ length: DOTS }, (_, i) => {
                    const angle = (i / DOTS) * 2 * Math.PI;
                    return (
                        <View
                            key={i}
                            style={[
                                styles.dot,
                                {
                                    transform: [
                                        { translateX: Math.cos(angle) * RADIUS },
                                        { translateY: Math.sin(angle) * RADIUS },
                                    ],
                                },
                            ]}
                        />
                    );
                })}
            </Animated.View>
            <View style={styles.core}>
                <MaterialIcons name={name} size={36} color={TUTORIAL_ACCENT} />
            </View>
        </View>
    );
};

const CORE = 84;
const DOT = 10;

const styles = StyleSheet.create({
    root: {
        height: SCENE_HEIGHT,
        alignItems: 'center',
        justifyContent: 'center',
    },
    track: {
        position: 'absolute',
        width: RADIUS * 2,
        height: RADIUS * 2,
        borderRadius: RADIUS,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: TUTORIAL_MUTED_EDGE,
    },
    ring: {
        position: 'absolute',
        width: RADIUS * 2,
        height: RADIUS * 2,
        alignItems: 'center',
        justifyContent: 'center',
    },
    dot: {
        position: 'absolute',
        width: DOT,
        height: DOT,
        borderRadius: DOT / 2,
        backgroundColor: TUTORIAL_ACCENT_EDGE,
    },
    core: {
        width: CORE,
        height: CORE,
        borderRadius: CORE / 2,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: TUTORIAL_ACCENT_SOFT,
        borderWidth: 1,
        borderColor: TUTORIAL_ACCENT_EDGE,
    },
});

export default OrbitPlaceholder;
