import { usePathname } from 'expo-router';
import React, { useEffect, useRef, useState } from 'react';
import { StyleSheet, useWindowDimensions } from 'react-native';
import Animated, { runOnJS, useAnimatedStyle, useReducedMotion, useSharedValue, withTiming } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import MeraLogo from '@/components/custom/MeraLogo';
import { cornerPoint, useMeraCorner } from '@/components/custom/mera-button/corner';
import { EASE, MOTION } from '@/lib/motion';
import { MERA_BUTTON_SIZE, useMeraButtonBottom } from '@/lib/navigation/tab-bar';

/** The launch gates draw the logo at this size, centred (app/index.tsx, LoggedInGate). */
const GATE_LOGO = 96;
/** The mark inside the Mera button. */
const BUTTON_MARK = 38;
/** The button's distance from the screen edge, and a top corner's offset below
 *  the status bar. ponytail: mirrors MeraButtonHost's EDGE and header fallback
 *  rather than measuring; off by a few points at worst for a 300 ms flight. */
const EDGE = 16;
const TOP_FALLBACK = 64;

/**
 * Into the Feed (FinalStart #3): on a cold launch, the centred logo the gates
 * drew shrinks and travels into the Mera button's SAVED corner as the tabs
 * appear, then unmounts. Once per JS context, only on the first arrival from a
 * launch gate; Reduce Motion skips it. It never delays the splash release:
 * it mounts only after a tab route has committed.
 */
export default function LaunchLogoHandoff() {
    const pathname = usePathname();
    const corner = useMeraCorner();
    const { width, height } = useWindowDimensions();
    const insets = useSafeAreaInsets();
    const bottom = useMeraButtonBottom();
    const reduceMotion = useReducedMotion();
    const played = useRef(false);
    const lastPath = useRef<string | null>(null);
    const [flying, setFlying] = useState(false);

    useEffect(() => {
        const from = lastPath.current;
        lastPath.current = pathname;
        if (played.current) return;
        if (!pathname.startsWith('/logged-in/app_container')) return;
        played.current = true;
        // Only straight off a launch gate, never after onboarding or a deep link.
        if (reduceMotion || (from !== '/' && from !== '/logged-in')) return;
        setFlying(true);
    }, [pathname, reduceMotion]);

    const p = useSharedValue(0);
    useEffect(() => {
        if (!flying) return;
        p.value = withTiming(1, { duration: MOTION.launchLogo.duration, easing: EASE.across }, (done) => {
            if (done) runOnJS(setFlying)(false);
        });
    }, [flying, p]);

    const target = cornerPoint(corner, {
        width,
        height,
        top: insets.top + TOP_FALLBACK,
        bottom,
        inset: EDGE,
        size: MERA_BUTTON_SIZE,
    });
    const startX = (width - GATE_LOGO) / 2;
    const startY = (height - GATE_LOGO) / 2;
    const endX = target.x + (MERA_BUTTON_SIZE - GATE_LOGO) / 2;
    const endY = target.y + (MERA_BUTTON_SIZE - GATE_LOGO) / 2;
    const endScale = BUTTON_MARK / GATE_LOGO;

    const style = useAnimatedStyle(() => ({
        // Fades over the last 20% of the flight, into the button's own mark.
        opacity: p.value < 0.8 ? 1 : (1 - p.value) / 0.2,
        transform: [
            { translateX: startX + (endX - startX) * p.value },
            { translateY: startY + (endY - startY) * p.value },
            { scale: 1 + (endScale - 1) * p.value },
        ],
    }));

    if (!flying) return null;
    return (
        <Animated.View pointerEvents="none" style={[styles.logo, style]}>
            {/* The gates' working look, carried into the button. */}
            <MeraLogo size={GATE_LOGO} animated scrollCards />
        </Animated.View>
    );
}

const styles = StyleSheet.create({
    logo: { position: 'absolute', left: 0, top: 0, width: GATE_LOGO, height: GATE_LOGO },
});
