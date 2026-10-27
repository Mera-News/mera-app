import { ToastFrontProvider } from '@/components/ui/toast';
import { SPRING } from '@/lib/motion';
import { useColors } from '@/lib/theme/tokens';
import { close as closeToast, rearm, useToastQueue, type ToastEntry } from '@/lib/toast/toast-queue';
import React, { useEffect, useRef, useState } from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import Animated, {
    runOnJS,
    useAnimatedStyle,
    useSharedValue,
    withSpring,
    withTiming,
} from 'react-native-reanimated';
import { EASE_LEAVE, EASE_SETTLE, REDUCED_FADE, TOAST_MOTION, dragOffset, swipeDismisses } from './deck-motion';
import { useMotionAllowed } from '@/lib/motion-gate';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { FullWindowOverlay } from 'react-native-screens';

/**
 * THE TOAST DECK — the single host for every in-app notification, and the
 * app's ONLY toast mechanism. It is one stack at the TOP of the screen. There
 * is no bottom deck: every `show()` joins this stack behind the card already
 * showing, whatever placement the caller names.
 *
 * It replaces gluestack's `ToastList`, which laid toasts out as a plain flex
 * column: a second toast rendered BELOW the first, a third below that, 4pt
 * apart, with no cap. Two confirmations on the Profile screen covered the page
 * title, the usage counter and the Manage button. Each card also armed its own
 * `setTimeout` at enqueue time, so a burst did not drain one at a time — it
 * piled up and then cleared together.
 *
 * Here the cards are a DECK: the front card is fully readable, the waiting ones
 * peek out below it as narrower, darker strips. The footprint is one card height
 * plus at most 18pt of strips, no matter how many are queued. Motion follows
 * the Motion board (`deck-motion.ts`); Lite and Reduce Motion fade only.
 *
 * Order is FIFO (owner call): the OLDEST card holds the front slot, later
 * arrivals wait behind it in arrival order and promote forward as each leaves.
 * `lib/toast/toast-queue.ts` owns the ordering, the timers and the persistent
 * lane; this file owns nothing but paint and gesture.
 */

/** Cards painted at once. The rest stay queued and render nothing. */
const VISIBLE_DEPTH = 3;

/**
 * How much of each card behind the front one shows, in points, by depth (Motion
 * board: the first strip hangs 10pt below the card, the second 8pt below that).
 * A buried card is drawn as ONLY this strip, hanging below the card in front
 * of it; nothing of it lies over the front card's box.
 *
 * That is load-bearing, not tidiness. A buried card used to be a full-size,
 * 55%-opaque panel sitting mostly UNDER the front card, and on device it
 * painted OVER it despite rendering first and carrying a lower zIndex: the
 * front's text measured 244 -> 160 brightness the moment a second toast queued.
 * Geometry that cannot overlap does not depend on paint order at all.
 */
const PEEK_PT = [0, 10, 8];
/** Where depth d's strip starts below the front card's bottom edge. */
const STRIP_TOP = [0, 0, PEEK_PT[1]];
/** Each strip is inset this much a side from the front card: it reads as a deck. */
const STRIP_INSET = [0, 14, 28];
/** The strip's own body: 28 tall with a 16 bottom radius, of which only the
 *  bottom `PEEK_PT[d]` shows (an outer clip), so the curve is the board's. */
const STRIP_BODY = 28;
const STRIP_RADIUS = 16;
/** Opaque strips, each a step darker than the card (the board's #1B1A1E and
 *  #18171A under a #1F1E22 card), so content never shows through them. */
const STRIP_SHADE = [0, 0.13, 0.23];

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

interface SlotProps {
    entry: ToastEntry;
    /** 0 is the front card. */
    depth: number;
    reduced: boolean;
    /** The front card's measured box, which every buried card hangs below. */
    frontSize?: { width: number; height: number };
    onFrontSize: (size: { width: number; height: number }) => void;
    /** True while the card is being unmounted; it plays its exit and nothing else. */
    leaving?: boolean;
}

function ToastSlot({ entry, depth, reduced, frontSize, onFrontSize, leaving = false }: SlotProps) {
    // TWO DIFFERENT QUESTIONS, and collapsing them into one flag painted a grey
    // placeholder over every dismissal: a card on its way out still sits in the
    // top slot and must still render ITSELF while it leaves, but it is no longer
    // the card being read.
    const isTop = depth === 0;
    const isFront = isTop && !leaving;
    // Also re-renders the cards on a theme change, so `entry.render` repaints.
    const c = useColors();
    const translateY = useSharedValue(0);
    const scale = useSharedValue(1);
    const opacity = useSharedValue(0);
    const dragY = useSharedValue(0);
    // What the swipe worklets read. Never render values: RNGH applies a rebuilt
    // gesture's callbacks asynchronously, so a closed-over number can be stale.
    const heightSV = useSharedValue(frontSize?.height ?? 0);
    const reducedSV = useSharedValue(reduced);
    const prevDepth = useRef<number | undefined>(undefined);
    // A card arriving into an empty deck slides by its own height, known only
    // once it lays out, so the arrive starts from the first layout.
    const arrivePending = useRef(false);

    useEffect(() => {
        reducedSV.value = reduced;
    }, [reduced, reducedSV]);

    const arrive = (height: number) => {
        if (reduced) {
            opacity.value = withTiming(1, REDUCED_FADE);
            return;
        }
        const settle = { duration: TOAST_MOTION.arrive.ms, easing: EASE_SETTLE };
        translateY.value = TOAST_MOTION.arrive.fromHeightShare * height;
        scale.value = TOAST_MOTION.arrive.fromScale;
        translateY.value = withTiming(0, settle);
        scale.value = withTiming(1, settle);
        opacity.value = withTiming(1, settle);
    };

    useEffect(() => {
        const prev = prevDepth.current;
        prevDepth.current = depth;
        if (prev === depth) return;

        if (leaving) {
            // An exit clone is a fresh mount of a card the user was already
            // looking at: it starts where that card was and only leaves.
            opacity.value = 1;
            if (reduced) {
                opacity.value = withTiming(0, REDUCED_FADE);
                return;
            }
            const leave = { duration: TOAST_MOTION.leave.ms, easing: EASE_LEAVE };
            if (depth === 0) {
                translateY.value = withTiming(TOAST_MOTION.leave.toHeightShare * (frontSize?.height ?? 0), leave);
            }
            opacity.value = withTiming(0, leave);
            return;
        }

        if (prev === undefined && depth === 0) {
            arrivePending.current = true;
            return;
        }

        if (prev === undefined || prev === 0) {
            // A strip fading in as its card queues.
            if (reduced) {
                opacity.value = withTiming(1, REDUCED_FADE);
                return;
            }
            const settle = { duration: TOAST_MOTION.strip.ms, easing: EASE_SETTLE };
            translateY.value = TOAST_MOTION.strip.fromY;
            translateY.value = withTiming(0, settle);
            opacity.value = withTiming(1, settle);
            return;
        }

        if (depth === 0) {
            // Rising out of its strip. The deck held it back through the leave
            // in front of it, so its own full time starts now (owner rule).
            if (entry.duration !== null) rearm(entry.id, entry.duration);
            if (reduced) {
                opacity.value = 0;
                opacity.value = withTiming(1, REDUCED_FADE);
                return;
            }
            const settle = { duration: TOAST_MOTION.rise.ms, easing: EASE_SETTLE };
            translateY.value = TOAST_MOTION.rise.fromY;
            scale.value = TOAST_MOTION.rise.fromScale;
            opacity.value = TOAST_MOTION.rise.fromOpacity;
            translateY.value = withTiming(0, settle);
            scale.value = withTiming(1, settle);
            opacity.value = withTiming(1, settle);
        }
        // Strip to strip: the strip simply takes its new place, as on the board.
        // eslint-disable-next-line react-hooks/exhaustive-deps -- runs on a depth change only
    }, [depth, leaving]);

    const pan = Gesture.Pan()
        .withTestId(`toast-pan-${entry.id}`)
        // A non-dismissible card (a status only its owner ends) never swipes.
        .enabled(isFront && entry.dismissible)
        // 10pt before the pan claims the gesture. This threshold is the ONLY
        // reason `showUndoToast`'s Undo button still works: a tap never travels
        // far enough to activate, so it reaches the Pressable inside the card.
        .activeOffsetY([-10, 10])
        // Leave horizontal gestures (navigation's edge swipe) alone.
        .failOffsetX([-20, 20])
        .onUpdate((event) => {
            // Follows the finger up; a pull down barely moves, so it never feels stuck.
            dragY.value = dragOffset(event.translationY);
        })
        .onEnd((event) => {
            if (swipeDismisses(event.translationY, event.velocityY)) {
                runOnJS(markSwipeDismissed)(entry.id);
                const done = (finished?: boolean) => {
                    'worklet';
                    if (finished) runOnJS(closeToast)(entry.id);
                };
                if (reducedSV.value) {
                    opacity.value = withTiming(0, REDUCED_FADE, done);
                    return;
                }
                const leave = { duration: TOAST_MOTION.leave.ms, easing: EASE_LEAVE };
                dragY.value = withTiming(
                    Math.min(dragY.value, 0) + TOAST_MOTION.leave.toHeightShare * heightSV.value,
                    leave,
                );
                opacity.value = withTiming(0, leave, done);
                return;
            }
            dragY.value = withSpring(0, SPRING.settle);
        });

    const animatedStyle = useAnimatedStyle(() => ({
        opacity: opacity.value,
        transform: [{ translateY: translateY.value + dragY.value }, { scale: scale.value }],
    }));

    const d = Math.min(depth, VISIBLE_DEPTH - 1);

    return (
        <Animated.View
            // FULL WIDTH and absolutely positioned, the card centred inside it
            // (MeraToast carries its own fixed width). An absolutely positioned
            // child is NOT centred by a parent's `alignItems`, so the transform
            // has to live out here.
            testID={leaving ? 'toast-slot-leaving' : `toast-slot-${depth}`}
            style={[
                {
                    position: 'absolute',
                    left: 0,
                    right: 0,
                    top: 0,
                    alignItems: 'center',
                    // STACKING IS EXPLICIT, never left to sibling order. Front
                    // highest; a leaving clone above all, since it must cover the
                    // card waiting behind it.
                    zIndex: leaving ? VISIBLE_DEPTH + 1 : VISIBLE_DEPTH - depth,
                },
                animatedStyle,
            ]}
            // Box-none so the full-width slot never swallows a tap aimed at the
            // screen beside the card.
            pointerEvents="box-none"
        >
            <GestureDetector gesture={pan}>
                <View
                    testID={isFront ? 'toast-card' : undefined}
                    pointerEvents={isFront ? 'auto' : 'none'}
                    onLayout={
                        isFront
                            ? (event) => {
                                  const { width, height } = event.nativeEvent.layout;
                                  heightSV.value = height;
                                  onFrontSize({ width, height });
                                  if (arrivePending.current) {
                                      arrivePending.current = false;
                                      arrive(height);
                                  }
                              }
                            : undefined
                    }
                >
                    {/* A BURIED CARD IS DRAWN AS A BARE STRIP, not as its own
                        content: the peek of real content showed the bottom
                        half-line of its text reading out from under the front
                        card. A plain surface also means `NotifiedToast` never
                        mounts until it is the card being read. */}
                    {isTop ? (
                        // `value={isFront}` matters on the exit clone: false
                        // stops `MeraToast` announcing the message a second
                        // time and stops `NotifiedToast` restarting its flight,
                        // while this slot's own opacity carries the leave.
                        <ToastFrontProvider value={isFront}>{entry.render({ id: entry.id })}</ToastFrontProvider>
                    ) : frontSize ? (
                        <View
                            testID="toast-buried-panel"
                            style={{
                                marginTop: frontSize.height + STRIP_TOP[d],
                                width: Math.max(0, frontSize.width - 2 * STRIP_INSET[d]),
                                height: PEEK_PT[d],
                                overflow: 'hidden',
                            }}
                        >
                            <View
                                style={{
                                    marginTop: PEEK_PT[d] - STRIP_BODY,
                                    height: STRIP_BODY,
                                    borderBottomLeftRadius: STRIP_RADIUS,
                                    borderBottomRightRadius: STRIP_RADIUS,
                                    overflow: 'hidden',
                                    backgroundColor: c.panel,
                                    borderWidth: 1,
                                    borderTopWidth: 0,
                                    borderColor: c.line,
                                }}
                            >
                                <View
                                    style={{
                                        ...StyleSheet.absoluteFillObject,
                                        backgroundColor: `rgba(0,0,0,${STRIP_SHADE[d]})`,
                                    }}
                                />
                            </View>
                        </View>
                    ) : null}
                </View>
            </GestureDetector>
        </Animated.View>
    );
}

function DeckColumn({ entries }: { entries: ToastEntry[] }) {
    const insets = useSafeAreaInsets();
    const reduced = !useMotionAllowed();
    const [frontSize, setFrontSize] = useState<{ width: number; height: number } | undefined>(undefined);
    const [leaving, setLeaving] = useState<{ entry: ToastEntry; depth: number }[]>([]);
    const previous = useRef<ToastEntry[]>([]);
    const leaveMs = reduced ? TOAST_MOTION.reduced.ms : TOAST_MOTION.leave.ms;

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
            setLeaving((current) => current.filter(({ entry }) => !fading.some((f) => f.entry.id === entry.id)));
        }, leaveMs);
        // eslint-disable-next-line react-hooks/exhaustive-deps -- reacts to the queue only
    }, [entries]);

    if (entries.length === 0 && leaving.length === 0) return null;

    // While the front card leaves, the next waits in its strip and rises only
    // once the leave is done (the board's order): every card sits one deeper.
    const shift = leaving.some((l) => l.depth === 0) ? 1 : 0;

    // DEEPEST FIRST, front last. The queue array runs front -> back under FIFO
    // and later siblings paint on top, so mapping the array straight into JSX
    // would paint the newest arrival over the card the user is reading.
    const deck = entries
        .slice(0, VISIBLE_DEPTH - shift)
        .map((entry, index) => (
            <ToastSlot
                key={entry.id}
                entry={entry}
                depth={index + shift}
                reduced={reduced}
                frontSize={frontSize}
                onFrontSize={setFrontSize}
            />
        ))
        .reverse();

    return (
        <View style={{ position: 'absolute', left: 0, right: 0, top: insets.top }} pointerEvents="box-none">
            {deck}
            {/* Painted above the deck: a card leaving the front slot covers the
                strips waiting behind it. */}
            {leaving.map(({ entry, depth }) => (
                <ToastSlot
                    key={`leaving-${entry.id}`}
                    entry={entry}
                    depth={depth}
                    reduced={reduced}
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
 *
 * ABOVE A MODAL, TOO, on iOS. An RN `Modal` is a presented view controller, so
 * a root sibling paints UNDER it however late it mounts: a toast fired while
 * the ••• sheet or any other Modal is open would sit hidden beneath it and run
 * out its timer unseen. `FullWindowOverlay` (react-native-screens, already in
 * the binary) adds its container to the key window when it MOUNTS, which is why
 * it mounts only while the deck holds a card: each burst attaches on top of
 * whatever is presented at that moment. It is a separate native root, so it
 * needs its own `GestureHandlerRootView` or the swipe never fires. Both are
 * `box-none`: the overlay container returns no hit view of its own, so a touch
 * beside the card falls through to the screen or the Modal below.
 *
 * Android has no equivalent: an RN Modal there is its own Dialog window and
 * this deck paints under it. Toasting from inside a Modal on Android needs a
 * host mounted inside that Modal; none exists yet.
 */
export default function ToastDeck() {
    const entries = useToastQueue((state) => state.entries);
    const [lingering, setLingering] = useState(false);
    // Stay mounted through the last card's exit fade, then detach.
    useEffect(() => {
        if (entries.length > 0) {
            setLingering(true);
            return;
        }
        const handle = setTimeout(() => setLingering(false), TOAST_MOTION.leave.ms + 50);
        return () => clearTimeout(handle);
    }, [entries.length]);

    if (entries.length === 0 && !lingering) return null;

    const column = <DeckColumn entries={entries} />;
    if (Platform.OS !== 'ios') return column;
    return (
        // NOT modal to VoiceOver. The native container defaults to
        // accessibilityViewIsModal = YES, which hides EVERY view outside it: on
        // device the accessibility tree held only the toast, and a chat
        // composer under a persistent card could not be reached at all. Only
        // the card itself is an accessibility element; everything else passes.
        <FullWindowOverlay unstable_accessibilityContainerViewIsModal={false}>
            <GestureHandlerRootView style={StyleSheet.absoluteFill} pointerEvents="box-none">
                {column}
            </GestureHandlerRootView>
        </FullWindowOverlay>
    );
}
