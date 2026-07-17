import DrillDownHeader from '@/components/custom/config-panel/DrillDownHeader';
import TranslatableDynamic from '@/components/custom/TranslatableDynamic';
import { Box } from '@/components/ui/box';
import { Button, ButtonText } from '@/components/ui/button';
import { HStack } from '@/components/ui/hstack';
import { Modal, ModalBackdrop, ModalBody, ModalContent, ModalFooter, ModalHeader } from '@/components/ui/modal';
import { Pressable } from '@/components/ui/pressable';
import { Spinner } from '@/components/ui/spinner';
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import type PersonaChangeLogModel from '@/lib/database/models/PersonaChangeLog';
import {
    observeRecent,
    revertChange,
} from '@/lib/database/services/persona-change-log-service';
import { hapticLight } from '@/lib/haptics';
import logger from '@/lib/logger';
import { toastManager } from '@/lib/toast-manager';
import { MaterialIcons } from '@expo/vector-icons';
import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { FlatList, View } from 'react-native';
import { actionDisplay, isRevertible, sourceLabelKey } from './action-display';

const ACCENT = '#EDA77E';
const MUTED = 'rgb(115,115,115)';
const SUBTLE = 'rgb(163,163,163)';

interface PersonaAuditScreenProps {
    readonly onBack: () => void;
}

/** "Just now" / "Nm ago" / "Nh ago" / "Nd ago" via shared feed.* i18n keys. */
function formatRelativeAgo(timestamp: number, t: TFunction): string {
    const diffMs = Date.now() - timestamp;
    const mins = Math.max(0, Math.floor(diffMs / 60000));
    if (mins < 1) return t('feed.justNow');
    if (mins < 60) return t('feed.minutesAgo', { count: mins });
    const hours = Math.floor(mins / 60);
    if (hours < 24) return t('feed.hoursAgo', { count: hours });
    const days = Math.floor(hours / 24);
    return t('feed.daysAgo', { count: days });
}

const PersonaAuditScreen: React.FC<PersonaAuditScreenProps> = ({ onBack }) => {
    const { t } = useTranslation();
    const [items, setItems] = useState<PersonaChangeLogModel[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [confirmRow, setConfirmRow] = useState<PersonaChangeLogModel | null>(null);
    const [revertingId, setRevertingId] = useState<string | null>(null);

    // Reactive newest-first log. revertChange flips `reverted` and appends a
    // `revert_change` row, both of which arrive through this same subscription —
    // no manual optimistic bookkeeping needed.
    useEffect(() => {
        const sub = observeRecent(100).subscribe((rows) => {
            setItems(rows);
            setIsLoading(false);
        });
        return () => sub.unsubscribe();
    }, []);

    const handleRevertConfirm = useCallback(async () => {
        const row = confirmRow;
        if (!row) return;
        setConfirmRow(null);
        setRevertingId(row.id);
        void hapticLight();
        try {
            await revertChange(row.id);
            toastManager.showSuccess(
                t('personaAudit.revertSuccessTitle'),
                t('personaAudit.revertSuccessBody'),
            );
        } catch (error) {
            // revertChange throws for action types with no inverse yet, or if the
            // target row is gone. Surface it; the list is unchanged (reactive).
            logger.captureException(error, {
                tags: { component: 'PersonaAuditScreen', method: 'revertChange' },
                extra: { changeLogId: row.id, actionType: row.actionType },
            });
            toastManager.showError(
                t('personaAudit.revertFailedTitle'),
                t('personaAudit.revertFailedBody'),
            );
        } finally {
            setRevertingId(null);
        }
    }, [confirmRow, t]);

    const renderItem = useCallback(
        ({ item }: { item: PersonaChangeLogModel }) => {
            const display = actionDisplay(item.actionType);
            const reverted = item.reverted;
            const canRevert = !reverted && isRevertible(item.actionType);
            const inFlight = revertingId === item.id;
            const iconColor = reverted ? MUTED : ACCENT;

            return (
                <View className="flex-row px-4 py-3 border-b border-gray-800">
                    <MaterialIcons
                        name={display.icon}
                        size={22}
                        color={iconColor}
                        style={{ marginTop: 2 }}
                    />
                    <VStack className="flex-1 ml-3" space="xs">
                        <HStack className="items-start justify-between">
                            <TranslatableDynamic
                                text={item.summary || t(`personaAudit.actionLabels.${display.labelKey}` as never)}
                                size="md"
                                className={reverted ? 'text-gray-500 flex-1 line-through' : 'text-white flex-1'}
                                numberOfLines={3}
                            />
                            {canRevert ? (
                                inFlight ? (
                                    <Spinner size="small" style={{ marginLeft: 8 }} />
                                ) : (
                                    <Pressable
                                        onPress={() => setConfirmRow(item)}
                                        hitSlop={8}
                                        accessibilityRole="button"
                                        accessibilityLabel={t('personaAudit.revert')}
                                        className="flex-row items-center border border-gray-700 rounded-full px-3 py-1 ml-2"
                                    >
                                        <MaterialIcons name="undo" size={14} color={ACCENT} />
                                        <Text className="text-xs ml-1" style={{ color: ACCENT }}>
                                            {t('personaAudit.revert')}
                                        </Text>
                                    </Pressable>
                                )
                            ) : null}
                        </HStack>
                        <HStack className="items-center flex-wrap" space="xs">
                            <View className="border border-gray-700 rounded-full px-2 py-0.5">
                                <Text className="text-xs" style={{ color: SUBTLE }}>
                                    {t(`personaAudit.sources.${sourceLabelKey(item.source)}` as never)}
                                </Text>
                            </View>
                            {reverted ? (
                                <View className="flex-row items-center bg-gray-800 rounded-full px-2 py-0.5">
                                    <MaterialIcons name="undo" size={12} color={MUTED} />
                                    <Text className="text-xs ml-1" style={{ color: MUTED }}>
                                        {t('personaAudit.revertedBadge')}
                                    </Text>
                                </View>
                            ) : null}
                            <Text className="text-xs" style={{ color: MUTED }}>
                                {formatRelativeAgo(item.createdAt.getTime(), t)}
                            </Text>
                        </HStack>
                    </VStack>
                </View>
            );
        },
        [revertingId, t],
    );

    return (
        <Box className="flex-1 bg-black">
            <DrillDownHeader
                title={t('personaAudit.title')}
                subtitle={t('personaAudit.subtitle')}
                onBack={onBack}
            />
            {isLoading ? (
                <Box className="flex-1 items-center justify-center">
                    <Spinner size="large" />
                </Box>
            ) : items.length === 0 ? (
                <VStack className="flex-1 items-center justify-center px-8" space="md">
                    <MaterialIcons name="history" size={56} color="#666666" />
                    <Text size="md" className="text-gray-400 text-center">
                        {t('personaAudit.empty')}
                    </Text>
                </VStack>
            ) : (
                <FlatList
                    data={items}
                    keyExtractor={(item) => item.id}
                    renderItem={renderItem}
                    contentContainerStyle={{ paddingBottom: 48 }}
                    showsVerticalScrollIndicator={false}
                />
            )}

            <Modal isOpen={confirmRow !== null} onClose={() => setConfirmRow(null)} size="sm">
                <ModalBackdrop />
                <ModalContent>
                    <ModalHeader className="pb-3">
                        <HStack className="items-center" space="xs">
                            <MaterialIcons name="undo" size={18} color={ACCENT} />
                            <Text className="text-base font-semibold text-white">
                                {t('personaAudit.revertConfirmTitle')}
                            </Text>
                        </HStack>
                    </ModalHeader>
                    <ModalBody className="py-4">
                        <Text className="text-gray-300 text-sm leading-relaxed mb-3">
                            {t('personaAudit.revertConfirmBody')}
                        </Text>
                        {confirmRow ? (
                            <TranslatableDynamic
                                text={confirmRow.summary}
                                size="sm"
                                className="text-white font-medium"
                                numberOfLines={3}
                            />
                        ) : null}
                    </ModalBody>
                    <ModalFooter className="border-t border-gray-700 pt-4">
                        <VStack className="w-full" space="md">
                            <Button onPress={handleRevertConfirm} className="w-full">
                                <ButtonText>{t('personaAudit.revertConfirmCta')}</ButtonText>
                            </Button>
                            <Button
                                variant="outline"
                                action="secondary"
                                onPress={() => setConfirmRow(null)}
                                className="w-full"
                            >
                                <ButtonText>{t('common.cancel')}</ButtonText>
                            </Button>
                        </VStack>
                    </ModalFooter>
                </ModalContent>
            </Modal>
        </Box>
    );
};

export default PersonaAuditScreen;
