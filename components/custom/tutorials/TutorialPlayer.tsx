import { MaterialIcons } from '@expo/vector-icons';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
    runOnJS,
    useAnimatedStyle,
    useReducedMotion,
    useSharedValue,
    withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { hapticLight } from '@/lib/haptics';
import { EASE } from '@/lib/motion';
import { getChapter } from '@/lib/tutorials/chapters';
import { chapterTitleKey } from '@/lib/tutorials/keys';
import { useTutorialsStore } from '@/lib/stores/tutorials-store';
import SlideView from './SlideView';
import {
    TUTORIAL_ACCENT,
    TUTORIAL_ACCENT_EDGE,
} from './theme';
import { useTutorialCopy } from './use-tutorial-copy';
import { themedStyles, useColors } from '@/lib/theme/tokens';

/**
 * How long a gated slide waits before offering "Continue anyway".
 *
 * A non-technical reader plus a gate that will not release is the one way this
 * module fails badly, so there are TWO escapes and they are independent: Skip in
 * the header is always enabled from slide one, and this timer un-gates Next on
 * whatever slide the reader is stuck on without losing their place.
 */
export const UNGATE_AFTER_MS = 6000;

/** Card to card (FinalJourney #15): the outgoing card leaves, the next one
 *  settles in 300 ms. A swipe past a quarter of the width, or a flick, turns. */
const CARD_OUT_MS = 150;
const CARD_IN_MS = 300;
const TURN_FRACTION = 0.25;
const TURN_VELOCITY = 500;

interface TutorialPlayerProps {
    readonly chapterId: string;
    readonly onClose: () => void;
    /**
     * Pre-auth (login-screen Modal) passes `false`. This prop IS the
     * no-help-before-login decision — enforced by the prop rather than by
     * remembering not to author `hasAsk` on chapter one.
     */
    readonly enableAskMera?: boolean;
    /** Open at this slide (a page's ? or "Learn about" link); unknown ids open slide 0. */
    readonly initialSlideId?: string;
    /** The last slide's button label, in place of "Done" (the tour's "Begin Mera"). */
    readonly finishLabel?: string;
    /** The last slide's button, in place of `onClose`. Skip and the X still close. */
    readonly onFinish?: () => void;
    /**
     * Hosted in the first-launch tour sheet: the sheet owns the safe areas,
     * and cards follow a horizontal swipe. Off in the pushed route, where a
     * swipe from the left edge is the stack's back gesture.
     */
    readonly inSheet?: boolean;
}

/**
 * Host-agnostic chapter player. The pushed route and the pre-auth Modal render
 * the identical component; only `enableAskMera` differs.
 *
 * ⚠️ Exactly ONE slide is mounted at a time, no carousel: several animated
 * scenes alive at once cost for no visible gain, and a kept slide would carry
 * its interaction state. So a swipe (in the sheet) drags the current card, and
 * the next one slides in after release rather than riding beside the finger.
 *
 * Navigation has THREE routes in and they all funnel through `handleNext` /
 * `handleBack`: the footer buttons, the header Skip, and the stories-style tap
 * zones inside the slide (see `SlideView`). The zones are an ADDITION — the
 * footer keeps its labelled, accessible Back and Next, which is also what makes
 * hiding the zones from the screen reader safe.
 *
 * The header (close, Skip) and the footer (Back, Next) are siblings OUTSIDE the
 * slide's ScrollView, so no tap zone can ever cover them. That is structural,
 * not a z-order accident.
 */
const TutorialPlayer: React.FC<TutorialPlayerProps> = ({
    chapterId,
    onClose,
    enableAskMera = true,
    initialSlideId,
    finishLabel,
    onFinish,
    inSheet = false,
}) => {
    const styles = useStyles();
    const colors = useColors();
    const t = useTutorialCopy();
    const insets = useSafeAreaInsets();
    const { width } = useWindowDimensions();
    const reduceMotion = useReducedMotion();
    const markCompleted = useTutorialsStore((s) => s.markCompleted);

    const chapter = useMemo(() => getChapter(chapterId), [chapterId]);

    const [index, setIndex] = useState(() =>
        Math.max(0, chapter?.slides.findIndex((s) => s.id === initialSlideId) ?? 0),
    );
    const [unlocked, setUnlocked] = useState(true);
    const [timedOut, setTimedOut] = useState(false);
    // Completion is written once per mount, not once per Done tap — a double tap
    // on the last slide must not append a second settings write.
    const completedRef = useRef(false);

    const slide = chapter?.slides[index];
    const total = chapter?.slides.length ?? 0;
    const isLast = index >= total - 1;
    const gated = Boolean(slide?.interaction);
    // Hoisted above the early return so the tap-zone handlers below (which are
    // hooks, and must run unconditionally) can apply the SAME rule the Next
    // button applies. A right-half tap that ignored this would walk straight
    // past every interaction and make UNGATE_AFTER_MS dead code.
    const canAdvance = !gated || unlocked || timedOut;

    // Reset the gate on every slide change. A slide with no interaction is open
    // immediately; one with an interaction starts closed and the interaction
    // reports upward.
    useEffect(() => {
        setUnlocked(!slide?.interaction);
        setTimedOut(false);
    }, [slide]);

    useEffect(() => {
        if (!gated || unlocked) return;
        const timer = setTimeout(() => setTimedOut(true), UNGATE_AFTER_MS);
        return () => clearTimeout(timer);
    }, [gated, unlocked, index]);

    const markDone = useCallback(() => {
        if (chapter && !completedRef.current) {
            completedRef.current = true;
            markCompleted(chapter.id);
        }
    }, [chapter, markCompleted]);

    const finish = useCallback(() => {
        markDone();
        (onFinish ?? onClose)();
    }, [markDone, onFinish, onClose]);

    // The card's horizontal offset: the finger while dragging, then the turn.
    const dragX = useSharedValue(0);
    const slideStyle = useAnimatedStyle(() => ({ transform: [{ translateX: dragX.value }] }));

    const landStep = useCallback(
        (dir: 1 | -1) => {
            setIndex((i) => Math.min(Math.max(0, i + dir), total - 1));
            // The new card starts on the side it comes from and settles.
            dragX.value = dir * width;
            dragX.value = withTiming(0, { duration: CARD_IN_MS, easing: EASE.arrive });
        },
        [dragX, width, total],
    );

    const turn = useCallback(
        (dir: 1 | -1) => {
            if (reduceMotion) {
                dragX.value = 0;
                setIndex((i) => Math.min(Math.max(0, i + dir), total - 1));
                return;
            }
            dragX.value = withTiming(-dir * width, { duration: CARD_OUT_MS, easing: EASE.leave }, (done) => {
                if (done) runOnJS(landStep)(dir);
            });
        },
        [reduceMotion, dragX, width, total, landStep],
    );

    const handleNext = useCallback(() => {
        void hapticLight();
        if (isLast) {
            finish();
            return;
        }
        turn(1);
    }, [isLast, finish, turn]);

    const handleBack = useCallback(() => {
        if (index === 0) return;
        void hapticLight();
        turn(-1);
    }, [index, turn]);

    // Skip jumps to the END of the chapter and marks it done. Deliberately not
    // "close without completing": someone who skips has decided they do not need
    // this chapter, and leaving it un-ticked would nag them from the menu forever.
    const handleSkip = useCallback(() => {
        void hapticLight();
        markDone();
        onClose();
    }, [markDone, onClose]);

    /**
     * Right half tapped.
     *
     * On the LAST slide this is `handleNext`, which finishes the chapter — the
     * tap zone and the "Done" button do the identical thing, deliberately.
     *
     * On a gated slide that has not unlocked yet it BOUNCES: a haptic pulse and
     * nothing else, matching the visibly disabled Next button beneath it. The
     * gate is the only thing making the interactions worth doing, and a tap zone
     * that quietly bypassed it would retire both the interaction and the
     * "Continue anyway" timer.
     */
    const handleTapNext = useCallback(() => {
        if (!canAdvance) {
            void hapticLight();
            return;
        }
        handleNext();
    }, [canAdvance, handleNext]);

    /**
     * Left half tapped.
     *
     * On the FIRST slide there is nowhere to go back to, so this bounces too —
     * a haptic and no navigation, mirroring the disabled Back button. It does
     * NOT close the chapter: an accidental left tap ejecting a reader out of
     * what they were reading is a far worse failure than a tap that visibly
     * refuses, and it would contradict the disabled Back sitting two inches
     * below saying the same thing.
     */
    const handleTapPrev = useCallback(() => {
        if (index === 0) {
            void hapticLight();
            return;
        }
        handleBack();
    }, [index, handleBack]);

    // Swipe card to card in the sheet. Same rule as the buttons: forward only
    // when Next would work and there is a next card (the last card finishes
    // only from its button), back only past the first. Anything else gives a
    // little and springs back. Horizontal only, so the slide still scrolls.
    const canSwipeNext = canAdvance && !isLast;
    const canSwipeBack = index > 0;
    const swipe = Gesture.Pan()
        .enabled(inSheet)
        .activeOffsetX([-15, 15])
        .failOffsetY([-15, 15])
        .onUpdate((e) => {
            const allowed = e.translationX < 0 ? canSwipeNext : canSwipeBack;
            dragX.value = allowed ? e.translationX : e.translationX * 0.25;
        })
        .onEnd((e) => {
            const forward = e.translationX < 0;
            const far = Math.abs(e.translationX) > width * TURN_FRACTION || Math.abs(e.velocityX) > TURN_VELOCITY;
            if (far && forward && canSwipeNext) runOnJS(handleNext)();
            else if (far && !forward && canSwipeBack) runOnJS(handleBack)();
            else dragX.value = withTiming(0, { duration: CARD_IN_MS, easing: EASE.arrive });
        });

    if (!chapter || !slide) {
        // Unknown chapter id (a stale deep link, a renamed slug). Render the
        // empty line rather than crashing the route.
        return (
            <View style={[styles.root, styles.empty, { paddingTop: insets.top + 12 }]}>
                <Text style={styles.emptyText}>{t('tutorials.empty')}</Text>
                <Pressable testID="tutorial-close" onPress={onClose} style={styles.ghostButton}>
                    <Text style={styles.ghostLabel}>{t('tutorials.close')}</Text>
                </Pressable>
            </View>
        );
    }

    const nextLabel = isLast
        ? finishLabel ?? t('tutorials.done')
        : canAdvance && !unlocked && gated
            ? t('tutorials.continueAnyway')
            : t('tutorials.next');

    return (
        <View style={[styles.root, { paddingTop: inSheet ? 4 : insets.top + 8 }]}>
            <View style={styles.header}>
                <Pressable
                    testID="tutorial-close"
                    onPress={onClose}
                    hitSlop={10}
                    accessibilityRole="button"
                    accessibilityLabel={t('tutorials.close')}
                    style={styles.iconButton}
                >
                    <MaterialIcons name="close" size={22} color={colors.ink2} />
                </Pressable>

                <Text style={styles.title} numberOfLines={1}>
                    {t(chapterTitleKey(chapter.id))}
                </Text>

                {/* Always enabled, from slide one. See UNGATE_AFTER_MS. */}
                <Pressable
                    testID="tutorial-skip"
                    onPress={handleSkip}
                    hitSlop={10}
                    accessibilityRole="button"
                    style={styles.skip}
                >
                    <Text style={styles.skipLabel}>{t('tutorials.skip')}</Text>
                </Pressable>
            </View>

            <View
                style={styles.progressTrack}
                accessible
                accessibilityLabel={t('tutorials.slideProgress', {
                    current: index + 1,
                    total,
                })}
            >
                {chapter.slides.map((s, i) => (
                    <View
                        key={s.id}
                        style={[styles.progressCell, i <= index && styles.progressCellDone]}
                    />
                ))}
            </View>

            <GestureDetector gesture={swipe}>
                <Animated.View style={[styles.card, slideStyle]}>
                    <SlideView
                        // Mounting ONE slide, keyed on its id: the previous slide (and
                        // every shared value it owns) unmounts before the next mounts.
                        key={slide.id}
                        chapterId={chapter.id}
                        slide={slide}
                        enableAskMera={enableAskMera}
                        onUnlockedChange={setUnlocked}
                        onTapPrev={handleTapPrev}
                        onTapNext={handleTapNext}
                        dragX={dragX}
                    />
                </Animated.View>
            </GestureDetector>

            <View style={[styles.footer, { paddingBottom: inSheet ? 0 : insets.bottom + 12 }]}>
                <Pressable
                    testID="tutorial-back"
                    onPress={handleBack}
                    disabled={index === 0}
                    accessibilityRole="button"
                    accessibilityState={{ disabled: index === 0 }}
                    style={[styles.ghostButton, index === 0 && styles.disabled]}
                >
                    <Text style={styles.ghostLabel}>{t('tutorials.back')}</Text>
                </Pressable>

                <Pressable
                    testID="tutorial-next"
                    onPress={handleNext}
                    disabled={!canAdvance}
                    accessibilityRole="button"
                    accessibilityState={{ disabled: !canAdvance }}
                    style={[styles.primaryButton, !canAdvance && styles.disabled]}
                >
                    <Text style={styles.primaryLabel}>{nextLabel}</Text>
                </Pressable>
            </View>
        </View>
    );
};

const useStyles = themedStyles((c) => StyleSheet.create({
    root: { flex: 1 },
    card: { flex: 1 },
    empty: {
        alignItems: 'center',
        justifyContent: 'center',
        gap: 16,
    },
    emptyText: {
        color: c.ink2,
        fontSize: 14,
    },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        paddingHorizontal: 16,
        paddingBottom: 10,
    },
    iconButton: {
        width: 32,
        height: 32,
        alignItems: 'center',
        justifyContent: 'center',
    },
    title: {
        flex: 1,
        color: c.ink,
        fontSize: 15,
        fontWeight: '600',
        textAlign: 'center',
    },
    skip: {
        paddingHorizontal: 4,
        paddingVertical: 6,
    },
    skipLabel: {
        color: c.ink2,
        fontSize: 13,
        fontWeight: '600',
    },
    progressTrack: {
        flexDirection: 'row',
        gap: 4,
        paddingHorizontal: 20,
        paddingBottom: 16,
    },
    progressCell: {
        flex: 1,
        height: 3,
        borderRadius: 2,
        backgroundColor: c.trackBorder,
    },
    progressCellDone: {
        backgroundColor: TUTORIAL_ACCENT,
    },
    footer: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        paddingHorizontal: 20,
        paddingTop: 12,
    },
    ghostButton: {
        borderRadius: 999,
        borderWidth: 1,
        borderColor: c.trackBorder,
        backgroundColor: c.trackFill,
        paddingHorizontal: 20,
        paddingVertical: 12,
    },
    ghostLabel: {
        color: c.ink,
        fontSize: 14,
        fontWeight: '600',
    },
    primaryButton: {
        flex: 1,
        alignItems: 'center',
        borderRadius: 999,
        borderWidth: 1,
        borderColor: TUTORIAL_ACCENT_EDGE,
        backgroundColor: TUTORIAL_ACCENT,
        paddingVertical: 12,
    },
    primaryLabel: {
        color: '#000000',
        fontSize: 14,
        fontWeight: '700',
    },
    disabled: {
        opacity: 0.4,
    },
}));

export default TutorialPlayer;
