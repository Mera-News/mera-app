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

// Spotlight cone geometry — shared by both the static and animated renders so
// the frozen frame and the animation start from the identical shape.
const SPOTLIGHT_D = 'M512 760 L450 485 L574 485 Z';

/**
 * Animated spotlight cone. Owns every reanimated hook (useSharedValue /
 * useEffect / useAnimatedProps) so the hooks stay unconditional — this
 * subcomponent is only mounted when `MeraLogo` is rendered with `animated`,
 * keeping the static path completely free of reanimated. Infinite left/right
 * sweep about the cone apex (512, 760).
 */
const AnimatedSpotlight: React.FC = () => {
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
        <AnimatedG animatedProps={animatedProps}>
            <Path d={SPOTLIGHT_D} fill="#fff" opacity="0.300" />
        </AnimatedG>
    );
};

interface MeraLogoProps {
    size?: number;
    /**
     * When true, the spotlight cone sweeps left/right on an infinite loop.
     * Default false — a frozen frame of the same glyph with zero reanimated
     * involvement (used by every action-row / sheet / branding call site; only
     * the floating bubble and loading states pass `animated`).
     */
    animated?: boolean;
}

// Mera Logo Component. Static by default; opt into the animated spotlight.
// The viewBox is tightened to the glyph bounds (hexagon x 279–745 / y 170–854
// plus the 24-unit stroke outset) so a given `size` renders at a visual height
// consistent with neighboring lucide icons instead of leaving ~33% padding.
const MeraLogo: React.FC<MeraLogoProps> = ({ size = 80, animated = false }) => {
    return (
        <Svg width={size} height={size} viewBox="255 146 514 732">
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
                {/* Spotlight cone — animated sweep or a frozen −15° frame. */}
                {animated ? (
                    <AnimatedSpotlight />
                ) : (
                    <G transform="rotate(-15 512 760)">
                        <Path d={SPOTLIGHT_D} fill="#fff" opacity="0.300" />
                    </G>
                )}
                {/* Highlighted card */}
                <Rect x="490" y="465" width="150" height="110" rx="14" fill="none" stroke="#fff" strokeWidth="16" />
                {/* Focus dot */}
                <Circle cx="512" cy="748" r="16" fill="#fff" />
            </G>
        </Svg>
    );
};

export default MeraLogo;
