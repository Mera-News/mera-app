import { Box } from '@/components/ui/box';
import { HStack } from '@/components/ui/hstack';
import { Pressable } from '@/components/ui/pressable';
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import TranslatableDynamic from '@/components/custom/TranslatableDynamic';
import { nudgeTopic } from '@/lib/database/services/mutation-rails-service';
import { getWeightsByIds } from '@/lib/database/services/topic-service';
import { deleteSummaryString, type PersonaSummaryStringRow } from '@/lib/database/services/persona-summary-service';
import { handleDeleteUserFacts } from '@/lib/chat-tools/tool-handlers';
import { hapticLight, hapticMedium, hapticSuccess } from '@/lib/haptics';
import logger from '@/lib/logger';
import { useFloatingChatStore } from '@/lib/stores/floating-chat-store';
import { useForYouStore } from '@/lib/stores/for-you-store';
import { MaterialIcons } from '@expo/vector-icons';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Modal } from 'react-native';

const ACCENT = '#EDA77E';

/** Per-tap weight nudge applied to every topic behind a string (leashed by the
 *  mutation-rails budget). Small so the stepper is a gentle "more/less". */
const IMPORTANCE_STEP = 0.05;

/** Number of segments in the visual importance level meter. */
const IMPORTANCE_SEGMENTS = 5;

type ResolvedTopic = { id: string; weight: number };

interface PersonaStringSheetProps {
    readonly visible: boolean;
    readonly row: PersonaSummaryStringRow | null;
    readonly onClose: () => void;
    /** Called after a change that removed the string (so the list can refresh). */
    readonly onRemoved?: () => void;
}

/**
 * Bottom-sheet for one "About you" string (mirror-first Profile). Lightweight
 * RN Modal (parent mounts it only while open). Actions:
 *  - Importance stepper → nudges the linked topics' weights (guarded on empty).
 *  - Refine with Mera → opens the persona chat pre-seeded with the string.
 *  - Remove this → deletes the linked facts (chat's delete path) + the string.
 */
export const PersonaStringSheet: React.FC<PersonaStringSheetProps> = ({
    visible,
    row,
    onClose,
    onRemoved,
}) => {
    const { t } = useTranslation();
    const [busy, setBusy] = useState(false);
    const [confirmRemove, setConfirmRemove] = useState(false);
    // Linked topic ids resolved to the rows that still EXIST (+ their weights).
    // Stale ids are dropped, so the stepper only shows for live topics.
    const [resolvedTopics, setResolvedTopics] = useState<ResolvedTopic[]>([]);
    const [topicsLoaded, setTopicsLoaded] = useState(false);
    // True after a tap where the per-day nudge budget was exhausted (nothing
    // written) — surfaces the "limit reached" hint under the stepper.
    const [limitReached, setLimitReached] = useState(false);

    // Reset the two-tap confirm whenever the sheet (re)opens on a new row.
    useEffect(() => {
        if (visible) setConfirmRemove(false);
    }, [visible, row?.id]);

    // Resolve linked topic ids to existing rows on open. Missing ids drop out;
    // if none resolve we hide the stepper (avoids dead buttons on stale ids).
    useEffect(() => {
        if (!visible || !row) return;
        let cancelled = false;
        setTopicsLoaded(false);
        setLimitReached(false);
        (async () => {
            try {
                const rows = await getWeightsByIds(row.linkedTopicIds);
                if (cancelled) return;
                setResolvedTopics(rows);
                if (rows.length === 0 && row.linkedTopicIds.length > 0) {
                    logger.warn('[persona-string-sheet] no linked topics resolved', {
                        rowId: row.id,
                        linkedTopicIds: row.linkedTopicIds.length,
                    });
                }
            } catch (err) {
                if (cancelled) return;
                setResolvedTopics([]);
                logger.warn('[persona-string-sheet] resolve linked topics failed', { error: String(err) });
            } finally {
                if (!cancelled) setTopicsLoaded(true);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [visible, row?.id]);

    const hasTopics = topicsLoaded && resolvedTopics.length > 0;
    const hasFacts = (row?.linkedFactIds.length ?? 0) > 0;

    // Average resolved weight → a 0..IMPORTANCE_SEGMENTS filled-segment count.
    // Weights here are typically 0..1; negatives clamp to 0 for display.
    const filledSegments = useMemo(() => {
        if (resolvedTopics.length === 0) return 0;
        const avg = resolvedTopics.reduce((s, tp) => s + Math.max(0, tp.weight), 0) / resolvedTopics.length;
        return Math.round(Math.max(0, Math.min(1, avg)) * IMPORTANCE_SEGMENTS);
    }, [resolvedTopics]);

    const handleImportance = useCallback(
        async (direction: 1 | -1) => {
            if (!row || busy || resolvedTopics.length === 0) return;
            setBusy(true);
            setLimitReached(false);
            void hapticLight();
            let appliedAny = false;
            const next = [...resolvedTopics];
            try {
                for (let i = 0; i < next.length; i++) {
                    try {
                        const res = await nudgeTopic(next[i].id, IMPORTANCE_STEP * direction, 'user');
                        // `after` is the new weight when applied, or the unchanged
                        // weight when the budget is exhausted — safe either way.
                        next[i] = { ...next[i], weight: res.after };
                        if (res.applied) appliedAny = true;
                    } catch (err) {
                        // A stale id (deleted between open and tap) must not abort
                        // the whole loop — the other topics still get nudged.
                        logger.warn('[persona-string-sheet] topic nudge failed', {
                            topicId: next[i].id,
                            error: String(err),
                        });
                    }
                }
                setResolvedTopics(next);
                if (appliedAny) {
                    void hapticSuccess();
                    useForYouStore.getState().setFeedNeedsRefresh(true);
                } else {
                    setLimitReached(true);
                }
            } finally {
                setBusy(false);
            }
        },
        [row, busy, resolvedTopics],
    );

    const handleRefine = useCallback(() => {
        if (!row) return;
        void hapticMedium();
        const message = t('profile.sheet.refineSeed', {
            text: row.text,
            defaultValue: `Let's talk about this — "${row.text}"`,
        });
        // Persona chat, pre-seeded (auto-sent once by ChatSessionView).
        useFloatingChatStore.getState().openArticleFeedback({ kind: 'persona' }, message);
        onClose();
    }, [row, t, onClose]);

    const handleRemove = useCallback(async () => {
        if (!row || busy) return;
        if (!confirmRemove) {
            setConfirmRemove(true);
            return;
        }
        setBusy(true);
        void hapticSuccess();
        try {
            if (hasFacts) {
                await handleDeleteUserFacts({ fact_ids: row.linkedFactIds });
            }
            await deleteSummaryString(row.id);
            useForYouStore.getState().setFeedNeedsRefresh(true);
            onRemoved?.();
        } catch (err) {
            logger.warn('[persona-string-sheet] remove failed', { error: String(err) });
        } finally {
            setBusy(false);
            onClose();
        }
    }, [row, busy, confirmRemove, hasFacts, onRemoved, onClose]);

    if (!visible || !row) return null;

    return (
        <Modal visible transparent animationType="fade" onRequestClose={onClose} statusBarTranslucent>
            <Pressable
                accessibilityLabel={t('common.cancel')}
                onPress={onClose}
                style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.72)', justifyContent: 'flex-end' }}
            >
                <Pressable onPress={() => {}} style={{ width: '100%' }}>
                    <Box
                        className="rounded-t-3xl px-4 pb-8 pt-4"
                        style={{ backgroundColor: '#151515', borderTopColor: '#2a2a2a', borderTopWidth: 1 }}
                    >
                        {/* The string itself */}
                        <TranslatableDynamic
                            text={row.text}
                            as="heading"
                            size="lg"
                            className="text-white"
                            style={{ marginBottom: 16 }}
                        />

                        {/* Importance stepper + visual level meter */}
                        {hasTopics ? (
                            <>
                                <HStack className="items-center justify-between mb-2 px-2 py-2 rounded-2xl" style={{ backgroundColor: '#1f1f1f' }}>
                                    <Text className="text-gray-300" style={{ fontSize: 15 }}>
                                        {t('profile.sheet.importance', { defaultValue: 'Importance' })}
                                    </Text>
                                    <HStack space="md" className="items-center">
                                        <Pressable
                                            accessibilityRole="button"
                                            accessibilityLabel={t('profile.sheet.lessImportant', { defaultValue: 'Less important' })}
                                            disabled={busy}
                                            onPress={() => handleImportance(-1)}
                                            className="rounded-full p-1"
                                        >
                                            <MaterialIcons name="remove-circle-outline" size={30} color={busy ? '#555' : ACCENT} />
                                        </Pressable>
                                        {/* 5-segment level: filled = avg resolved weight */}
                                        <HStack
                                            space="xs"
                                            className="items-center"
                                            accessibilityLabel={t('profile.sheet.importanceLevel', {
                                                level: filledSegments,
                                                total: IMPORTANCE_SEGMENTS,
                                                defaultValue: 'Importance level {{level}} of {{total}}',
                                            })}
                                        >
                                            {Array.from({ length: IMPORTANCE_SEGMENTS }).map((_, i) => (
                                                <Box
                                                    key={i}
                                                    style={{
                                                        width: 8,
                                                        height: 8,
                                                        borderRadius: 4,
                                                        backgroundColor: i < filledSegments ? ACCENT : '#3a3a3a',
                                                    }}
                                                />
                                            ))}
                                        </HStack>
                                        <Pressable
                                            accessibilityRole="button"
                                            accessibilityLabel={t('profile.sheet.moreImportant', { defaultValue: 'More important' })}
                                            disabled={busy}
                                            onPress={() => handleImportance(1)}
                                            className="rounded-full p-1"
                                        >
                                            <MaterialIcons name="add-circle-outline" size={30} color={busy ? '#555' : ACCENT} />
                                        </Pressable>
                                    </HStack>
                                </HStack>
                                {limitReached ? (
                                    <Text className="text-gray-500 mb-2 px-2" style={{ fontSize: 12 }}>
                                        {t('profile.sheet.limitReached', {
                                            defaultValue: 'Daily adjustment limit reached — changes continue tomorrow.',
                                        })}
                                    </Text>
                                ) : null}
                            </>
                        ) : null}

                        {/* Refine with Mera */}
                        <Pressable
                            accessibilityRole="button"
                            accessibilityLabel={t('profile.sheet.refine', { defaultValue: 'Refine with Mera' })}
                            onPress={handleRefine}
                            className="rounded-2xl"
                        >
                            <HStack className="items-center px-2 py-3" space="md">
                                <MaterialIcons name="chat-bubble-outline" size={22} color={ACCENT} />
                                <Text className="flex-1 text-white" style={{ fontSize: 15, fontWeight: '600' }}>
                                    {t('profile.sheet.refine', { defaultValue: 'Refine with Mera' })}
                                </Text>
                            </HStack>
                        </Pressable>

                        {/* Remove this (two-tap confirm) */}
                        <Pressable
                            accessibilityRole="button"
                            accessibilityLabel={t('profile.sheet.remove', { defaultValue: 'Remove this' })}
                            disabled={busy}
                            onPress={handleRemove}
                            className="rounded-2xl"
                        >
                            <HStack className="items-center px-2 py-3" space="md">
                                <MaterialIcons name="delete-outline" size={22} color="#f87171" />
                                <Text className="flex-1" style={{ fontSize: 15, fontWeight: '600', color: '#f87171' }}>
                                    {confirmRemove
                                        ? t('profile.sheet.removeConfirm', { defaultValue: 'Tap again to remove' })
                                        : t('profile.sheet.remove', { defaultValue: 'Remove this' })}
                                </Text>
                            </HStack>
                        </Pressable>
                    </Box>
                </Pressable>
            </Pressable>
        </Modal>
    );
};

export default PersonaStringSheet;
