import MeraLogo from '@/components/custom/MeraLogo';
import { Text } from '@/components/ui/text';
import React, { useEffect, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import Animated, {
    Easing,
    FadeIn,
    type SharedValue,
    useAnimatedStyle,
    useSharedValue,
    withDelay,
    withRepeat,
    withSequence,
    withTiming,
} from 'react-native-reanimated';
import Svg, { Circle, Defs, RadialGradient, Stop } from 'react-native-svg';

const SPEECH_TEXT = 'Click me to update your Persona!';
const TYPEWRITER_INTERVAL_MS = 30;

const SIZE = 86;
const PRIMARY = 'rgb(231, 138, 83)';
const PULSE_SIZE = SIZE * 1.6;
const PULSE_DURATION = 2000;
const STAGGER = PULSE_DURATION / 3;

interface MeraAIBubbleProps {
    readonly onPress: () => void;
}

const TYPEWRITER_DURATION = SPEECH_TEXT.length * TYPEWRITER_INTERVAL_MS;
const SPEECH_VISIBLE_MS = 5000;

const PulseGradientCircle: React.FC<{ id: string }> = ({ id }) => (
    <Svg width={PULSE_SIZE} height={PULSE_SIZE}>
        <Defs>
            <RadialGradient id={id} cx="50%" cy="50%" r="50%">
                <Stop offset="0" stopColor="#FFFFFF" stopOpacity="1" />
                <Stop offset="0.25" stopColor="#FFa040" stopOpacity="0.9" />
                <Stop offset="0.5" stopColor="#FF6A00" stopOpacity="0.6" />
                <Stop offset="0.75" stopColor="#FF4500" stopOpacity="0.3" />
                <Stop offset="1" stopColor="#CC0000" stopOpacity="0" />
            </RadialGradient>
        </Defs>
        <Circle cx={PULSE_SIZE / 2} cy={PULSE_SIZE / 2} r={PULSE_SIZE / 2} fill={`url(#${id})`} />
    </Svg>
);

const PulseLayer: React.FC<{ scale: SharedValue<number>; opacity: SharedValue<number>; id: string }> = ({ scale, opacity, id }) => {
    const animStyle = useAnimatedStyle(() => ({
        transform: [{ scale: scale.value }],
        opacity: opacity.value,
    }));
    return (
        <Animated.View style={[styles.pulseCircle, animStyle]}>
            <PulseGradientCircle id={id} />
        </Animated.View>
    );
};

function usePulseAnimation(delay: number) {
    const scale = useSharedValue(0.5);
    const opacity = useSharedValue(0);

    useEffect(() => {
        scale.value = withDelay(
            delay,
            withRepeat(
                withSequence(
                    withTiming(0.5, { duration: 0 }),
                    withTiming(1.3, { duration: PULSE_DURATION, easing: Easing.out(Easing.ease) }),
                ),
                -1,
                false,
            ),
        );
        opacity.value = withDelay(
            delay,
            withRepeat(
                withSequence(
                    withTiming(1, { duration: 0 }),
                    withTiming(0, { duration: PULSE_DURATION, easing: Easing.out(Easing.ease) }),
                ),
                -1,
                false,
            ),
        );
    }, [delay, scale, opacity]);

    return { scale, opacity };
}

const MeraAIBubble: React.FC<MeraAIBubbleProps> = ({ onPress }) => {
    const [charIndex, setCharIndex] = useState(0);
    const speechOpacity = useSharedValue(1);

    const pulse0 = usePulseAnimation(0);
    const pulse1 = usePulseAnimation(STAGGER);
    const pulse2 = usePulseAnimation(STAGGER * 2);

    useEffect(() => {
        const interval = setInterval(() => {
            setCharIndex((prev) => {
                if (prev >= SPEECH_TEXT.length) {
                    clearInterval(interval);
                    return prev;
                }
                return prev + 1;
            });
        }, TYPEWRITER_INTERVAL_MS);
        return () => clearInterval(interval);
    }, []);

    useEffect(() => {
        speechOpacity.value = withDelay(
            TYPEWRITER_DURATION + SPEECH_VISIBLE_MS,
            withTiming(0, { duration: 500 }),
        );
    }, [speechOpacity]);

    const speechFadeStyle = useAnimatedStyle(() => ({
        opacity: speechOpacity.value,
    }));

    return (
        <Animated.View entering={FadeIn.duration(300)} style={styles.container}>
            <View style={styles.bubbleWrapper}>
                {/* Pulsing gradient circles */}
                <PulseLayer scale={pulse0.scale} opacity={pulse0.opacity} id="p0" />
                <PulseLayer scale={pulse1.scale} opacity={pulse1.opacity} id="p1" />
                <PulseLayer scale={pulse2.scale} opacity={pulse2.opacity} id="p2" />
                {/* Pressable bubble on top */}
                <Pressable onPress={onPress}>
                    {({ pressed }) => (
                        <View style={[styles.bubble, pressed && styles.bubblePressed]}>
                            <MeraLogo size={80} />
                        </View>
                    )}
                </Pressable>
            </View>
            {/* Speech bubble — below the button, fades out */}
            <Animated.View style={[styles.speechBubble, speechFadeStyle]}>
                <View style={styles.speechArrow} />
                <Text size="xs" style={styles.speechText}>
                    {SPEECH_TEXT.slice(0, charIndex)}
                </Text>
            </Animated.View>
        </Animated.View>
    );
};

const styles = StyleSheet.create({
    container: {
        alignItems: 'center',
    },
    bubbleWrapper: {
        width: PULSE_SIZE,
        height: PULSE_SIZE,
        alignItems: 'center',
        justifyContent: 'center',
    },
    pulseCircle: {
        position: 'absolute',
        width: PULSE_SIZE,
        height: PULSE_SIZE,
    },
    bubble: {
        width: SIZE,
        height: SIZE,
        borderRadius: SIZE / 2,
        alignItems: 'center',
        justifyContent: 'center',
    },
    bubblePressed: {
        opacity: 0.7,
    },
    speechBubble: {
        backgroundColor: '#000000',
        borderWidth: 1,
        borderColor: PRIMARY,
        paddingHorizontal: 14,
        paddingVertical: 8,
        borderRadius: 12,
        alignItems: 'center',
        marginTop: -(PULSE_SIZE - SIZE) / 2 + 4,
    },
    speechArrow: {
        position: 'absolute',
        top: -6,
        width: 0,
        height: 0,
        borderLeftWidth: 6,
        borderRightWidth: 6,
        borderBottomWidth: 6,
        borderLeftColor: 'transparent',
        borderRightColor: 'transparent',
        borderBottomColor: PRIMARY,
    },
    speechText: {
        color: '#FFFFFF',
        fontSize: 12,
    },
});

export default MeraAIBubble;
