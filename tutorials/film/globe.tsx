// A dotted Earth that turns behind the story grid, on transforms alone (native driver). Each
// meridian drives one shared node, r * sin(longitude - turn); every land dot on it slides by that
// times cos(latitude), which is the orthographic projection, so the turn is a real sphere. The far
// side fades out by cos, and dots narrow towards the rim.

import React from 'react';
import { Animated, StyleSheet, View } from 'react-native';

import { LAND, LAND_STEP, LAND_TOP } from './globe-land';
import type { Clock } from './stage';

const RAD = Math.PI / 180;
/** Keyframes per meridian: the curve between them is linear, a few degrees of turn each. */
const SAMPLES = 16;
const DOT = 14;

interface GlobeProps {
    readonly t: Clock;
    /** Radius in stage points. */
    readonly r: number;
    /** The turn runs from `a` to `b` ms, its centre longitude from `from` to `to` degrees. */
    readonly a: number;
    readonly b: number;
    readonly from: number;
    readonly to: number;
}

export const Globe: React.FC<GlobeProps> = ({ t, r, a, b, from, to }) => {
    const times = Array.from({ length: SAMPLES + 1 }, (_, k) => a + ((b - a) * k) / SAMPLES);
    const turns = times.map((_, k) => from + ((to - from) * k) / SAMPLES);
    return (
        <View style={[st.globe, { width: 2 * r, height: 2 * r }]}>
            <View style={[st.rim, { width: 2 * r, height: 2 * r, borderRadius: r }]} />
            {LAND.map((col, i) => {
                const lon = -180 + i * LAND_STEP;
                const d = turns.map((th) => (lon - th) * RAD);
                if (!d.some((x) => Math.cos(x) > 0)) return null;
                const slide = t.interpolate({ inputRange: times, outputRange: d.map((x) => r * Math.sin(x)), extrapolate: 'clamp' });
                const narrow = t.interpolate({ inputRange: times, outputRange: d.map((x) => Math.max(0.25, Math.cos(x))), extrapolate: 'clamp' });
                const opacity = t.interpolate({ inputRange: times, outputRange: d.map((x) => Math.min(1, Math.max(0, Math.cos(x) / 0.35))), extrapolate: 'clamp' });
                return (
                    <Animated.View key={lon} style={[StyleSheet.absoluteFill, { opacity }]}>
                        {[...col].map((ch, j) => {
                            if (ch !== '#') return null;
                            const lat = (LAND_TOP - j * LAND_STEP) * RAD;
                            const style = { left: r - DOT / 2, top: r - r * Math.sin(lat) - DOT / 2, opacity: 0.25 + 0.5 * Math.cos(lat), transform: [{ translateX: Animated.multiply(slide, Math.cos(lat)) }, { scaleX: narrow }] };
                            return <Animated.View key={j} style={[st.dot, style]} />;
                        })}
                    </Animated.View>
                );
            })}
        </View>
    );
};

const st = StyleSheet.create({
    // the Earth's axial tilt, so it reads as a globe and not a scrolling map
    globe: { transform: [{ rotate: '-18deg' }] },
    dot: { position: 'absolute', width: DOT, height: DOT, borderRadius: DOT / 2, backgroundColor: '#ffffff' },
    rim: { position: 'absolute', borderWidth: 2, borderColor: 'rgba(255,255,255,0.18)' },
});
