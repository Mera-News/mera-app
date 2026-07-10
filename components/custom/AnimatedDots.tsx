import { useThemeColors } from '@/lib/theme/tokens';
import React, { useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, {
    useAnimatedStyle,
    useSharedValue,
    withDelay,
    withRepeat,
    withSequence,
    withTiming,
} from 'react-native-reanimated';

interface AnimatedDotsProps {
    color?: string;
    size?: number;
}

const AnimatedDots: React.FC<AnimatedDotsProps> = ({ color, size = 4 }) => {
    const colors = useThemeColors();
    const dotColor = color ?? colors.icon;
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

    const dotStyle = { width: size, height: size, borderRadius: size / 2, backgroundColor: dotColor };

    return (
        <View style={styles.row}>
            <Animated.View style={[dotStyle, dot1Style]} />
            <Animated.View style={[dotStyle, dot2Style]} />
            <Animated.View style={[dotStyle, dot3Style]} />
        </View>
    );
};

const styles = StyleSheet.create({
    row: { flexDirection: 'row', alignItems: 'center', gap: 4 },
});

export default AnimatedDots;
