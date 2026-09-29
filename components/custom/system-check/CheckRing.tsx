import React, { useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, { useAnimatedProps, useReducedMotion, useSharedValue, withTiming } from 'react-native-reanimated';
import Svg, { Circle } from 'react-native-svg';
import { useDisplayPrefsStore } from '@/lib/stores/display-prefs-store';

const AnimatedCircle = Animated.createAnimatedComponent(Circle);

const STROKE = 6;
const TRACK = 'rgba(255, 255, 255, 0.12)';
const FILL = 'rgb(237, 167, 126)';
const FILL_MS = 450;

interface CheckRingProps {
    /** 0..1: the share of checks that finished. */
    progress: number;
    size: number;
    children?: React.ReactNode;
}

/**
 * The system check's progress ring. It fills as each check finishes, so the
 * motion is a fact about the checks, not decoration. Lite mode and Reduce
 * Motion get the same ring without the easing.
 */
const CheckRing: React.FC<CheckRingProps> = ({ progress, size, children }) => {
    const liteMode = useDisplayPrefsStore((s) => s.liteMode);
    const reduceMotion = useReducedMotion();
    const still = liteMode || reduceMotion;

    const radius = (size - STROKE) / 2;
    const circumference = 2 * Math.PI * radius;
    const clamped = Math.max(0, Math.min(1, progress));
    const target = circumference * (1 - clamped);

    const offset = useSharedValue(still ? target : circumference);
    useEffect(() => {
        offset.value = still ? target : withTiming(target, { duration: FILL_MS });
    }, [offset, still, target]);
    const animatedProps = useAnimatedProps(() => ({ strokeDashoffset: offset.value }));

    return (
        <View
            style={{ width: size, height: size }}
            accessibilityRole="progressbar"
            accessibilityValue={{ min: 0, max: 100, now: Math.round(clamped * 100) }}
        >
            <Svg width={size} height={size} style={StyleSheet.absoluteFill}>
                <Circle cx={size / 2} cy={size / 2} r={radius} stroke={TRACK} strokeWidth={STROKE} fill="none" />
                <AnimatedCircle
                    cx={size / 2}
                    cy={size / 2}
                    r={radius}
                    stroke={FILL}
                    strokeWidth={STROKE}
                    strokeLinecap="round"
                    fill="none"
                    strokeDasharray={`${circumference} ${circumference}`}
                    animatedProps={animatedProps}
                    // Start at 12 o'clock and fill clockwise.
                    transform={`rotate(-90 ${size / 2} ${size / 2})`}
                />
            </Svg>
            <View style={[StyleSheet.absoluteFill, styles.center]}>{children}</View>
        </View>
    );
};

const styles = StyleSheet.create({
    center: { alignItems: 'center', justifyContent: 'center' },
});

export default CheckRing;
