import { MENU_PANEL_BORDER, MENU_PANEL_FILL, TOAST_RADIUS, ToastFrontProvider } from '@/components/ui/toast';
import {
    close as closeToast,
    useToastQueue,
    type ToastEntry,
    type ToastPlacement,
} from '@/lib/toast/toast-queue';
import React, { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, View, useWindowDimensions } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
    runOnJS,
    useAnimatedStyle,
    useSharedValue,
    withSpring,
    withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

/**
 * THE TOAST DECK — the single host for every in-app notification.
 *
 * It replaces gluestack's `ToastList`, which laid toasts out as a plain flex
 * column: a second toast rendered BELOW the first, a third below that, 4pt
 * apart, with no cap. Two confirmations on the Profile screen covered the page
 * title, the usage counter and the Manage button. Each card also armed its own
 * `setTimeout` at enqueue time, so a burst did not drain one at a time — it
 * piled up and then cleared together.
 *
 * Here the cards are a DECK: the front card is fully readable, the waiting ones
 * peek out behind it, scaled down and dimmed. The footprint is one card height
 * plus ~20pt of peek no matter how many are queued.
 *
 * Order is FIFO (owner call): the OLDEST card holds the front slot, later
 * arrivals wait behind it in arrival order and promote forward as each leaves.
 * `lib/toast/toast-queue.ts` owns the ordering, the timers and the persistent
 * lane; this file owns nothing but paint and gesture.
 */

/** Cards painted at once. The rest stay queued and render nothing — at depth 3
 *  a card is fully occluded by the two in front of it. */
const VISIBLE_DEPTH = 3;

/**
 * Per-depth offset toward the middle of the screen, in points. Signed by
 * placement: a `top` deck peeks DOWNWARD, a `bottom` deck peeks upward.
 *
 * Bigger than the visible peek, because the scale below eats half of it: a
 * card scaled about its own centre pulls its bottom edge UP by
 * `height * (1 - scale) / 2`, which on a 140pt card is ~4pt at depth 1. At an
 * offset of 10 the sliver measured ~6pt on device and read as a rendering
 * artefact rather than a card. These land it at ~14pt per step.
 */
const DEPTH_Y = [0, 18, 34];
const DEPTH_SCALE = [1, 0.94, 0.88];
const DEPTH_OPACITY = [1, 0.55, 0.3];

/** The pre-existing enter feel, kept deliberately: fade in over 150ms from 24pt
 *  outside the final position. */
const ENTER_MS = 150;
const ENTER_OFFSET = 24;
const PROMOTE_MS = 220;
const EXIT_MS = 150;
const SWIPE_OUT_MS = 180;

/** Past either of these, the swipe dismisses instead of springing back. */
const SWIPE_DISTANCE = 40;
const SWIPE_VELOCITY = 600;

/**
 * Ids already flown off screen by a swipe.
 *
 * Without this the exit clone below would mount a fresh copy at rest position
 * and fade it in place, immediately after the card the user just flicked away —
 * the card would appear to come back. Consumed (and deleted) by the column that
 * notices the id leave the queue.
 */
const swipeDismissed = new Set<string>();

function markSwipeDismissed(id: string): void {
    swipeDismissed.add(id);
}

/** OS reduce-motion, read imperatively and kept fresh by subscription. Note
 *  this is the accessibility setting, NOT the app's `useAnimationsActive`
 *  preference, which is a different flag with a different meaning. */
function useReduceMotion(): boolean {
    const [reduceMotion, setReduceMotion] = useState(false);
    useEffect(() => {
        let cancelled = false;
        AccessibilityInfo.isReduceMotionEnabled()
            .then((enabled) => {
                if (!cancelled) setReduceMotion(enabled);
            })
            .catch(() => {
                /* default: motion enabled */
            });
        const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduceMotion);
        return () => {
            cancelled = true;
            sub.remove();
        };
    }, []);
    return reduceMotion;
}

interface SlotProps {
    entry: ToastEntry;
    placement: ToastPlacement;
    /** 0 is the front card. */
    depth: number;
    reduceMotion: boolean;
    /** The front card's measured box, which every buried card is drawn as. */
    frontSize?: { width: number; height: number };
    onFrontSize: (size: { width: number; height: number }) => void;
    /** True while the card is being unmounted; it plays its exit and nothing else. */
    leaving?: boolean;
}

function ToastSlot({
    entry,
    placement,
    depth,
    reduceMotion,
    frontSize,
    onFrontSize,
    leaving = false,
}: SlotProps) {
    const isFront = depth === 0 && !leaving;
    // Read here, NOT inside the gesture callback. `onEnd` is a worklet running
    // on the UI thread, where `Dimensions.get` is undefined — calling it there
    // threw "Dimensions.get is not a function" on the first real swipe, which
    // no test could see. A plain number closes over fine.
    const { height: screenHeight } = useWindowDimensions();
    // `top` decks stack downward, `bottom` decks upward. Every offset in this
    // component is expressed as a positive magnitude times this sign.
    const dir = placement === 'top' ? 1 : -1;

    const translateY = useSharedValue(0);
    const scale = useSharedValue(1);
    const opacity = useSharedValue(0);
    const dragY = useSharedValue(0);
    const mounted = useRef(false);

    useEffect(() => {
        const clamped = Math.min(depth, DEPTH_Y.length - 1);
        const targetY = DEPTH_Y[clamped] * dir;
        const targetScale = DEPTH_SCALE[clamped];
        const targetOpacity = DEPTH_OPACITY[clamped];
        const motionMs = reduceMotion ? 0 : PROMOTE_MS;

        if (!mounted.current) {
            mounted.current = true;
            scale.value = targetScale;
            if (depth === 0) {
                // Into an empty deck: the original enter, sliding in from
                // outside the safe area.
                translateY.value = reduceMotion ? targetY : targetY - ENTER_OFFSET * dir;
                translateY.value = withTiming(targetY, { duration: reduceMotion ? 0 : ENTER_MS });
            } else {
                // Arriving BEHIND a card that is already showing — the common
                // case under FIFO. No travel: a 24pt slide on a sliver nobody
                // can read registers as a glitch, not as motion.
                translateY.value = targetY;
            }
            opacity.value = 0;
            opacity.value = withTiming(targetOpacity, { duration: ENTER_MS });
            return;
        }

        translateY.value = withTiming(targetY, { duration: motionMs });
        scale.value = withTiming(targetScale, { duration: motionMs });
        opacity.value = withTiming(targetOpacity, { duration: motionMs });
    }, [depth, dir, reduceMotion, opacity, scale, translateY]);

    // The exit: fade back out the way the card came in.
    useEffect(() => {
        if (!leaving) return;
        opacity.value = withTiming(0, { duration: EXIT_MS });
        if (depth === 0 && !reduceMotion) {
            translateY.value = withTiming(-ENTER_OFFSET * dir, { duration: EXIT_MS });
        }
    }, [leaving, depth, dir, reduceMotion, opacity, translateY]);

    const pan = Gesture.Pan()
        .enabled(isFront)
        // 10pt before the pan claims the gesture. This threshold is the ONLY
        // reason `showUndoToast`'s Undo button still works: a tap never travels
        // far enough to activate, so it reaches the Pressable inside the card.
        .activeOffsetY([-10, 10])
        // Leave horizontal gestures (navigation's edge swipe) alone.
        .failOffsetX([-20, 20])
        .onUpdate((event) => {
            const towards = dir === 1 ? Math.min(event.translationY, 0) : Math.max(event.translationY, 0);
            const against = event.translationY - towards;
            // Rubber-band the wrong way rather than refusing to move, so the
            // card never feels stuck.
            dragY.value = towards + against * 0.2;
        })
        .onEnd((event) => {
            const away = -dir;
            const travelled = event.translationY * away;
            const flicked = event.velocityY * away;
            if (travelled > SWIPE_DISTANCE || flicked > SWIPE_VELOCITY) {
                runOnJS(markSwipeDismissed)(entry.id);
                dragY.value = withTiming(away * screenHeight, { duration: SWIPE_OUT_MS });
                opacity.value = withTiming(0, { duration: SWIPE_OUT_MS }, (finished) => {
                    if (finished) runOnJS(closeToast)(entry.id);
                });
                return;
            }
            dragY.value = withSpring(0);
        });

    const animatedStyle = useAnimatedStyle(() => ({
        opacity: opacity.value,
        transform: [{ translateY: translateY.value + dragY.value }, { scale: scale.value }],
    }));

    return (
        <Animated.View
            // FULL WIDTH and absolutely positioned, with the card as an
            // intrinsic-width child. This reproduces exactly what gluestack's
            // `POSITIONS.top` + `alignItems: 'center'` did, and it is
            // load-bearing: `Toast` sizes itself with `flexShrink: 1` (never
            // `flex: 1`) under a 60%-of-screen `maxWidth`, so anything that
            // measures it at zero collapses every toast to an icon-only sliver.
            // An absolutely positioned child is NOT centered by a parent's
            // `alignItems`, so the transform has to live out here.
            style={[
                {
                    position: 'absolute',
                    left: 0,
                    right: 0,
                    [placement === 'top' ? 'top' : 'bottom']: 0,
                    alignItems: 'center',
                },
                animatedStyle,
            ]}
            // Box-none so the full-width slot never swallows a tap aimed at the
            // screen beside the card.
            pointerEvents="box-none"
        >
            <GestureDetector gesture={pan}>
                <View
                    pointerEvents={isFront ? 'auto' : 'none'}
                    onLayout={
                        isFront
                            ? (event) =>
                                  onFrontSize({
                                      width: event.nativeEvent.layout.width,
                                      height: event.nativeEvent.layout.height,
                                  })
                            : undefined
                    }
                >
                    {/* A BURIED CARD IS DRAWN AS A BARE PANEL, not as its own
                        content. Rendering the real thing looked right in a
                        snapshot and wrong on device: the cards behind are the
                        SAME height as the front one, so the clamp had nothing
                        to cut and the peek showed the bottom half-line of their
                        text ("updated.") reading out from under the front card.
                        A plain surface is also what makes the deck cheap, and
                        it means `NotifiedToast` never mounts — and so never
                        flies to the bell — until it is the card being read. */}
                    {isFront ? (
                        <ToastFrontProvider value>{entry.render({ id: entry.id })}</ToastFrontProvider>
                    ) : frontSize ? (
                        <View
                            testID="toast-buried-panel"
                            style={{
                                // The 4pt is `Toast`'s own `m-1`, which the
                                // measured box includes.
                                margin: 4,
                                width: Math.max(0, frontSize.width - 8),
                                height: Math.max(0, frontSize.height - 8),
                                borderRadius: TOAST_RADIUS,
                                backgroundColor: MENU_PANEL_FILL,
                                borderWidth: 1,
                                borderColor: MENU_PANEL_BORDER,
                            }}
                        />
                    ) : null}
                </View>
            </GestureDetector>
        </Animated.View>
    );
}

function DeckColumn({ placement, entries }: { placement: ToastPlacement; entries: ToastEntry[] }) {
    const insets = useSafeAreaInsets();
    const reduceMotion = useReduceMotion();
    const [frontSize, setFrontSize] = useState<{ width: number; height: number } | undefined>(
        undefined,
    );
    const [leaving, setLeaving] = useState<{ entry: ToastEntry; depth: number }[]>([]);
    const previous = useRef<ToastEntry[]>([]);

    useEffect(() => {
        const gone = previous.current
            .map((entry, depth) => ({ entry, depth }))
            .filter(({ entry }) => !entries.some((current) => current.id === entry.id));
        previous.current = entries;
        if (gone.length === 0) return;

        // A card the user flicked away is already off screen; replaying an exit
        // for it would look like it came back.
        const fading = gone.filter(({ entry }) => {
            if (swipeDismissed.has(entry.id)) {
                swipeDismissed.delete(entry.id);
                return false;
            }
            return true;
        });
        if (fading.length === 0) return;

        setLeaving((current) => [...current, ...fading]);
        setTimeout(() => {
            setLeaving((current) =>
                current.filter(({ entry }) => !fading.some((f) => f.entry.id === entry.id)),
            );
        }, EXIT_MS);
    }, [entries]);

    if (entries.length === 0 && leaving.length === 0) return null;

    // DEEPEST FIRST, front last. The queue array runs front -> back under FIFO
    // and later siblings paint on top, so mapping the array straight into JSX
    // would paint the newest arrival over the card the user is reading.
    const deck = entries
        .slice(0, VISIBLE_DEPTH)
        .map((entry, depth) => (
            <ToastSlot
                key={entry.id}
                entry={entry}
                placement={placement}
                depth={depth}
                reduceMotion={reduceMotion}
                frontSize={frontSize}
                onFrontSize={setFrontSize}
            />
        ))
        .reverse();

    return (
        <View
            style={{
                position: 'absolute',
                left: 0,
                right: 0,
                ...(placement === 'top' ? { top: insets.top } : { bottom: insets.bottom }),
            }}
            pointerEvents="box-none"
        >
            {deck}
            {/* Painted above the deck: a card leaving the front slot has to
                cover the one promoting up behind it. */}
            {leaving.map(({ entry, depth }) => (
                <ToastSlot
                    key={`leaving-${entry.id}`}
                    entry={entry}
                    placement={placement}
                    depth={depth}
                    reduceMotion={reduceMotion}
                    frontSize={frontSize}
                    onFrontSize={setFrontSize}
                    leaving
                />
            ))}
        </View>
    );
}

/**
 * Mounted once, at the root, as the LAST child so it paints above the router
 * stack, the tab bar and the floating chat bubble.
 */
export default function ToastDeck() {
    const top = useToastQueue((state) => state.top);
    const bottom = useToastQueue((state) => state.bottom);
    return (
        <>
            <DeckColumn placement="top" entries={top} />
            <DeckColumn placement="bottom" entries={bottom} />
        </>
    );
}
