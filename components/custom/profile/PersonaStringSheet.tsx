import { Box } from '@/components/ui/box';
import { HStack } from '@/components/ui/hstack';
import { Pressable } from '@/components/ui/pressable';
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import TranslatableDynamic from '@/components/custom/TranslatableDynamic';
import { applyPersonaAction } from '@/lib/database/services/persona-action-executor';
import { ACTION_NAMES } from '@/lib/news-harness/persona-management/action-names';
import { deleteSummaryString, type PersonaSummaryStringRow } from '@/lib/database/services/persona-summary-service';
import { handleDeleteUserFacts } from '@/lib/chat-tools/tool-handlers';
import { hapticLight, hapticMedium, hapticSuccess } from '@/lib/haptics';
import logger from '@/lib/logger';
import { useFloatingChatStore } from '@/lib/stores/floating-chat-store';
import { useForYouStore } from '@/lib/stores/for-you-store';
import { MaterialIcons } from '@expo/vector-icons';
import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Modal } from 'react-native';

const ACCENT = '#EDA77E';

/** Per-tap weight nudge applied to every topic behind a string (leashed by the
 *  mutation-rails budget). Small so the stepper is a gentle "more/less". */
const IMPORTANCE_STEP = 0.05;

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

    // Reset the two-tap confirm whenever the sheet (re)opens on a new row.
    useEffect(() => {
        if (visible) setConfirmRemove(false);
    }, [visible, row?.id]);

    const hasTopics = (row?.linkedTopicIds.length ?? 0) > 0;
    const hasFacts = (row?.linkedFactIds.length ?? 0) > 0;

    const handleImportance = useCallback(
        async (direction: 1 | -1) => {
            if (!row || busy || !hasTopics) return;
            setBusy(true);
            void hapticLight();
            try {
                for (const topicId of row.linkedTopicIds) {
                    await applyPersonaAction(
                        {
                            action_type: ACTION_NAMES.SET_TOPIC_WEIGHT,
                            topicId,
                            delta: IMPORTANCE_STEP * direction,
                        },
                        'user',
                    );
                }
                useForYouStore.getState().setFeedNeedsRefresh(true);
            } catch (err) {
                logger.warn('[persona-string-sheet] importance nudge failed', { error: String(err) });
            } finally {
                setBusy(false);
            }
        },
        [row, busy, hasTopics],
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

                        {/* Importance stepper */}
                        {hasTopics ? (
                            <HStack className="items-center justify-between mb-2 px-2 py-2 rounded-2xl" style={{ backgroundColor: '#1f1f1f' }}>
                                <Text className="text-gray-300" style={{ fontSize: 15 }}>
                                    {t('profile.sheet.importance', { defaultValue: 'Importance' })}
                                </Text>
                                <HStack space="lg" className="items-center">
                                    <Pressable
                                        accessibilityRole="button"
                                        accessibilityLabel={t('profile.sheet.lessImportant', { defaultValue: 'Less important' })}
                                        disabled={busy}
                                        onPress={() => handleImportance(-1)}
                                        className="rounded-full p-1"
                                    >
                                        <MaterialIcons name="remove-circle-outline" size={30} color={busy ? '#555' : ACCENT} />
                                    </Pressable>
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
