import React, { useEffect } from 'react';
import Svg, { Circle, ClipPath, G, Path, Rect } from 'react-native-svg';
import Animated, {
    cancelAnimation,
    useSharedValue,
    useAnimatedProps,
    withRepeat,
    withTiming,
    withSequence,
    withDelay,
    Easing
} from 'react-native-reanimated';

import { useAnimationsActive } from '@/lib/hooks/use-is-focused-safe';

// Create animated version of G component for SVG transforms
const AnimatedG = Animated.createAnimatedComponent(G);
const AnimatedPath = Animated.createAnimatedComponent(Path);
const AnimatedRect = Animated.createAnimatedComponent(Rect);

const HEX_D = 'M512 170 L745 304 L745 720 L512 854 L279 720 L279 304 Z';
/** Perimeters for the draw-on dash, in viewBox units: four 233x134 slants
 *  (268.78 each) plus two 416 verticals; and the 150x110 card with rx 14
 *  (straight runs 122 + 82, twice, plus a full circle of radius 14). */
const HEX_PERIMETER = 4 * Math.hypot(233, 134) + 2 * 416;
const CARD_PERIMETER = 2 * (122 + 82) + 2 * Math.PI * 14;
/** One loop: draw on, hold the finished mark, restart. */
const DRAW_MS = 1200;
const HOLD_MS = 400;

// Spotlight cone geometry — shared by both the static and animated renders so
// the frozen frame and the animation start from the identical shape.
const SPOTLIGHT_D = 'M512 760 L450 485 L574 485 Z';

/** The frozen −15° frame. One definition, rendered by the static call path AND
 *  by `AnimatedSpotlight` whenever its gate is closed, so the two can never
 *  drift apart. */
const StaticSpotlight: React.FC<{ color: string }> = ({ color }) => (
    <G transform="rotate(-15 512 760)">
        <Path d={SPOTLIGHT_D} fill={color} opacity="0.300" />
    </G>
);

/**
 * Animated spotlight cone. Owns every reanimated hook (useSharedValue /
 * useEffect / useAnimatedProps) so the hooks stay unconditional — this
 * subcomponent is only mounted when `MeraLogo` is rendered with `animated`,
 * keeping the static path completely free of reanimated. Infinite left/right
 * sweep about the cone apex (512, 760).
 *
 * ## Why it is gated on focus + foreground
 *
 * This animates an SVG `<G transform>`, and RNSVG rasterises on the CPU — so
 * every frame RE-DRAWS the cone rather than compositing a cached layer (the
 * same trap documented at AbstractGradientBackdrop.tsx:336-342, which is why
 * the backdrop's own drift was removed). `AllCaughtUpCard` puts an animated
 * logo at the bottom of the Feed, and tabs stay mounted, so without this gate
 * it keeps re-rasterising on the CPU forever while the user reads Settings.
 *
 * When the gate closes the animated node UNMOUNTS in favour of the frozen
 * frame — cheaper than merely pausing it, and visually identical at rest.
 * `cancelAnimation` is required on that path: `withRepeat` runs on the UI
 * thread and would otherwise keep driving a shared value nothing reads.
 */
const AnimatedSpotlight: React.FC<{ color: string }> = ({ color }) => {
    const active = useAnimationsActive();
    // Use shared value for rotation angle (Reanimated)
    const rotation = useSharedValue(-15);

    useEffect(() => {
        if (!active) {
            cancelAnimation(rotation);
            rotation.value = -15;
            return;
        }
        // Create a looping animation that rotates left and right smoothly
        rotation.value = withRepeat(
            withSequence(
                withTiming(15, { duration: 2000, easing: Easing.inOut(Easing.ease) }),
                withTiming(-15, { duration: 2000, easing: Easing.inOut(Easing.ease) })
            ),
            -1, // infinite repeat
            false // don't reverse
        );
        return () => cancelAnimation(rotation);
    }, [rotation, active]);

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

    if (!active) return <StaticSpotlight color={color} />;

    return (
        <AnimatedG animatedProps={animatedProps}>
            <Path d={SPOTLIGHT_D} fill={color} opacity="0.300" />
        </AnimatedG>
    );
};

/**
 * The two main strokes (hexagon outline, highlighted card) drawing on in a
 * loop, by animating `strokeDashoffset` from the full perimeter to 0. Owns its
 * reanimated hooks, like `AnimatedSpotlight`, so every other render stays free
 * of them. Gated on `useAnimationsActive` for the same reason as the sweep:
 * RNSVG re-rasterises on the CPU every frame, so when nobody is looking the
 * finished strokes are drawn plain instead.
 */
const DrawnStrokes: React.FC<{ color: string; delayMs: number }> = ({ color, delayMs }) => {
    const active = useAnimationsActive();
    // Seeded FULL: switching drawing on must not blank the mark. Captured when
    // this started at 0: the outline vanished in one frame and redrew from
    // empty, which read as the mark being swapped rather than growing.
    const progress = useSharedValue(1);

    useEffect(() => {
        if (!active) {
            cancelAnimation(progress);
            progress.value = 1;
            return;
        }
        progress.value = 1;
        // Hold the finished mark for `delayMs` (the host's grow), then loop:
        // clear, draw on, hold.
        progress.value = withDelay(
            delayMs,
            withRepeat(
                withSequence(
                    withTiming(0, { duration: 0 }),
                    withTiming(1, { duration: DRAW_MS, easing: Easing.inOut(Easing.ease) }),
                    withTiming(1, { duration: HOLD_MS }),
                ),
                -1,
                false,
            ),
        );
        return () => cancelAnimation(progress);
    }, [progress, active, delayMs]);

    const hexProps = useAnimatedProps(() => ({ strokeDashoffset: HEX_PERIMETER * (1 - progress.value) }));
    const cardProps = useAnimatedProps(() => ({ strokeDashoffset: CARD_PERIMETER * (1 - progress.value) }));

    if (!active) {
        return (
            <>
                <Path d={HEX_D} fill="none" stroke={color} strokeWidth="24" strokeLinejoin="round" />
                <Rect x="490" y="465" width="150" height="110" rx="14" fill="none" stroke={color} strokeWidth="16" />
            </>
        );
    }
    return (
        <>
            <AnimatedPath
                d={HEX_D}
                fill="none"
                stroke={color}
                strokeWidth="24"
                strokeLinejoin="round"
                strokeDasharray={[HEX_PERIMETER, HEX_PERIMETER]}
                animatedProps={hexProps}
            />
            <AnimatedRect
                x="490"
                y="465"
                width="150"
                height="110"
                rx="14"
                fill="none"
                stroke={color}
                strokeWidth="16"
                strokeDasharray={[CARD_PERIMETER, CARD_PERIMETER]}
                animatedProps={cardProps}
            />
        </>
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
    /**
     * Ink colour for every stroke/fill in the glyph. Defaults to white, which is
     * what every chrome call site wants against the dark theme. Overridden only
     * where the glyph sits on a LIGHT ground — currently the article image
     * placeholder, which is a near-white panel.
     */
    color?: string;
    /**
     * Draw the hexagon outline and the highlighted card on in a loop (the
     * Feed's status mark while a sync runs). Default false, and with it off
     * the render is byte-identical to before the prop existed (snapshot in
     * MeraLogo.test.tsx). The spotlight holds its frozen frame while drawing.
     */
    drawStrokes?: boolean;
    /** With `drawStrokes`: hold the finished mark this long before the first
     *  draw, so a host growing the mark finishes growing first. Default 0. */
    drawDelayMs?: number;
}

// Mera Logo Component. Static by default; opt into the animated spotlight.
// The viewBox is tightened to the glyph bounds (hexagon x 279–745 / y 170–854
// plus the 24-unit stroke outset) so a given `size` renders at a visual height
// consistent with neighboring lucide icons instead of leaving ~33% padding.
const MeraLogo: React.FC<MeraLogoProps> = ({
    size = 80,
    animated = false,
    color = '#fff',
    drawStrokes = false,
    drawDelayMs = 0,
}) => {
    return (
        <Svg width={size} height={size} viewBox="255 146 514 732">
            {/* Hexagon outline (drawn by DrawnStrokes when drawing on) */}
            {drawStrokes ? null : (
                <Path d="M512 170 L745 304 L745 720 L512 854 L279 720 L279 304 Z" fill="none" stroke={color} strokeWidth="24" strokeLinejoin="round" />
            )}
            <ClipPath id="hexB">
                <Path d="M512 170 L745 304 L745 720 L512 854 L279 720 L279 304 Z" />
            </ClipPath>
            <G clipPath="url(#hexB)">
                {/* Grid cards */}
                <G fill="none" stroke={color} strokeOpacity="0.18" strokeWidth="10">
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
                {animated && !drawStrokes ? (
                    <AnimatedSpotlight color={color} />
                ) : (
                    <StaticSpotlight color={color} />
                )}
                {/* Highlighted card (drawn by DrawnStrokes when drawing on) */}
                {drawStrokes ? null : (
                    <Rect x="490" y="465" width="150" height="110" rx="14" fill="none" stroke={color} strokeWidth="16" />
                )}
                {/* Focus dot */}
                <Circle cx="512" cy="748" r="16" fill={color} />
            </G>
            {/* Same two strokes, drawing on. The card sits wholly inside the
                hexagon, so the clip it no longer shares changes nothing. */}
            {drawStrokes ? <DrawnStrokes color={color} delayMs={drawDelayMs} /> : null}
        </Svg>
    );
};

export default MeraLogo;
