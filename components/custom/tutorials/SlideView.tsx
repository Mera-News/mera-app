import React, { useMemo } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

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
    readonly onClose: () => void;
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
 */
const SlideView: React.FC<SlideViewProps> = ({
    chapterId,
    slide,
    enableAskMera,
    onUnlockedChange,
    onClose,
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
            <SceneView visual={slide.visual} stepLabels={stepLabels} />

            <View style={styles.copy}>
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
                        onClose={onClose}
                    />
                </View>
            ) : null}
        </ScrollView>
    );
};

const styles = StyleSheet.create({
    scroll: { flex: 1 },
    content: {
        paddingHorizontal: 20,
        paddingBottom: 24,
    },
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
