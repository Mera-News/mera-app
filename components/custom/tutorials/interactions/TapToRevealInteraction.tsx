import { MaterialIcons } from '@expo/vector-icons';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { hapticLight } from '@/lib/haptics';
import { revealLabelKey, revealTextKey } from '@/lib/tutorials/keys';
import type { ChapterId, RevealTarget } from '@/lib/tutorials/types';
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
    readonly targets: readonly RevealTarget[];
    readonly requiredReveals?: number;
    readonly onUnlockedChange: (unlocked: boolean) => void;
}

/**
 * Tap a chip, uncover a sentence. Reveals are sticky — nothing re-hides — so the
 * user can compare two answers side by side, which is the point on slides like
 * "mute vs downrank".
 *
 * Tap-based, like every interaction in this module: the pre-auth host is an RN
 * `Modal`, and `GestureDetector` does not receive touches inside one on Android
 * without its own `GestureHandlerRootView`.
 */
const TapToRevealInteraction: React.FC<Props> = ({
    chapterId,
    slideId,
    targets,
    requiredReveals,
    onUnlockedChange,
}) => {
    const t = useTutorialCopy();
    const [revealed, setRevealed] = useState<ReadonlySet<string>>(new Set());

    const required = Math.min(requiredReveals ?? targets.length, targets.length);
    const unlocked = revealed.size >= required;

    useEffect(() => {
        onUnlockedChange(unlocked);
    }, [unlocked, onUnlockedChange]);

    const handlePress = useCallback((id: string) => {
        void hapticLight();
        setRevealed((prev) => {
            if (prev.has(id)) return prev;
            const next = new Set(prev);
            next.add(id);
            return next;
        });
    }, []);

    const hint = useMemo(
        () =>
            required >= targets.length
                ? t('tutorials.hintReveal')
                : t('tutorials.hintRevealSome', { count: required }),
        [required, targets.length, t],
    );

    return (
        <View style={styles.root}>
            <Text style={styles.hint}>{hint}</Text>
            {targets.map((target) => {
                const isOpen = revealed.has(target.id);
                return (
                    <Pressable
                        key={target.id}
                        testID={`tutorial-reveal-${target.id}`}
                        onPress={() => handlePress(target.id)}
                        accessibilityRole="button"
                        accessibilityState={{ expanded: isOpen }}
                        accessibilityLabel={t(revealLabelKey(chapterId, slideId, target.id))}
                        style={[styles.row, isOpen ? styles.rowOpen : styles.rowClosed]}
                    >
                        <View style={styles.rowHead}>
                            <MaterialIcons
                                name={target.icon}
                                size={18}
                                color={isOpen ? TUTORIAL_ACCENT : TUTORIAL_TEXT_DIM}
                            />
                            <Text style={styles.label}>
                                {t(revealLabelKey(chapterId, slideId, target.id))}
                            </Text>
                            <MaterialIcons
                                name={isOpen ? 'expand-less' : 'expand-more'}
                                size={18}
                                color={TUTORIAL_TEXT_DIM}
                            />
                        </View>
                        {isOpen ? (
                            <Text style={styles.text}>
                                {t(revealTextKey(chapterId, slideId, target.id))}
                            </Text>
                        ) : null}
                    </Pressable>
                );
            })}
        </View>
    );
};

const styles = StyleSheet.create({
    root: { gap: 8 },
    hint: {
        color: TUTORIAL_TEXT_DIM,
        fontSize: 12,
        marginBottom: 2,
    },
    row: {
        borderRadius: 12,
        borderWidth: 1,
        paddingHorizontal: 12,
        paddingVertical: 12,
        gap: 8,
    },
    rowClosed: {
        backgroundColor: TUTORIAL_MUTED,
        borderColor: TUTORIAL_MUTED_EDGE,
    },
    rowOpen: {
        backgroundColor: TUTORIAL_ACCENT_SOFT,
        borderColor: TUTORIAL_ACCENT_EDGE,
    },
    rowHead: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
    },
    label: {
        flex: 1,
        color: '#ffffff',
        fontSize: 14,
        fontWeight: '600',
    },
    text: {
        color: 'rgb(212,212,212)',
        fontSize: 13,
        lineHeight: 19,
    },
});

export default TapToRevealInteraction;
