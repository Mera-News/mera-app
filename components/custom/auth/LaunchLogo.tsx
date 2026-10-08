import React, { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, { runOnJS, useAnimatedStyle, useReducedMotion, useSharedValue, withTiming } from 'react-native-reanimated';

import MeraLogo from '@/components/custom/MeraLogo';
import { EASE, MOTION } from '@/lib/motion';

/** The first launch logo in this JS context waits one frame before it starts
 *  working, so the native splash → JS handoff lands on the plain mark. */
let handoffFrameDone = false;

/**
 * The big launch logo. `working` is the Mera button's busy look (cone and
 * scrolling cards) while the app starts; turning it off crossfades, in place,
 * to the plain moving logo (cone only), on the launch-logo timing. Two layers
 * of one size in one box, so nothing moves or resizes. Reduce Motion and Lite
 * mode: MeraLogo holds both still; the switch is then instant.
 */
export default function LaunchLogo({ size, working }: { size: number; working: boolean }) {
    const reduceMotion = useReducedMotion();
    const [armed, setArmed] = useState(handoffFrameDone);
    useEffect(() => {
        if (armed) return;
        const id = requestAnimationFrame(() => {
            handoffFrameDone = true;
            setArmed(true);
        });
        return () => cancelAnimationFrame(id);
    }, [armed]);

    const on = working && armed;
    // The working layer is mounted only while it shows or fades, so its card
    // clock never runs behind a settled logo.
    const [workMounted, setWorkMounted] = useState(on);
    const w = useSharedValue(on ? 1 : 0);
    useEffect(() => {
        if (on) setWorkMounted(true);
        w.value = withTiming(
            on ? 1 : 0,
            { duration: reduceMotion ? 0 : MOTION.launchLogo.duration, easing: EASE.across },
            (done) => {
                if (done && !on) runOnJS(setWorkMounted)(false);
            },
        );
    }, [on, reduceMotion, w]);

    const calmStyle = useAnimatedStyle(() => ({ opacity: 1 - w.value }));
    const workStyle = useAnimatedStyle(() => ({ opacity: w.value }));
    return (
        <View style={{ width: size, height: size }}>
            <Animated.View style={[StyleSheet.absoluteFill, calmStyle]}>
                <MeraLogo size={size} animated />
            </Animated.View>
            {workMounted ? (
                <Animated.View style={[StyleSheet.absoluteFill, workStyle]}>
                    <MeraLogo size={size} animated scrollCards />
                </Animated.View>
            ) : null}
        </View>
    );
}
