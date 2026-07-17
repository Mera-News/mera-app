import DrillDownHeader from '@/components/custom/config-panel/DrillDownHeader';
import TranslatableDynamic from '@/components/custom/TranslatableDynamic';
import { Box } from '@/components/ui/box';
import { Button, ButtonText } from '@/components/ui/button';
import { HStack } from '@/components/ui/hstack';
import { Spinner } from '@/components/ui/spinner';
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import {
    acceptProposal,
    getPendingProposals,
    rejectProposal,
    subscribeHygieneChange,
} from '@/lib/database/services/hygiene-service';
import { hapticLight } from '@/lib/haptics';
import logger from '@/lib/logger';
import { toastManager } from '@/lib/toast-manager';
import type {
    HygieneProposal,
    HygieneProposalKind,
} from '@/lib/news-harness/persona-management/fact-hygiene';
import { MaterialIcons } from '@expo/vector-icons';
import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { FlatList, View } from 'react-native';

const ACCENT = '#EDA77E';
const SUBTLE = 'rgb(163,163,163)';

interface HygieneReviewScreenProps {
    readonly onBack: () => void;
}

type GlyphName = keyof typeof MaterialIcons.glyphMap;

/** Leading icon per proposal kind. */
function iconForKind(kind: HygieneProposalKind): GlyphName {
    switch (kind) {
        case 'duplicate_facts':
            return 'content-copy';
        case 'too_broad_fact':
            return 'zoom-out-map';
        case 'stale_topic':
            return 'history-toggle-off';
        case 'stale_fact':
            return 'delete-sweep';
        default:
            return 'cleaning-services';
    }
}

/** The one-line "what happens if you accept" preview per kind. */
function effectPreview(kind: HygieneProposalKind, t: TFunction): string {
    switch (kind) {
        case 'duplicate_facts':
            return t('hygiene.effectDuplicate', {
                defaultValue: 'Removes the duplicate and keeps the stronger one.',
            });
        case 'too_broad_fact':
            return t('hygiene.effectTooBroad', {
                defaultValue: 'Lowers this interest’s weight so it pulls in fewer off-topic stories.',
            });
        case 'stale_topic':
            return t('hygiene.effectStaleTopic', {
                defaultValue: 'Retires this quiet topic. You can restore it from the change log.',
            });
        case 'stale_fact':
            return t('hygiene.effectStaleFact', {
                defaultValue: 'Removes this fact — none of its topics are active anymore.',
            });
        default:
            return '';
    }
}

const HygieneReviewScreen: React.FC<HygieneReviewScreenProps> = ({ onBack }) => {
    const { t } = useTranslation();
    const [items, setItems] = useState<HygieneProposal[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [actingId, setActingId] = useState<string | null>(null);

    const load = useCallback(async () => {
        try {
            const proposals = await getPendingProposals();
            setItems(proposals);
        } catch (error) {
            logger.captureException(error, {
                tags: { component: 'HygieneReviewScreen', method: 'load' },
            });
        } finally {
            setIsLoading(false);
        }
    }, []);

    useEffect(() => {
        void load();
        const unsubscribe = subscribeHygieneChange(() => void load());
        return unsubscribe;
    }, [load]);

    const handleAccept = useCallback(
        async (proposal: HygieneProposal) => {
            if (actingId) return;
            setActingId(proposal.id);
            void hapticLight();
            // Optimistic: drop the card immediately.
            setItems((prev) => prev.filter((p) => p.id !== proposal.id));
            try {
                const res = await acceptProposal(proposal.id);
                if (res.applied && res.ok) {
                    toastManager.showSuccess(
                        t('hygiene.appliedTitle', { defaultValue: 'Cleanup applied' }),
                        t('hygiene.appliedBody', {
                            defaultValue: 'Your profile was tidied up. See the change log to review.',
                        }),
                    );
                } else {
                    toastManager.showError(
                        t('hygiene.applyFailedTitle', { defaultValue: 'Couldn’t apply cleanup' }),
                        t('hygiene.applyFailedBody', { defaultValue: 'Please try again later.' }),
                    );
                    void load(); // restore truth from storage
                }
            } catch (error) {
                logger.captureException(error, {
                    tags: { component: 'HygieneReviewScreen', method: 'accept', kind: proposal.kind },
                });
                void load();
            } finally {
                setActingId(null);
            }
        },
        [actingId, t, load],
    );

    const handleReject = useCallback(
        async (proposal: HygieneProposal) => {
            if (actingId) return;
            setActingId(proposal.id);
            void hapticLight();
            setItems((prev) => prev.filter((p) => p.id !== proposal.id));
            try {
                await rejectProposal(proposal.id);
            } catch (error) {
                logger.captureException(error, {
                    tags: { component: 'HygieneReviewScreen', method: 'reject', kind: proposal.kind },
                });
                void load();
            } finally {
                setActingId(null);
            }
        },
        [actingId, load],
    );

    const renderItem = useCallback(
        ({ item }: { item: HygieneProposal }) => {
            const inFlight = actingId === item.id;
            return (
                <Box className="mx-4 mb-3 border border-gray-700 rounded-lg overflow-hidden">
                    <HStack className="px-4 pt-4 pb-2 items-start">
                        <MaterialIcons
                            name={iconForKind(item.kind)}
                            size={22}
                            color={ACCENT}
                            style={{ marginTop: 2 }}
                        />
                        <VStack className="flex-1 ml-3" space="xs">
                            <TranslatableDynamic
                                text={item.summary}
                                size="md"
                                className="text-white"
                                numberOfLines={4}
                            />
                            <Text className="text-sm" style={{ color: SUBTLE }} numberOfLines={3}>
                                {effectPreview(item.kind, t)}
                            </Text>
                            {item.invertible ? (
                                <HStack className="items-center" space="xs">
                                    <MaterialIcons name="undo" size={13} color="#6b7280" />
                                    <Text className="text-xs text-gray-500">
                                        {t('hygiene.reversibleNote', {
                                            defaultValue: 'Reversible from the change log',
                                        })}
                                    </Text>
                                </HStack>
                            ) : null}
                        </VStack>
                    </HStack>
                    <HStack className="px-4 pb-4 pt-1" space="sm">
                        <Button
                            action="primary"
                            size="sm"
                            className="flex-1"
                            onPress={() => handleAccept(item)}
                            disabled={inFlight}
                        >
                            {inFlight ? (
                                <Spinner size="small" />
                            ) : (
                                <ButtonText>
                                    {t('hygiene.accept', { defaultValue: 'Accept' })}
                                </ButtonText>
                            )}
                        </Button>
                        <Button
                            variant="outline"
                            action="secondary"
                            size="sm"
                            className="flex-1"
                            onPress={() => handleReject(item)}
                            disabled={inFlight}
                        >
                            <ButtonText>
                                {t('hygiene.reject', { defaultValue: 'Dismiss' })}
                            </ButtonText>
                        </Button>
                    </HStack>
                </Box>
            );
        },
        [actingId, handleAccept, handleReject, t],
    );

    return (
        <Box className="flex-1 bg-black">
            <DrillDownHeader
                title={t('hygiene.title', { defaultValue: 'Persona health' })}
                subtitle={t('hygiene.subtitle', { defaultValue: 'Suggested cleanups' })}
                onBack={onBack}
            />
            {isLoading ? (
                <Box className="flex-1 items-center justify-center">
                    <Spinner size="large" />
                </Box>
            ) : items.length === 0 ? (
                <VStack className="flex-1 items-center justify-center px-8" space="md">
                    <MaterialIcons name="cleaning-services" size={56} color="#666666" />
                    <Text size="md" className="text-gray-400 text-center">
                        {t('hygiene.empty', { defaultValue: 'Your persona looks healthy' })}
                    </Text>
                </VStack>
            ) : (
                <FlatList
                    data={items}
                    keyExtractor={(item) => item.id}
                    renderItem={renderItem}
                    contentContainerStyle={{ paddingTop: 12, paddingBottom: 48 }}
                    showsVerticalScrollIndicator={false}
                    ListHeaderComponent={
                        <View className="px-4 pb-2">
                            <Text className="text-sm" style={{ color: SUBTLE }}>
                                {t('hygiene.intro', {
                                    defaultValue:
                                        'Mera found a few things worth tidying up. Accept the ones you agree with.',
                                })}
                            </Text>
                        </View>
                    }
                />
            )}
        </Box>
    );
};

export default HygieneReviewScreen;
