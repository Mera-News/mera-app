import MeraLogo from '@/components/custom/MeraLogo';
import { Text } from '@/components/ui/text';
import React, { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, {
    FadeIn,
    FadeOut,
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

const StreamingIndicator: React.FC = () => {
    const [labelIndex, setLabelIndex] = useState(0);

    // Cycle through labels
    useEffect(() => {
        const interval = setInterval(() => {
            setLabelIndex((i) => (i + 1) % STREAMING_LABELS.length);
        }, STREAMING_LABEL_CYCLE_MS);
        return () => clearInterval(interval);
    }, []);

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

    return (
        <View style={streamingIndicatorStyles.container}>
            <MeraLogo size={48} />
            <View style={streamingIndicatorStyles.labelRow}>
                <Animated.View
                    key={labelIndex}
                    entering={FadeIn.duration(300)}
                    exiting={FadeOut.duration(300)}
                    style={streamingIndicatorStyles.labelInner}
                >
                    <Text size="sm" style={streamingIndicatorStyles.label}>
                        {STREAMING_LABELS[labelIndex]}
                    </Text>
                    <View style={streamingIndicatorStyles.dotsRow}>
                        <Animated.View style={[streamingIndicatorStyles.dot, dot1Style]} />
                        <Animated.View style={[streamingIndicatorStyles.dot, dot2Style]} />
                        <Animated.View style={[streamingIndicatorStyles.dot, dot3Style]} />
                    </View>
                </Animated.View>
            </View>
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
