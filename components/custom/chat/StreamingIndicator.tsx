import MeraLogo from '@/components/custom/MeraLogo';
import { Text } from '@/components/ui/text';
import React, { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, {
    useAnimatedStyle,
    useSharedValue,
    withDelay,
    withRepeat,
    withSequence,
    withTiming,
} from 'react-native-reanimated';

const STREAMING_LABELS = [
    'Understanding',
    'Analyzing',
    'Connecting dots',
    'Contextualizing',
    'Synthesizing',
    'Personalizing',
    'Mapping interests',
    'Learning preferences',
    'Building profile',
    'Calibrating',
    'Processing',
    'Refining taste',
    'Detecting patterns',
    'Adapting feed',
    'Evaluating signals',
    'Updating model',
    'Weighing topics',
    'Discovering themes',
    'Tuning relevance',
    'Optimizing',
];

const STREAMING_LABEL_CYCLE_MS = 2000;
// Half of the label crossfade. The caption fades OUT over this window, swaps
// text at the trough, then fades back IN — so exactly one caption is mounted
// (and painted) at any instant. Do NOT go back to a keyed Animated.View with
// entering/exiting: Reanimated keeps the exiting copy on screen (outside the
// layout flow) while the new one mounts, which drew two captions on top of each
// other inside the fixed-height labelRow.
const LABEL_FADE_MS = 220;

const DEFAULT_LABEL_COLOR = 'rgb(156, 163, 175)';
const DEFAULT_DOT_COLOR = 'rgb(231, 138, 83)';

interface StreamingIndicatorProps {
    /** Inline variant: label + dots only, no logo, no vertical padding. */
    compact?: boolean;
    /** Overrides both label and dot color (defaults: gray label, orange dots). */
    color?: string;
}

const StreamingIndicator: React.FC<StreamingIndicatorProps> = ({ compact = false, color }) => {
    const [labelIndex, setLabelIndex] = useState(0);
    const labelColor = color ?? DEFAULT_LABEL_COLOR;
    const dotColor = color ?? DEFAULT_DOT_COLOR;

    // Cycle through labels — fade the single caption out, swap the text while it
    // is invisible, fade it back in. One mounted label, one visible caption.
    const labelOpacity = useSharedValue(1);
    useEffect(() => {
        let swapTimer: ReturnType<typeof setTimeout> | undefined;
        const interval = setInterval(() => {
            labelOpacity.value = withTiming(0, { duration: LABEL_FADE_MS });
            swapTimer = setTimeout(() => {
                setLabelIndex((i) => (i + 1) % STREAMING_LABELS.length);
                labelOpacity.value = withTiming(1, { duration: LABEL_FADE_MS });
            }, LABEL_FADE_MS);
        }, STREAMING_LABEL_CYCLE_MS);
        return () => {
            clearInterval(interval);
            if (swapTimer) clearTimeout(swapTimer);
        };
    }, [labelOpacity]);

    const labelStyle = useAnimatedStyle(() => ({ opacity: labelOpacity.value }));

    // Dot pulse animations — each dot scales up then down in sequence
    // Cycle: 900ms total (300ms per dot), each dot 150ms up + 150ms down
    const dot1 = useSharedValue(1);
    const dot2 = useSharedValue(1);
    const dot3 = useSharedValue(1);

    useEffect(() => {
        const pulse = (delay: number) =>
            withDelay(
                delay,
                withRepeat(
                    withSequence(
                        withTiming(1.6, { duration: 150 }),
                        withTiming(1, { duration: 150 }),
                        withDelay(600, withTiming(1, { duration: 0 }))
                    ),
                    -1
                )
            );
        dot1.value = pulse(0);
        dot2.value = pulse(300);
        dot3.value = pulse(600);
    }, [dot1, dot2, dot3]);

    const dot1Style = useAnimatedStyle(() => ({ transform: [{ scale: dot1.value }] }));
    const dot2Style = useAnimatedStyle(() => ({ transform: [{ scale: dot2.value }] }));
    const dot3Style = useAnimatedStyle(() => ({ transform: [{ scale: dot3.value }] }));

    const labelRow = (
        <View style={streamingIndicatorStyles.labelRow}>
            <View style={streamingIndicatorStyles.labelInner}>
                {/* Only the WORD crossfades. The dots stay at full opacity: they
                    are the liveness signal, and the fade trough would otherwise
                    blank the whole indicator for a beat every cycle. */}
                <Animated.View style={labelStyle}>
                    <Text
                        testID="streaming-caption"
                        size="sm"
                        style={[streamingIndicatorStyles.label, { color: labelColor }]}
                    >
                        {STREAMING_LABELS[labelIndex]}
                    </Text>
                </Animated.View>
                <View style={streamingIndicatorStyles.dotsRow}>
                    <Animated.View style={[streamingIndicatorStyles.dot, { backgroundColor: dotColor }, dot1Style]} />
                    <Animated.View style={[streamingIndicatorStyles.dot, { backgroundColor: dotColor }, dot2Style]} />
                    <Animated.View style={[streamingIndicatorStyles.dot, { backgroundColor: dotColor }, dot3Style]} />
                </View>
            </View>
        </View>
    );

    if (compact) {
        return labelRow;
    }

    return (
        <View style={streamingIndicatorStyles.container}>
            <MeraLogo size={48} animated />
            {labelRow}
        </View>
    );
};

const streamingIndicatorStyles = StyleSheet.create({
    container: { alignItems: 'center', justifyContent: 'center', paddingVertical: 24, gap: 12 },
    labelRow: { height: 22, justifyContent: 'center', overflow: 'hidden' },
    labelInner: { flexDirection: 'row', alignItems: 'center' },
    label: { color: 'rgb(156, 163, 175)', fontSize: 13 },
    dotsRow: { flexDirection: 'row', alignItems: 'center', gap: 3, marginLeft: 2, marginBottom: -1 },
    dot: { width: 4, height: 4, borderRadius: 2, backgroundColor: 'rgb(231, 138, 83)' },
});

export default StreamingIndicator;
