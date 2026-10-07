import React, { useEffect, useRef, useState } from 'react';
import { Image, StyleSheet } from 'react-native';
import Animated, { runOnJS, useAnimatedStyle, useReducedMotion, useSharedValue, withTiming } from 'react-native-reanimated';
import { captureScreen } from 'react-native-view-shot';

import { EASE, MOTION } from '@/lib/motion';
import { registerThemeCrossfade } from '@/lib/theme/theme-store';

/**
 * The 300 ms crossfade when the theme changes (FinalJourney "Changing the
 * theme"): a snapshot of the screen in the old theme is laid over the app, the
 * theme switches underneath, and the snapshot fades out. One screenshot per
 * switch, nothing per frame. Reduce Motion, or a capture that fails: the switch
 * is instant. Mounted once at the root, above everything.
 */
export function ThemeCrossfade() {
    const reduceMotion = useReducedMotion();
    const [uri, setUri] = useState<string | null>(null);
    const opacity = useSharedValue(0);
    const reduceRef = useRef(reduceMotion);
    reduceRef.current = reduceMotion;

    useEffect(() => {
        registerThemeCrossfade(async (apply) => {
            if (reduceRef.current) {
                apply();
                return;
            }
            let shot: string | null = null;
            try {
                shot = await captureScreen({ format: 'jpg', quality: 0.9, result: 'tmpfile' });
            } catch {
                shot = null;
            }
            if (!shot) {
                apply();
                return;
            }
            opacity.value = 1;
            setUri(shot);
            // The snapshot is on screen before the theme changes under it.
            requestAnimationFrame(() => {
                apply();
                opacity.value = withTiming(0, { duration: MOTION.themeCrossfade.duration, easing: EASE.across }, (done) => {
                    if (done) runOnJS(setUri)(null);
                });
            });
        });
        return () => registerThemeCrossfade(null);
    }, [opacity]);

    const style = useAnimatedStyle(() => ({ opacity: opacity.value }));
    if (!uri) return null;
    return (
        <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, style]}>
            <Image source={{ uri }} style={StyleSheet.absoluteFill} />
        </Animated.View>
    );
}
