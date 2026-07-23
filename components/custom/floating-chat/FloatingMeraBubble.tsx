import MeraLogo from '@/components/custom/MeraLogo';
import { Text } from '@/components/ui/text';
import { hapticLight } from '@/lib/haptics';
import {
    useFloatingChatIsGenerating,
    useFloatingChatStore,
    type ChatContext,
} from '@/lib/stores/floating-chat-store';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, useWindowDimensions, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
    Easing,
    runOnJS,
    type SharedValue,
    useAnimatedStyle,
    useSharedValue,
    withDelay,
    withRepeat,
    withSequence,
    withSpring,
    withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Circle, Defs, RadialGradient, Stop } from 'react-native-svg';

// ── Geometry ────────────────────────────────────────────────────────────────
const BUBBLE_SIZE = 64;
const EDGE_MARGIN = 12;
const TOP_CLAMP_OFFSET = 60; // below insets.top
const BOTTOM_CLAMP_OFFSET = 120; // above insets.bottom

const PRIMARY = 'rgb(231, 138, 83)';

// ── Pulse (ported from MeraAIBubble PulseLayer) ──────────────────────────────
const PULSE_SIZE = BUBBLE_SIZE * 1.6;
// ~1.4s loop, three rings staggered by a third — reads as an active "thinking"
// pulse rather than a slow ambient breathe.
const PULSE_DURATION = 1400;
const STAGGER = PULSE_DURATION / 3;

// Snap spring shared by both axes on drag-release.
const SNAP_SPRING = { damping: 16, stiffness: 180 };

// One-time speech hint per app session (module-level flag is intentional).
let hintShownThisSession = false;

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

const PulseLayer: React.FC<{
    scale: SharedValue<number>;
    opacity: SharedValue<number>;
    id: string;
}> = ({ scale, opacity, id }) => {
    const animStyle = useAnimatedStyle(() => ({
        transform: [{ scale: scale.value }],
        opacity: opacity.value,
    }));
    return (
        // pointerEvents none: the glow halo extends past the bubble but must
        // never intercept touches or enlarge the drag hit area.
        <Animated.View style={[styles.pulseCircle, animStyle]} pointerEvents="none">
            <PulseGradientCircle id={id} />
        </Animated.View>
    );
};

// Always-on ambient glow: a slow radial breathe so the collapsed bubble is
// never flat at rest (ported from the old MeraAIBubble's always-on pulse). The
// stronger expanding rings below layer on top only while generating.
const AMBIENT_DURATION = 2000;

function useAmbientGlow() {
    const scale = useSharedValue(0.85);
    const opacity = useSharedValue(0.3);

    useEffect(() => {
        scale.value = withRepeat(
            withTiming(1.05, { duration: AMBIENT_DURATION, easing: Easing.inOut(Easing.ease) }),
            -1,
            true,
        );
        opacity.value = withRepeat(
            withTiming(0.55, { duration: AMBIENT_DURATION, easing: Easing.inOut(Easing.ease) }),
            -1,
            true,
        );
    }, [scale, opacity]);

    return { scale, opacity };
}

function usePulseAnimation(delay: number, active: boolean) {
    const scale = useSharedValue(0.5);
    const opacity = useSharedValue(0);

    useEffect(() => {
        if (!active) {
            scale.value = 0.5;
            opacity.value = 0;
            return;
        }
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
    }, [delay, active, scale, opacity]);

    return { scale, opacity };
}

interface FloatingMeraBubbleProps {
    /** Default chat context to open with, derived from the current route. */
    readonly context: ChatContext;
    /**
     * Extra clearance to reserve below the bubble's drag range, on top of
     * `insets.bottom` — for a bottom tab bar that sits outside this
     * component's own layout tree (see lib/navigation/tab-bar.ts). 0 for
     * screens with no tab bar (the previous, unchanged behavior).
     */
    readonly extraBottomInset?: number;
}

/**
 * Messenger-style draggable chat-head. Drags on a pan gesture, snaps to the
 * nearest horizontal edge on release, taps to expand the chat. All motion runs
 * on the UI thread via Reanimated worklets.
 */
const FloatingMeraBubble: React.FC<FloatingMeraBubbleProps> = ({ context, extraBottomInset = 0 }) => {
    const { t } = useTranslation();
    const insets = useSafeAreaInsets();
    const { width: windowWidth, height: windowHeight } = useWindowDimensions();
    const isGenerating = useFloatingChatIsGenerating();

    // Snap targets (top-left referenced) derived from screen geometry.
    const leftX = EDGE_MARGIN;
    const rightX = windowWidth - EDGE_MARGIN - BUBBLE_SIZE;
    const minY = insets.top + TOP_CLAMP_OFFSET;
    const maxY = windowHeight - insets.bottom - extraBottomInset - BOTTOM_CLAMP_OFFSET;

    // Default position: horizontally centered, 10% up from the bottom. This is
    // where the bubble first appears; dragging it afterwards snaps to an edge.
    const initial = useMemo(() => {
        const x = (windowWidth - BUBBLE_SIZE) / 2;
        const y = Math.min(Math.max(windowHeight * 0.9 - BUBBLE_SIZE / 2, minY), maxY);
        return { side: 'right' as const, x, y };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // React-state side is only for hint layout (which edge the label hugs).
    const [side, setSide] = useState<'left' | 'right'>(initial.side);
    const [showHint, setShowHint] = useState(!hintShownThisSession);

    const translateX = useSharedValue(initial.x);
    const translateY = useSharedValue(initial.y);
    const startX = useSharedValue(0);
    const startY = useSharedValue(0);
    const mountScale = useSharedValue(0.8);
    // Slight squeeze while actively dragging, springs back to 1 on release.
    const dragScale = useSharedValue(1);
    const hintOpacity = useSharedValue(showHint ? 1 : 0);

    // Publish the bubble's absolute center so the popover can morph from it.
    const publishCenter = useCallback((x: number, y: number) => {
        useFloatingChatStore.getState().setBubbleCenter({
            x: x + BUBBLE_SIZE / 2,
            y: y + BUBBLE_SIZE / 2,
        });
    }, []);

    const persistPosition = useCallback(
        (nextSide: 'left' | 'right', x: number, y: number) => {
            setSide(nextSide);
            useFloatingChatStore.getState().setBubblePosition(nextSide, y);
            publishCenter(x, y);
        },
        [publishCenter],
    );

    const handleTap = useCallback(() => {
        void hapticLight();
        useFloatingChatStore.getState().expand(context);
    }, [context]);

    // Entrance + initial center publish.
    useEffect(() => {
        mountScale.value = withSpring(1, { damping: 12, stiffness: 160 });
        publishCenter(initial.x, initial.y);
    }, [mountScale, publishCenter, initial.x, initial.y]);

    // One-time hint: fade out after a few seconds, then mark session-shown.
    useEffect(() => {
        if (!showHint) return;
        hintShownThisSession = true;
        hintOpacity.value = withDelay(4000, withTiming(0, { duration: 500 }));
        const timer = setTimeout(() => setShowHint(false), 4800);
        return () => clearTimeout(timer);
    }, [showHint, hintOpacity]);

    const ambientGlow = useAmbientGlow();
    const pulse0 = usePulseAnimation(0, isGenerating);
    const pulse1 = usePulseAnimation(STAGGER, isGenerating);
    const pulse2 = usePulseAnimation(STAGGER * 2, isGenerating);

    const gesture = useMemo(() => {
        const pan = Gesture.Pan()
            // onStart fires only once the pan activates (past the slop), so a
            // stationary press never triggers the squeeze — it falls to the tap.
            .onStart(() => {
                startX.value = translateX.value;
                startY.value = translateY.value;
                dragScale.value = withTiming(0.92, { duration: 120 });
            })
            .onUpdate((e) => {
                translateX.value = startX.value + e.translationX;
                translateY.value = startY.value + e.translationY;
            })
            .onEnd(() => {
                const movedX = translateX.value - startX.value;
                const movedY = translateY.value - startY.value;
                const didDrag = movedX * movedX + movedY * movedY > 100; // > ~10px
                const centerX = translateX.value + BUBBLE_SIZE / 2;
                const nextSide: 'left' | 'right' = centerX < windowWidth / 2 ? 'left' : 'right';
                const targetX = nextSide === 'left' ? leftX : rightX;
                const targetY = Math.min(Math.max(translateY.value, minY), maxY);
                dragScale.value = withSpring(1, { damping: 14, stiffness: 200 });
                // Haptic fires from the snap spring's completion callback so it
                // lands when the bubble settles against the edge, not on release.
                translateX.value = withSpring(targetX, SNAP_SPRING, (finished) => {
                    if (finished && didDrag) runOnJS(hapticLight)();
                });
                translateY.value = withSpring(targetY, SNAP_SPRING);
                runOnJS(persistPosition)(nextSide, targetX, targetY);
            });

        const tap = Gesture.Tap()
            .maxDistance(10)
            .onEnd(() => {
                runOnJS(handleTap)();
            });

        // Pan takes priority; a stationary press falls through to tap.
        return Gesture.Exclusive(pan, tap);
    }, [
        startX,
        startY,
        translateX,
        translateY,
        dragScale,
        windowWidth,
        leftX,
        rightX,
        minY,
        maxY,
        persistPosition,
        handleTap,
    ]);

    const containerStyle = useAnimatedStyle(() => ({
        transform: [
            { translateX: translateX.value },
            { translateY: translateY.value },
            { scale: mountScale.value * dragScale.value },
        ],
    }));

    const hintStyle = useAnimatedStyle(() => ({ opacity: hintOpacity.value }));

    return (
        <GestureDetector gesture={gesture}>
            <Animated.View style={[styles.container, containerStyle]}>
                {/* Always-on subtle glow at rest. */}
                <PulseLayer scale={ambientGlow.scale} opacity={ambientGlow.opacity} id="fcb-glow" />
                {/* Stronger expanding rings layer on top while generating. */}
                {isGenerating && (
                    <>
                        <PulseLayer scale={pulse0.scale} opacity={pulse0.opacity} id="fcb0" />
                        <PulseLayer scale={pulse1.scale} opacity={pulse1.opacity} id="fcb1" />
                        <PulseLayer scale={pulse2.scale} opacity={pulse2.opacity} id="fcb2" />
                    </>
                )}
                <View style={styles.bubble}>
                    <MeraLogo size={56} animated />
                </View>
                {showHint && (
                    <Animated.View
                        style={[
                            styles.hint,
                            side === 'left' ? styles.hintRightOfBubble : styles.hintLeftOfBubble,
                            hintStyle,
                        ]}
                        pointerEvents="none"
                    >
                        <Text size="xs" style={styles.hintText} numberOfLines={1}>
                            {t('floatingChat.bubbleHint')}
                        </Text>
                    </Animated.View>
                )}
            </Animated.View>
        </GestureDetector>
    );
};

const styles = StyleSheet.create({
    container: {
        position: 'absolute',
        top: 0,
        left: 0,
        width: BUBBLE_SIZE,
        height: BUBBLE_SIZE,
        alignItems: 'center',
        justifyContent: 'center',
    },
    bubble: {
        // No filled circle / shadow — just the logo over the pulse glow. Keeps
        // the fixed size + centering so the logo stays put and the pulse rings
        // (which position against BUBBLE_SIZE) remain aligned.
        width: BUBBLE_SIZE,
        height: BUBBLE_SIZE,
        alignItems: 'center',
        justifyContent: 'center',
    },
    pulseCircle: {
        position: 'absolute',
        width: PULSE_SIZE,
        height: PULSE_SIZE,
        left: (BUBBLE_SIZE - PULSE_SIZE) / 2,
        top: (BUBBLE_SIZE - PULSE_SIZE) / 2,
    },
    hint: {
        position: 'absolute',
        top: BUBBLE_SIZE / 2 - 16,
        backgroundColor: '#000000',
        borderWidth: 1,
        borderColor: PRIMARY,
        paddingHorizontal: 12,
        paddingVertical: 7,
        borderRadius: 12,
    },
    hintLeftOfBubble: {
        right: BUBBLE_SIZE + 10,
    },
    hintRightOfBubble: {
        left: BUBBLE_SIZE + 10,
    },
    hintText: {
        color: '#FFFFFF',
        fontSize: 12,
    },
});

export default FloatingMeraBubble;
