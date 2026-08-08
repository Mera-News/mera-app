import { MaterialIcons } from '@expo/vector-icons';
import React, { useCallback, useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { hapticLight } from '@/lib/haptics';
import { sortBucketKey, sortCardKey } from '@/lib/tutorials/keys';
import type { ChapterId, SortBucket, SortCard } from '@/lib/tutorials/types';
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
    readonly cards: readonly SortCard[];
    readonly buckets: readonly SortBucket[];
    readonly onUnlockedChange: (unlocked: boolean) => void;
}

/**
 * TAP a card, then TAP a bucket. Deliberately not a drag.
 *
 * A drag needs `GestureDetector`, and gesture handling is exactly what
 * misbehaves inside an RN `Modal` on Android unless the modal content mounts its
 * own `GestureHandlerRootView` — and the pre-auth host IS a Modal. Two taps also
 * happen to be far easier for the audience this module is written for.
 *
 * A wrong drop does not stick: the card stays in the tray and the bucket flashes
 * a "not quite" tint. There is no score and no penalty — the point is that the
 * user leaves knowing which side a control is on.
 */
const SortInteraction: React.FC<Props> = ({
    chapterId,
    slideId,
    cards,
    buckets,
    onUnlockedChange,
}) => {
    const t = useTutorialCopy();
    const [placed, setPlaced] = useState<Readonly<Record<string, string>>>({});
    const [selectedCardId, setSelectedCardId] = useState<string | null>(null);
    const [wrongBucketId, setWrongBucketId] = useState<string | null>(null);

    const unlocked = Object.keys(placed).length >= cards.length;

    useEffect(() => {
        onUnlockedChange(unlocked);
    }, [unlocked, onUnlockedChange]);

    const handleCardPress = useCallback(
        (cardId: string) => {
            if (placed[cardId]) return;
            void hapticLight();
            setWrongBucketId(null);
            setSelectedCardId((prev) => (prev === cardId ? null : cardId));
        },
        [placed],
    );

    const handleBucketPress = useCallback(
        (bucketId: string) => {
            if (!selectedCardId) return;
            const card = cards.find((c) => c.id === selectedCardId);
            if (!card) return;
            void hapticLight();
            if (card.bucketId !== bucketId) {
                setWrongBucketId(bucketId);
                return;
            }
            setWrongBucketId(null);
            setPlaced((prev) => ({ ...prev, [card.id]: bucketId }));
            setSelectedCardId(null);
        },
        [cards, selectedCardId],
    );

    const tray = cards.filter((c) => !placed[c.id]);

    return (
        <View style={styles.root}>
            <Text style={styles.hint}>
                {unlocked
                    ? t('tutorials.sortDone')
                    : selectedCardId
                        ? t('tutorials.hintSortPick')
                        : t('tutorials.hintSort')}
            </Text>

            {tray.length > 0 ? (
                <View style={styles.tray}>
                    {tray.map((card) => {
                        const isSelected = card.id === selectedCardId;
                        return (
                            <Pressable
                                key={card.id}
                                testID={`tutorial-sort-card-${card.id}`}
                                onPress={() => handleCardPress(card.id)}
                                accessibilityRole="button"
                                accessibilityState={{ selected: isSelected }}
                                style={[styles.card, isSelected ? styles.cardSelected : styles.cardIdle]}
                            >
                                <Text style={styles.cardText}>
                                    {t(sortCardKey(chapterId, slideId, card.id))}
                                </Text>
                            </Pressable>
                        );
                    })}
                </View>
            ) : null}

            <View style={styles.buckets}>
                {buckets.map((bucket) => {
                    const contents = cards.filter((c) => placed[c.id] === bucket.id);
                    const isWrong = bucket.id === wrongBucketId;
                    return (
                        <Pressable
                            key={bucket.id}
                            testID={`tutorial-sort-bucket-${bucket.id}`}
                            onPress={() => handleBucketPress(bucket.id)}
                            accessibilityRole="button"
                            accessibilityLabel={t(sortBucketKey(chapterId, slideId, bucket.id))}
                            style={[styles.bucket, isWrong && styles.bucketWrong]}
                        >
                            <View style={styles.bucketHead}>
                                <MaterialIcons
                                    name={bucket.icon}
                                    size={16}
                                    color={TUTORIAL_ACCENT}
                                />
                                <Text style={styles.bucketLabel}>
                                    {t(sortBucketKey(chapterId, slideId, bucket.id))}
                                </Text>
                            </View>
                            {contents.map((card) => (
                                <View key={card.id} style={styles.placedChip}>
                                    <MaterialIcons name="check" size={13} color={TUTORIAL_ACCENT} />
                                    <Text style={styles.placedText}>
                                        {t(sortCardKey(chapterId, slideId, card.id))}
                                    </Text>
                                </View>
                            ))}
                        </Pressable>
                    );
                })}
            </View>
        </View>
    );
};

const styles = StyleSheet.create({
    root: { gap: 10 },
    hint: {
        color: TUTORIAL_TEXT_DIM,
        fontSize: 12,
    },
    tray: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: 8,
    },
    card: {
        borderRadius: 999,
        borderWidth: 1,
        paddingHorizontal: 12,
        paddingVertical: 8,
    },
    cardIdle: {
        backgroundColor: TUTORIAL_MUTED,
        borderColor: TUTORIAL_MUTED_EDGE,
    },
    cardSelected: {
        backgroundColor: TUTORIAL_ACCENT_SOFT,
        borderColor: TUTORIAL_ACCENT,
    },
    cardText: {
        color: '#ffffff',
        fontSize: 13,
    },
    buckets: {
        flexDirection: 'row',
        gap: 8,
    },
    bucket: {
        flex: 1,
        minHeight: 96,
        borderRadius: 12,
        borderWidth: 1,
        borderStyle: 'dashed',
        borderColor: TUTORIAL_MUTED_EDGE,
        backgroundColor: TUTORIAL_MUTED,
        padding: 10,
        gap: 8,
    },
    bucketWrong: {
        borderColor: 'rgba(248,113,113,0.7)',
    },
    bucketHead: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
    },
    bucketLabel: {
        flex: 1,
        color: '#ffffff',
        fontSize: 12,
        fontWeight: '600',
    },
    placedChip: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
        borderRadius: 999,
        backgroundColor: TUTORIAL_ACCENT_SOFT,
        borderWidth: 1,
        borderColor: TUTORIAL_ACCENT_EDGE,
        paddingHorizontal: 8,
        paddingVertical: 5,
    },
    placedText: {
        flex: 1,
        color: 'rgb(229,229,229)',
        fontSize: 11,
    },
});

export default SortInteraction;
