import { MaterialIcons } from '@expo/vector-icons';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { hapticLight } from '@/lib/haptics';
import { getChapter } from '@/lib/tutorials/chapters';
import { chapterTitleKey } from '@/lib/tutorials/keys';
import { useTutorialsStore } from '@/lib/stores/tutorials-store';
import SlideView from './SlideView';
import {
    TUTORIAL_ACCENT,
    TUTORIAL_ACCENT_EDGE,
    TUTORIAL_MUTED,
    TUTORIAL_MUTED_EDGE,
    TUTORIAL_TEXT_DIM,
} from './theme';
import { useTutorialCopy } from './use-tutorial-copy';

/**
 * How long a gated slide waits before offering "Continue anyway".
 *
 * A non-technical reader plus a gate that will not release is the one way this
 * module fails badly, so there are TWO escapes and they are independent: Skip in
 * the header is always enabled from slide one, and this timer un-gates Next on
 * whatever slide the reader is stuck on without losing their place.
 */
export const UNGATE_AFTER_MS = 6000;

interface TutorialPlayerProps {
    readonly chapterId: string;
    readonly onClose: () => void;
    /**
     * Pre-auth (login-screen Modal) passes `false`. This prop IS the
     * no-help-before-login decision — enforced by the prop rather than by
     * remembering not to author `hasAsk` on chapter one.
     */
    readonly enableAskMera?: boolean;
}

/**
 * Host-agnostic chapter player. The pushed route and the pre-auth Modal render
 * the identical component; only `enableAskMera` differs.
 *
 * ⚠️ Exactly ONE slide is mounted at a time — no carousel. A carousel would drag
 * gesture handling into the pre-auth Modal (where it misbehaves on Android) and
 * would keep several animated scenes alive at once for no visible gain.
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
}) => {
    const t = useTutorialCopy();
    const insets = useSafeAreaInsets();
    const markCompleted = useTutorialsStore((s) => s.markCompleted);

    const chapter = useMemo(() => getChapter(chapterId), [chapterId]);

    const [index, setIndex] = useState(0);
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

    const finish = useCallback(() => {
        if (chapter && !completedRef.current) {
            completedRef.current = true;
            markCompleted(chapter.id);
        }
        onClose();
    }, [chapter, markCompleted, onClose]);

    const handleNext = useCallback(() => {
        void hapticLight();
        if (isLast) {
            finish();
            return;
        }
        setIndex((i) => i + 1);
    }, [isLast, finish]);

    const handleBack = useCallback(() => {
        void hapticLight();
        setIndex((i) => Math.max(0, i - 1));
    }, []);

    // Skip jumps to the END of the chapter and marks it done. Deliberately not
    // "close without completing": someone who skips has decided they do not need
    // this chapter, and leaving it un-ticked would nag them from the menu forever.
    const handleSkip = useCallback(() => {
        void hapticLight();
        finish();
    }, [finish]);

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
        ? t('tutorials.done')
        : canAdvance && !unlocked && gated
            ? t('tutorials.continueAnyway')
            : t('tutorials.next');

    return (
        <View style={[styles.root, { paddingTop: insets.top + 8 }]}>
            <View style={styles.header}>
                <Pressable
                    testID="tutorial-close"
                    onPress={onClose}
                    hitSlop={10}
                    accessibilityRole="button"
                    accessibilityLabel={t('tutorials.close')}
                    style={styles.iconButton}
                >
                    <MaterialIcons name="close" size={22} color={TUTORIAL_TEXT_DIM} />
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
            />

            <View style={[styles.footer, { paddingBottom: insets.bottom + 12 }]}>
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

const styles = StyleSheet.create({
    root: { flex: 1 },
    empty: {
        alignItems: 'center',
        justifyContent: 'center',
        gap: 16,
    },
    emptyText: {
        color: TUTORIAL_TEXT_DIM,
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
        color: '#ffffff',
        fontSize: 15,
        fontWeight: '600',
        textAlign: 'center',
    },
    skip: {
        paddingHorizontal: 4,
        paddingVertical: 6,
    },
    skipLabel: {
        color: TUTORIAL_TEXT_DIM,
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
        backgroundColor: TUTORIAL_MUTED_EDGE,
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
        borderColor: TUTORIAL_MUTED_EDGE,
        backgroundColor: TUTORIAL_MUTED,
        paddingHorizontal: 20,
        paddingVertical: 12,
    },
    ghostLabel: {
        color: '#ffffff',
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
});

export default TutorialPlayer;
