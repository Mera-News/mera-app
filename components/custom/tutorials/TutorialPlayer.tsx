import { MaterialIcons } from '@expo/vector-icons';
import React from 'react';
import { Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { runOnJS, useReducedMotion, withTiming } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { EASE } from '@/lib/motion';
import { chapterTitleKey } from '@/lib/tutorials/keys';
import SlideView from './SlideView';
import {
    TUTORIAL_ACCENT,
    TUTORIAL_ACCENT_EDGE,
} from './theme';
import { CARD_IN_MS, TURN_FRACTION, TURN_VELOCITY, useTutorialPlayer } from './useTutorialPlayer';
import { useTutorialCopy } from './use-tutorial-copy';
import { themedStyles, useColors } from '@/lib/theme/tokens';

export { UNGATE_AFTER_MS } from './useTutorialPlayer';

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
    const {
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
    } = useTutorialPlayer({ chapterId, initialSlideId, width, reduceMotion, onClose, onFinish });
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
