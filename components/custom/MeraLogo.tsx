import React, { useEffect } from 'react';
import Svg, { Circle, ClipPath, G, Path, Rect } from 'react-native-svg';
import Animated, {
    useSharedValue,
    useAnimatedProps,
    withRepeat,
    withTiming,
    withSequence,
    Easing
} from 'react-native-reanimated';

// Create animated version of G component for SVG transforms
const AnimatedG = Animated.createAnimatedComponent(G);

interface MeraLogoProps {
    size?: number;
}

// Mera Logo Component with animated spotlight
const MeraLogo: React.FC<MeraLogoProps> = ({ size = 80 }) => {
    // Use shared value for rotation angle (Reanimated)
    const rotation = useSharedValue(-15);

    useEffect(() => {
        // Create a looping animation that rotates left and right smoothly
        rotation.value = withRepeat(
            withSequence(
                withTiming(15, { duration: 2000, easing: Easing.inOut(Easing.ease) }),
                withTiming(-15, { duration: 2000, easing: Easing.inOut(Easing.ease) })
            ),
            -1, // infinite repeat
            false // don't reverse
        );
    }, [rotation]);

    // Use animatedProps for SVG transform (Reanimated pattern)
    // The rotation center is at (512, 760), so we translate to center, rotate, translate back
    const animatedProps = useAnimatedProps(() => {
        return {
            transform: [
                { translateX: 512 },
                { translateY: 760 },
                { rotate: `${rotation.value}deg` },
                { translateX: -512 },
                { translateY: -760 },
            ],
        };
    });

    return (
        <Svg width={size} height={size} viewBox="0 0 1024 1024">
            {/* Hexagon outline */}
            <Path d="M512 170 L745 304 L745 720 L512 854 L279 720 L279 304 Z" fill="none" stroke="#fff" strokeWidth="24" strokeLinejoin="round" />
            <ClipPath id="hexB">
                <Path d="M512 170 L745 304 L745 720 L512 854 L279 720 L279 304 Z" />
            </ClipPath>
            <G clipPath="url(#hexB)">
                {/* Grid cards */}
                <G fill="none" stroke="#fff" strokeOpacity="0.18" strokeWidth="10">
                    <Rect x="320" y="330" width="150" height="110" rx="14" />
                    <Rect x="490" y="330" width="150" height="110" rx="14" />
                    <Rect x="660" y="330" width="150" height="110" rx="14" />
                    <Rect x="320" y="465" width="150" height="110" rx="14" />
                    <Rect x="490" y="465" width="150" height="110" rx="14" />
                    <Rect x="660" y="465" width="150" height="110" rx="14" />
                    <Rect x="320" y="600" width="150" height="110" rx="14" />
                    <Rect x="490" y="600" width="150" height="110" rx="14" />
                    <Rect x="660" y="600" width="150" height="110" rx="14" />
                </G>
                {/* Animated Spotlight cone */}
                <AnimatedG animatedProps={animatedProps}>
                    <Path
                        d="M512 760 L450 485 L574 485 Z"
                        fill="#fff"
                        opacity="0.300"
                    />
                </AnimatedG>
                {/* Highlighted card */}
                <Rect x="490" y="465" width="150" height="110" rx="14" fill="none" stroke="#fff" strokeWidth="16" />
                {/* Focus dot */}
                <Circle cx="512" cy="748" r="16" fill="#fff" />
            </G>
        </Svg>
    );
};

export default MeraLogo;


