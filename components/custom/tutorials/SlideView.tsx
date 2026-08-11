import React, { useMemo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
// Via the ui layer rather than `react-native` directly. It is a bare re-export of
// the same component (`components/ui/scroll-view/index.tsx`), and it exists so a
// test can stub one module path instead of partially mocking react-native.
import { ScrollView } from '@/components/ui/scroll-view';

import {
    slideAskKey,
    slideBodyKey,
    slideHeadlineKey,
    stepKey,
} from '@/lib/tutorials/keys';
import type { ChapterId, TutorialSlide } from '@/lib/tutorials/types';
import AskMeraButton from './AskMeraButton';
import SceneView from './SceneView';
import InteractionRenderer from './interactions';
import { useTutorialCopy } from './use-tutorial-copy';

interface SlideViewProps {
    readonly chapterId: ChapterId;
    readonly slide: TutorialSlide;
    /** False from the pre-auth Modal host: no session ⇒ no agent ⇒ no button. */
    readonly enableAskMera: boolean;
    readonly onUnlockedChange: (unlocked: boolean) => void;
    /** Left half tapped. The player decides what "back" means here. */
    readonly onTapPrev: () => void;
    /** Right half tapped. The player applies the same gate as the Next button. */
    readonly onTapNext: () => void;
}

/**
 * One slide: scene, headline, body, an optional interaction, an optional
 * Ask-Mera button. Owns no navigation and no completion state — it reports
 * `unlocked` upward and the player decides what that means.
 *
 * Exactly one of these is mounted at a time (see `TutorialPlayer`). That is not
 * only about cost: the interactions hold local state, and keeping a previous
 * slide alive would carry its reveals and its selected sort card into the next
 * one.
 *
 * ── The stories-style tap zones ─────────────────────────────────────────────
 * Left half = previous, right half = next. THE LAYERING IS THE WHOLE FEATURE,
 * so it is worth stating exactly why it is built this way:
 *
 *  • React Native has NO sibling fall-through. A view with the default
 *    `pointerEvents: 'auto'` is the hit-test target even when it handles
 *    nothing; the responder then bubbles to its ANCESTORS, never to a sibling
 *    painted behind it. So zones absolutely positioned behind this ScrollView
 *    would never receive a single tap — the ScrollView would eat all of them,
 *    and a ScrollView cannot be `box-none` without losing its scroll.
 *
 *  • Therefore the zones live INSIDE the scroll content, as its FIRST child.
 *    Later siblings paint above and are hit-tested first, so the interaction
 *    block and the Ask-Mera button — which come after — win every tap that
 *    lands on them. The zones are literally behind them.
 *
 *  • The scene and the copy are wrapped in `pointerEvents="none"` so they are
 *    invisible to hit-testing and taps on them reach the zones underneath.
 *    Without that, two thirds of the slide would be dead to the gesture.
 *
 *  • `flexGrow: 1` on the content container (with no `justifyContent`, so the
 *    content stays top-aligned) makes the zones cover the whole viewport on a
 *    short slide rather than only the height of the copy.
 *
 * Tap-based `Pressable`s only — no pan/gesture handlers. Gesture handling is
 * unreliable inside the pre-auth Modal host, and this component renders in both
 * hosts unchanged.
 */
const SlideView: React.FC<SlideViewProps> = ({
    chapterId,
    slide,
    enableAskMera,
    onUnlockedChange,
    onTapPrev,
    onTapNext,
}) => {
    const t = useTutorialCopy();

    // The `steps` placeholder is the one kind that renders copy, so its labels
    // are resolved here and handed down — the placeholder tree stays free of i18n.
    const stepLabels = useMemo(() => {
        const placeholder = slide.visual.placeholder;
        if (placeholder.kind !== 'steps') return undefined;
        return Array.from({ length: placeholder.count }, (_, i) =>
            t(stepKey(chapterId, slide.id, i)),
        );
    }, [chapterId, slide.id, slide.visual.placeholder, t]);

    return (
        <ScrollView
            testID={`tutorial-slide-${slide.id}`}
            style={styles.scroll}
            contentContainerStyle={styles.content}
            showsVerticalScrollIndicator={false}
        >
            {/* FIRST child, and it must stay first: everything below is a later
                sibling that paints — and hit-tests — above it. */}
            <View
                testID="tutorial-tap-zones"
                style={styles.zones}
                // The footer already carries a labelled Back and Next, so these
                // two would only add a pair of unlabelled full-height buttons to
                // the screen reader's list of things to swipe through.
                accessibilityElementsHidden
                importantForAccessibility="no-hide-descendants"
            >
                <Pressable
                    testID="tutorial-tap-prev"
                    onPress={onTapPrev}
                    style={styles.zone}
                />
                <Pressable
                    testID="tutorial-tap-next"
                    onPress={onTapNext}
                    style={styles.zone}
                />
            </View>

            {/* Transparent to touches so the zones behind get the tap. Wrapped
                from OUTSIDE rather than given a prop: the placeholders inside
                call `useSharedValue`, and `reactCompiler: true` means they must
                never branch on a variant. */}
            <View testID="tutorial-slide-scene" pointerEvents="none">
                <SceneView visual={slide.visual} stepLabels={stepLabels} />
            </View>

            <View testID="tutorial-slide-copy" pointerEvents="none" style={styles.copy}>
                <Text style={styles.headline}>
                    {t(slideHeadlineKey(chapterId, slide.id))}
                </Text>
                <Text style={styles.body}>{t(slideBodyKey(chapterId, slide.id))}</Text>
            </View>

            {slide.interaction ? (
                <View style={styles.interaction}>
                    <InteractionRenderer
                        // Keyed on the slide so a kind that appears twice in a
                        // chapter cannot reuse the previous instance's state.
                        key={slide.id}
                        chapterId={chapterId}
                        slideId={slide.id}
                        interaction={slide.interaction}
                        onUnlockedChange={onUnlockedChange}
                    />
                </View>
            ) : null}

            {enableAskMera && slide.hasAsk ? (
                <View style={styles.ask}>
                    <AskMeraButton
                        chapterId={chapterId}
                        slideId={slide.id}
                        prefill={t(slideAskKey(chapterId, slide.id))}
                    />
                </View>
            ) : null}
        </ScrollView>
    );
};

const styles = StyleSheet.create({
    scroll: { flex: 1 },
    content: {
        // `flexGrow` and NOT `justifyContent`: the zones need to reach the
        // bottom of the viewport on a short slide, but the copy must stay
        // top-aligned or every short slide would suddenly be vertically
        // centred.
        flexGrow: 1,
        paddingHorizontal: 20,
        paddingBottom: 24,
    },
    zones: {
        ...StyleSheet.absoluteFillObject,
        flexDirection: 'row',
    },
    zone: { flex: 1 },
    copy: {
        gap: 10,
        marginTop: 8,
    },
    headline: {
        color: '#ffffff',
        fontSize: 22,
        lineHeight: 28,
        fontWeight: '700',
    },
    body: {
        color: 'rgb(212,212,212)',
        fontSize: 15,
        lineHeight: 23,
    },
    interaction: {
        marginTop: 20,
    },
    ask: {
        marginTop: 22,
    },
});

export default SlideView;
