import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { runOnJS, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';

import { hapticLight } from '@/lib/haptics';
import { EASE } from '@/lib/motion';
import { getChapter } from '@/lib/tutorials/chapters';
import { useTutorialsStore } from '@/lib/stores/tutorials-store';

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

interface UseTutorialPlayerArgs {
    readonly chapterId: string;
    readonly initialSlideId?: string;
    readonly width: number;
    readonly reduceMotion: boolean;
    readonly onClose: () => void;
    readonly onFinish?: () => void;
}

export function useTutorialPlayer({
    chapterId,
    initialSlideId,
    width,
    reduceMotion,
    onClose,
    onFinish,
}: UseTutorialPlayerArgs) {
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
    const gated = Boolean(slide?.interaction) && !slide?.optional;
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

    return {
        chapter,
        index,
        unlocked,
        setUnlocked,
        slide,
        total,
        isLast,
        gated,
        canAdvance,
        dragX,
        slideStyle,
        handleNext,
        handleBack,
        handleSkip,
        handleTapNext,
        handleTapPrev,
        canSwipeNext,
        canSwipeBack,
    };
}

export { CARD_IN_MS, TURN_FRACTION, TURN_VELOCITY };
