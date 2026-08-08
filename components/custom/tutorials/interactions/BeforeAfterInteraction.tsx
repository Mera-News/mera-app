import { MaterialIcons } from '@expo/vector-icons';
import React, { useCallback, useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { hapticLight } from '@/lib/haptics';
import { beforeAfterKey } from '@/lib/tutorials/keys';
import type { ChapterId } from '@/lib/tutorials/types';
import {
    TUTORIAL_ACCENT,
    TUTORIAL_ACCENT_EDGE,
    TUTORIAL_ACCENT_SOFT,
    TUTORIAL_MUTED,
    TUTORIAL_MUTED_EDGE,
    TUTORIAL_TEXT_DIM,
} from '../theme';
import { useTutorialCopy } from '../use-tutorial-copy';

interface Props {
    readonly chapterId: ChapterId;
    readonly slideId: string;
    readonly requiredToggles?: number;
    readonly onUnlockedChange: (unlocked: boolean) => void;
}

/**
 * A single card that flips between two statements.
 *
 * Used where the app's real behaviour is NOT what a reasonable person would
 * assume — a read card sinking rather than vanishing, cloud being the default
 * rather than on-device, some changes not being revertible. Making the correction
 * a deliberate flip, rather than a paragraph, is what makes it land.
 *
 * The "before" side is the comfortable assumption; the "after" side is what is
 * actually true. That asymmetry is why the labels are not "Before"/"After" in the
 * literal sense — see `tutorials.beforeLabel` / `afterLabel`.
 */
const BeforeAfterInteraction: React.FC<Props> = ({
    chapterId,
    slideId,
    requiredToggles,
    onUnlockedChange,
}) => {
    const t = useTutorialCopy();
    const [showAfter, setShowAfter] = useState(false);
    const [toggles, setToggles] = useState(0);

    const required = Math.max(1, requiredToggles ?? 1);
    const unlocked = toggles >= required;

    useEffect(() => {
        onUnlockedChange(unlocked);
    }, [unlocked, onUnlockedChange]);

    const handlePress = useCallback(() => {
        void hapticLight();
        setShowAfter((prev) => !prev);
        setToggles((prev) => prev + 1);
    }, []);

    return (
        <View style={styles.root}>
            <Text style={styles.hint}>{t('tutorials.hintBeforeAfter')}</Text>
            <Pressable
                testID="tutorial-before-after"
                onPress={handlePress}
                accessibilityRole="button"
                accessibilityState={{ expanded: showAfter }}
                style={[styles.card, showAfter ? styles.cardAfter : styles.cardBefore]}
            >
                <View style={styles.head}>
                    <MaterialIcons
                        name={showAfter ? 'lightbulb' : 'help-outline'}
                        size={16}
                        color={showAfter ? TUTORIAL_ACCENT : TUTORIAL_TEXT_DIM}
                    />
                    <Text style={styles.sideLabel}>
                        {showAfter ? t('tutorials.afterLabel') : t('tutorials.beforeLabel')}
                    </Text>
                    <MaterialIcons name="flip" size={16} color={TUTORIAL_TEXT_DIM} />
                </View>
                <Text style={styles.body}>
                    {t(beforeAfterKey(chapterId, slideId, showAfter ? 'after' : 'before'))}
                </Text>
            </Pressable>
        </View>
    );
};

const styles = StyleSheet.create({
    root: { gap: 8 },
    hint: {
        color: TUTORIAL_TEXT_DIM,
        fontSize: 12,
    },
    card: {
        borderRadius: 12,
        borderWidth: 1,
        paddingHorizontal: 14,
        paddingVertical: 14,
        gap: 10,
        minHeight: 118,
    },
    cardBefore: {
        backgroundColor: TUTORIAL_MUTED,
        borderColor: TUTORIAL_MUTED_EDGE,
    },
    cardAfter: {
        backgroundColor: TUTORIAL_ACCENT_SOFT,
        borderColor: TUTORIAL_ACCENT_EDGE,
    },
    head: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
    },
    sideLabel: {
        flex: 1,
        color: '#ffffff',
        fontSize: 12,
        fontWeight: '700',
        textTransform: 'uppercase',
        letterSpacing: 0.6,
    },
    body: {
        color: 'rgb(212,212,212)',
        fontSize: 13,
        lineHeight: 20,
    },
});

export default BeforeAfterInteraction;
