import React, { useCallback, useEffect, useState } from 'react';
import { I18nManager, StyleSheet, View, type AccessibilityActionEvent, type LayoutChangeEvent } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { runOnJS, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';

import { Text } from '@/components/ui/text';
import { hapticSelection } from '@/lib/haptics';
import { useColors } from '@/lib/theme/tokens';

import { ratioToValue, valueToRatio, xToRatio } from './math';

export interface StepSliderProps {
    readonly value: number;
    readonly min: number;
    readonly max: number;
    readonly step: number;
    /** Called once per release (and per screen-reader step) with the snapped value. */
    readonly onChange: (value: number) => void;
    /** The bubble's and the screen reader's text for a value ("70%"). */
    readonly formatValue: (value: number) => string;
    readonly lowLabel: string;
    readonly highLabel: string;
    readonly accessibilityLabel: string;
    readonly testID?: string;
}

const THUMB = 24;
const TRACK = 4;
/** The whole row takes touches, not only the 4pt line. */
const HIT = 44;

/**
 * A stepped slider with Low / High under its ends. No number at rest; while
 * dragging, a bubble above the thumb shows the value. Snaps to `step`, ticks a
 * selection haptic per step, commits on release. Screen readers get one
 * adjustable control that moves one step per swipe. Mirrors in right-to-left.
 * JS only (gesture-handler + Reanimated): no native slider dependency.
 */
export function StepSlider({
    value,
    min,
    max,
    step,
    onChange,
    formatValue,
    lowLabel,
    highLabel,
    accessibilityLabel,
    testID,
}: StepSliderProps) {
    const colors = useColors();
    const rtl = I18nManager.isRTL;
    const [width, setWidth] = useState(0);
    const [draft, setDraft] = useState<number | null>(null);
    const ratio = useSharedValue(valueToRatio(value, min, max));
    const dragging = useSharedValue(0);
    const lastStep = useSharedValue(value);

    // Follow the stored value (Mera may set it) whenever no drag is running.
    useEffect(() => {
        if (draft === null) ratio.value = valueToRatio(value, min, max);
    }, [value, min, max, draft, ratio]);

    const tick = useCallback((v: number) => {
        setDraft(v);
        void hapticSelection();
    }, []);
    const release = useCallback(
        (v: number) => {
            setDraft(null);
            if (v !== value) onChange(v);
        },
        [onChange, value],
    );

    const pan = Gesture.Pan()
        .minDistance(0)
        .onBegin((e) => {
            const v = ratioToValue(xToRatio(e.x, width, rtl), min, max, step);
            dragging.value = withTiming(1, { duration: 120 });
            ratio.value = valueToRatio(v, min, max);
            lastStep.value = v;
            runOnJS(tick)(v);
        })
        .onUpdate((e) => {
            const v = ratioToValue(xToRatio(e.x, width, rtl), min, max, step);
            ratio.value = valueToRatio(v, min, max);
            if (v !== lastStep.value) {
                lastStep.value = v;
                runOnJS(tick)(v);
            }
        })
        .onFinalize(() => {
            dragging.value = withTiming(0, { duration: 120 });
            runOnJS(release)(lastStep.value);
        });

    // Positions are from the START edge, so right-to-left mirrors by `start`.
    const fillStyle = useAnimatedStyle(() => ({ width: ratio.value * width }));
    const thumbStyle = useAnimatedStyle(() => ({ transform: [{ translateX: (rtl ? -1 : 1) * ratio.value * width }] }));
    const bubbleStyle = useAnimatedStyle(() => ({
        opacity: dragging.value,
        transform: [{ translateX: (rtl ? -1 : 1) * ratio.value * width }, { translateY: (1 - dragging.value) * 4 }],
    }));

    const onAction = (e: AccessibilityActionEvent) => {
        const dir = e.nativeEvent.actionName === 'increment' ? 1 : e.nativeEvent.actionName === 'decrement' ? -1 : 0;
        if (!dir) return;
        const next = ratioToValue(valueToRatio(value + dir * step, min, max), min, max, step);
        if (next !== value) onChange(next);
    };

    return (
        <View
            testID={testID}
            accessible
            accessibilityRole="adjustable"
            accessibilityLabel={accessibilityLabel}
            accessibilityValue={{ text: formatValue(value) }}
            accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
            onAccessibilityAction={onAction}
            style={styles.root}
        >
            <GestureDetector gesture={pan}>
                <View style={styles.hit} onLayout={(e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width)}>
                    <View style={[styles.track, { backgroundColor: colors.line }]} />
                    <Animated.View style={[styles.track, styles.fill, { backgroundColor: colors.accent }, fillStyle]} />
                    <Animated.View
                        style={[styles.thumb, { backgroundColor: colors.ink, borderColor: colors.base }, thumbStyle]}
                    />
                    <Animated.View pointerEvents="none" style={[styles.bubble, { backgroundColor: colors.panel, borderColor: colors.panelBorder }, bubbleStyle]}>
                        <Text style={[styles.bubbleText, { color: colors.ink }]}>{draft === null ? '' : formatValue(draft)}</Text>
                    </Animated.View>
                </View>
            </GestureDetector>
            <View style={styles.legend} importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
                <Text style={[styles.legendText, { color: colors.ink3 }]}>{lowLabel}</Text>
                <Text style={[styles.legendText, { color: colors.ink3 }]}>{highLabel}</Text>
            </View>
        </View>
    );
}

const BUBBLE_W = 52;
const styles = StyleSheet.create({
    root: { paddingHorizontal: THUMB / 2 },
    hit: { height: HIT, justifyContent: 'center' },
    track: { height: TRACK, borderRadius: TRACK / 2 },
    fill: { position: 'absolute', start: 0 },
    thumb: {
        position: 'absolute',
        start: -THUMB / 2,
        width: THUMB,
        height: THUMB,
        borderRadius: THUMB / 2,
        borderWidth: 2,
    },
    bubble: {
        position: 'absolute',
        start: -BUBBLE_W / 2,
        bottom: HIT / 2 + THUMB / 2 + 4,
        width: BUBBLE_W,
        paddingVertical: 4,
        borderRadius: 10,
        borderWidth: 1,
        alignItems: 'center',
    },
    bubbleText: { fontSize: 13, fontWeight: '700' },
    legend: { flexDirection: 'row', justifyContent: 'space-between', marginHorizontal: -THUMB / 2 },
    legendText: { fontSize: 12 },
});
