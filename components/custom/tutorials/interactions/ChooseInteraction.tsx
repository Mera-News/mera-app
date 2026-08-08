import { MaterialIcons } from '@expo/vector-icons';
import React, { useCallback, useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { hapticLight } from '@/lib/haptics';
import { chooseFeedbackKey, chooseLabelKey } from '@/lib/tutorials/keys';
import type { ChapterId, ChoiceOption } from '@/lib/tutorials/types';
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
    readonly options: readonly ChoiceOption[];
    readonly mustBeCorrect?: boolean;
    readonly onUnlockedChange: (unlocked: boolean) => void;
}

/**
 * A small multiple choice. Every option carries its own one-line response, so a
 * wrong answer TEACHES rather than scolds — several of these slides exist
 * precisely because the intuitive answer is wrong (the "+" chip, decoy padding,
 * typed agreement in chat).
 *
 * Choices stay re-tappable after the first pick: reading the other responses is
 * the useful part. `mustBeCorrect` only decides whether Next unlocks on any
 * answer or on the right one — and the always-enabled Skip in the header, plus
 * the "Continue anyway" timer, mean a stuck gate can never trap anyone.
 */
const ChooseInteraction: React.FC<Props> = ({
    chapterId,
    slideId,
    options,
    mustBeCorrect,
    onUnlockedChange,
}) => {
    const t = useTutorialCopy();
    const [pickedId, setPickedId] = useState<string | null>(null);

    const picked = options.find((o) => o.id === pickedId) ?? null;
    const unlocked = picked !== null && (!mustBeCorrect || picked.correct === true);

    useEffect(() => {
        onUnlockedChange(unlocked);
    }, [unlocked, onUnlockedChange]);

    const handlePress = useCallback((id: string) => {
        void hapticLight();
        setPickedId(id);
    }, []);

    return (
        <View style={styles.root}>
            <Text style={styles.hint}>{t('tutorials.hintChoose')}</Text>
            {options.map((option) => {
                const isPicked = option.id === pickedId;
                return (
                    <Pressable
                        key={option.id}
                        testID={`tutorial-choice-${option.id}`}
                        onPress={() => handlePress(option.id)}
                        accessibilityRole="button"
                        accessibilityState={{ selected: isPicked }}
                        accessibilityLabel={t(chooseLabelKey(chapterId, slideId, option.id))}
                        style={[styles.row, isPicked ? styles.rowPicked : styles.rowIdle]}
                    >
                        <View style={styles.rowHead}>
                            <MaterialIcons
                                name={
                                    isPicked
                                        ? option.correct
                                            ? 'check-circle'
                                            : 'info'
                                        : 'radio-button-unchecked'
                                }
                                size={18}
                                color={isPicked ? TUTORIAL_ACCENT : TUTORIAL_TEXT_DIM}
                            />
                            <Text style={styles.label}>
                                {t(chooseLabelKey(chapterId, slideId, option.id))}
                            </Text>
                        </View>
                        {isPicked ? (
                            <Text style={styles.feedback}>
                                {t(chooseFeedbackKey(chapterId, slideId, option.id))}
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
    rowIdle: {
        backgroundColor: TUTORIAL_MUTED,
        borderColor: TUTORIAL_MUTED_EDGE,
    },
    rowPicked: {
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
    },
    feedback: {
        color: 'rgb(212,212,212)',
        fontSize: 13,
        lineHeight: 19,
        paddingLeft: 28,
    },
});

export default ChooseInteraction;
