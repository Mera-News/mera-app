import DrillDownHeader from '@/components/custom/config-panel/DrillDownHeader';
import { Box } from '@/components/ui/box';
import { Button, ButtonText } from '@/components/ui/button';
import { HStack } from '@/components/ui/hstack';
import {
    Modal,
    ModalBackdrop,
    ModalBody,
    ModalContent,
    ModalFooter,
    ModalHeader,
} from '@/components/ui/modal';
import { Pressable } from '@/components/ui/pressable';
import { Spinner } from '@/components/ui/spinner';
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import type PersonaSuppressionModel from '@/lib/database/models/PersonaSuppression';
import type TopicModel from '@/lib/database/models/Topic';
import { applyPersonaAction } from '@/lib/database/services/persona-action-executor';
import { weightToPrefKind } from '@/lib/database/services/publication-preference-service';
import { HARD_SUPPRESSION_STRENGTH } from '@/lib/database/services/suppression-service';
import { hapticLight } from '@/lib/haptics';
import logger from '@/lib/logger';
import { ACTION_NAMES } from '@/lib/news-harness/persona-management/action-names';
import { toastManager } from '@/lib/toast-manager';
import { MaterialIcons } from '@expo/vector-icons';
import { router } from 'expo-router';
import React, { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ScrollView, View } from 'react-native';
import AddPhraseModal from './AddPhraseModal';
import NegativeTopicRow from './NegativeTopicRow';
import SuppressionRow from './SuppressionRow';
import { useNotInterestedData } from './use-not-interested-data';

const ACCENT = '#EDA77E';
const SUBTLE = 'rgb(163,163,163)';

type SectionSlug = 'filters' | 'topics' | 'sources';

/** What the confirm modal is about to remove. */
type PendingRemoval =
    | { readonly kind: 'filter'; readonly row: PersonaSuppressionModel }
    | { readonly kind: 'topic'; readonly row: TopicModel };

interface AccordionSectionProps {
    readonly slug: SectionSlug;
    readonly title: string;
    readonly count: number;
    readonly isExpanded: boolean;
    readonly onToggle: (slug: SectionSlug) => void;
    readonly children: React.ReactNode;
}

/** A collapsed-by-default disclosure: title, count, chevron. Children only
 *  mount while open, so a long filter list costs nothing on first paint. */
const AccordionSection: React.FC<AccordionSectionProps> = ({
    slug,
    title,
    count,
    isExpanded,
    onToggle,
    children,
}) => (
    <View className="mb-2">
        <Pressable
            testID={`not-interested-section-${slug}`}
            onPress={() => onToggle(slug)}
            accessibilityRole="button"
            accessibilityLabel={title}
            accessibilityState={{ expanded: isExpanded }}
            className="flex-row items-center px-4 py-3 border-b border-gray-800"
        >
            <Text size="md" className="text-white flex-1 mr-2">
                {title}
            </Text>
            <View
                testID={`not-interested-section-${slug}-count`}
                className="rounded-full px-2 py-0.5 mr-1 bg-gray-700"
            >
                <Text size="xs" style={{ color: SUBTLE }}>
                    {count}
                </Text>
            </View>
            <MaterialIcons
                name={isExpanded ? 'expand-less' : 'expand-more'}
                size={20}
                color="#9ca3af"
            />
        </Pressable>
        {isExpanded ? <View>{children}</View> : null}
    </View>
);

interface NotInterestedScreenProps {
    readonly onBack: () => void;
}

/**
 * Everything the user has asked Mera to keep out of the feed, in one place:
 * hand- and agent-made filters, topics pushed below zero, and muted/downranked
 * sources. Three collapsed sections with counts — nothing is a wall of pills
 * until you ask for it. Removal routes through the persona-action executor, so
 * it is audited, revertible, and runs its own retroactive sweep.
 */
const NotInterestedScreen: React.FC<NotInterestedScreenProps> = ({ onBack }) => {
    const { t } = useTranslation();
    const { filters, topics, mutedSources, total, isLoading } = useNotInterestedData();

    const [expandedSections, setExpandedSections] = useState<readonly SectionSlug[]>([]);
    const [expandedRowId, setExpandedRowId] = useState<string | null>(null);
    const [pending, setPending] = useState<PendingRemoval | null>(null);
    const [busyId, setBusyId] = useState<string | null>(null);
    const [isAdding, setIsAdding] = useState(false);

    const toggleSection = useCallback((slug: SectionSlug) => {
        setExpandedSections(prev =>
            prev.includes(slug) ? prev.filter(s => s !== slug) : [...prev, slug],
        );
    }, []);

    // One open row at a time — keeps the detail block a single, unambiguous
    // element for the harness and keeps the page short.
    const toggleRow = useCallback((id: string) => {
        setExpandedRowId(prev => (prev === id ? null : id));
    }, []);

    const handleRemoveConfirm = useCallback(async () => {
        const target = pending;
        if (!target) return;
        setPending(null);
        setBusyId(target.row.id);
        void hapticLight();
        try {
            // The executor NEVER throws — an incomplete or unknown action comes
            // back `{ applied: false }`. Branching on the return is the only way
            // to avoid a green toast over a no-op.
            const result = await applyPersonaAction(
                target.kind === 'filter'
                    ? {
                          action_type: ACTION_NAMES.RETIRE_SUPPRESSION,
                          suppressionId: target.row.id,
                      }
                    : { action_type: ACTION_NAMES.RETIRE_TOPIC, topicId: target.row.id },
                'user',
            );
            if (result.applied) {
                setExpandedRowId(null);
                toastManager.showSuccess(
                    t('notInterested.removeSuccessTitle'),
                    t('notInterested.removeSuccessBody'),
                );
            } else {
                logger.warn('[not-interested] removal skipped', {
                    kind: target.kind,
                    id: target.row.id,
                    summary: result.summary,
                });
                toastManager.showError(
                    t('notInterested.removeFailedTitle'),
                    t('notInterested.removeFailedBody'),
                );
            }
        } catch (error) {
            logger.captureException(error, {
                tags: { component: 'NotInterestedScreen', method: 'remove' },
                extra: { kind: target.kind, id: target.row.id },
            });
            toastManager.showError(
                t('notInterested.removeFailedTitle'),
                t('notInterested.removeFailedBody'),
            );
        } finally {
            setBusyId(null);
        }
    }, [pending, t]);

    const handleAddPhrase = useCallback(
        async (phrase: string, hard: boolean) => {
            try {
                const result = await applyPersonaAction(
                    {
                        action_type: ACTION_NAMES.ADD_SUPPRESSION,
                        suppressionPattern: phrase,
                        suppressionKeywords: [phrase],
                        // Omitted ⇒ the executor's 0.5 soft default (+30d TTL).
                        suppressionStrength: hard ? HARD_SUPPRESSION_STRENGTH : undefined,
                    },
                    'user',
                );
                if (!result.applied) {
                    logger.warn('[not-interested] add skipped', { summary: result.summary });
                    toastManager.showError(
                        t('notInterested.addPhraseFailedTitle'),
                        t('notInterested.addPhraseFailedBody'),
                    );
                    return;
                }
                setIsAdding(false);
                setExpandedSections(prev =>
                    prev.includes('filters') ? prev : [...prev, 'filters'],
                );
                toastManager.showSuccess(
                    t('notInterested.addPhraseSuccessTitle'),
                    hard
                        ? t('notInterested.addPhraseSuccessBodyBlocked', { phrase })
                        : t('notInterested.addPhraseSuccessBodySoft', { phrase }),
                );
            } catch (error) {
                logger.captureException(error, {
                    tags: { component: 'NotInterestedScreen', method: 'addPhrase' },
                });
                toastManager.showError(
                    t('notInterested.addPhraseFailedTitle'),
                    t('notInterested.addPhraseFailedBody'),
                );
            }
        },
        [t],
    );

    const chatHint = (
        <HStack className="mx-4 mt-4 items-start" space="xs">
            <MaterialIcons name="auto-awesome" size={14} color="#93c5fd" style={{ marginTop: 2 }} />
            <Text size="xs" className="text-gray-400 flex-1 leading-relaxed">
                {t('notInterested.chatHint')}
            </Text>
        </HStack>
    );

    return (
        <Box testID="not-interested-screen" className="flex-1 bg-black">
            <DrillDownHeader
                title={t('notInterested.title')}
                subtitle={t('notInterested.subtitle')}
                onBack={onBack}
                rightAction={
                    <Pressable
                        testID="not-interested-add-phrase"
                        onPress={() => setIsAdding(true)}
                        hitSlop={8}
                        accessibilityRole="button"
                        accessibilityLabel={t('notInterested.addPhrase')}
                        className="p-1"
                    >
                        <MaterialIcons name="add" size={22} color={ACCENT} />
                    </Pressable>
                }
            />

            {isLoading ? (
                <Box className="flex-1 items-center justify-center">
                    <Spinner size="large" />
                </Box>
            ) : total === 0 ? (
                <VStack
                    testID="not-interested-empty"
                    className="flex-1 items-center justify-center px-8"
                    space="md"
                >
                    <MaterialIcons name="visibility-off" size={56} color="#666666" />
                    <Text size="md" className="text-gray-300 text-center">
                        {t('notInterested.emptyTitle')}
                    </Text>
                    <Text size="sm" className="text-gray-500 text-center">
                        {t('notInterested.emptyBody')}
                    </Text>
                    {chatHint}
                </VStack>
            ) : (
                <ScrollView
                    showsVerticalScrollIndicator={false}
                    contentContainerStyle={{ paddingTop: 8, paddingBottom: 64 }}
                >
                    <AccordionSection
                        slug="filters"
                        title={t('notInterested.sectionFilters')}
                        count={filters.length}
                        isExpanded={expandedSections.includes('filters')}
                        onToggle={toggleSection}
                    >
                        {filters.length === 0 ? (
                            <Text size="sm" className="text-gray-500 px-4 py-3">
                                {t('notInterested.emptyFilters')}
                            </Text>
                        ) : (
                            filters.map(s => (
                                <SuppressionRow
                                    key={s.id}
                                    suppression={s}
                                    isExpanded={expandedRowId === s.id}
                                    busy={busyId === s.id}
                                    onToggle={toggleRow}
                                    onRemove={row => setPending({ kind: 'filter', row })}
                                />
                            ))
                        )}
                    </AccordionSection>

                    <AccordionSection
                        slug="topics"
                        title={t('notInterested.sectionTopics')}
                        count={topics.length}
                        isExpanded={expandedSections.includes('topics')}
                        onToggle={toggleSection}
                    >
                        {topics.length === 0 ? (
                            <Text size="sm" className="text-gray-500 px-4 py-3">
                                {t('notInterested.emptyTopics')}
                            </Text>
                        ) : (
                            topics.map(topic => (
                                <NegativeTopicRow
                                    key={topic.id}
                                    topic={topic}
                                    isExpanded={expandedRowId === topic.id}
                                    busy={busyId === topic.id}
                                    onToggle={toggleRow}
                                    onRemove={row => setPending({ kind: 'topic', row })}
                                />
                            ))
                        )}
                    </AccordionSection>

                    <AccordionSection
                        slug="sources"
                        title={t('notInterested.sectionSources')}
                        count={mutedSources.length}
                        isExpanded={expandedSections.includes('sources')}
                        onToggle={toggleSection}
                    >
                        {mutedSources.length === 0 ? (
                            <Text size="sm" className="text-gray-500 px-4 py-3">
                                {t('notInterested.emptySources')}
                            </Text>
                        ) : (
                            mutedSources.map(pref => {
                                const isMuted = weightToPrefKind(pref.weight) === 'mute';
                                return (
                                    <View
                                        key={pref.id}
                                        testID={`not-interested-row-${pref.id}`}
                                        className="px-4 py-3 border-b border-gray-800"
                                    >
                                        <HStack className="items-center">
                                            <MaterialIcons
                                                name={isMuted ? 'volume-off' : 'trending-down'}
                                                size={18}
                                                color={ACCENT}
                                            />
                                            <Text
                                                size="md"
                                                className="text-white flex-1 ml-3 mr-2 capitalize"
                                                numberOfLines={2}
                                            >
                                                {pref.publicationName}
                                            </Text>
                                            <View className="rounded-full px-2 py-0.5 bg-gray-700">
                                                <Text size="xs" style={{ color: SUBTLE }}>
                                                    {isMuted
                                                        ? t('notInterested.badgeMutedPub')
                                                        : t('notInterested.badgeDownranked')}
                                                </Text>
                                            </View>
                                        </HStack>
                                        {isMuted ? (
                                            <Text size="xs" className="text-gray-500 mt-1 ml-8">
                                                {t('notInterested.mutedPubHint')}
                                            </Text>
                                        ) : null}
                                    </View>
                                );
                            })
                        )}
                        <Pressable
                            testID="not-interested-manage-sources"
                            onPress={() => router.push('/logged-in/publication-preferences')}
                            accessibilityRole="button"
                            accessibilityLabel={t('notInterested.managePublications')}
                            className="flex-row items-center px-4 py-3"
                        >
                            <MaterialIcons name="tune" size={16} color="#60a5fa" />
                            <Text size="sm" className="text-blue-400 ml-2">
                                {t('notInterested.managePublications')}
                            </Text>
                        </Pressable>
                    </AccordionSection>

                    {chatHint}
                </ScrollView>
            )}

            <AddPhraseModal
                isOpen={isAdding}
                onClose={() => setIsAdding(false)}
                onSubmit={handleAddPhrase}
            />

            <Modal isOpen={pending !== null} onClose={() => setPending(null)} size="sm">
                <ModalBackdrop />
                <ModalContent>
                    <ModalHeader className="pb-3">
                        <HStack className="items-center" space="xs">
                            <MaterialIcons name="visibility" size={18} color={ACCENT} />
                            <Text className="text-base font-semibold text-white">
                                {t('notInterested.removeConfirmTitle')}
                            </Text>
                        </HStack>
                    </ModalHeader>
                    <ModalBody className="py-4">
                        <Text className="text-gray-300 text-sm leading-relaxed">
                            {t('notInterested.removeConfirmBody')}
                        </Text>
                    </ModalBody>
                    <ModalFooter className="border-t border-gray-700 pt-4">
                        <VStack className="w-full" space="md">
                            <Button
                                testID="not-interested-remove-confirm"
                                onPress={handleRemoveConfirm}
                                className="w-full"
                            >
                                <ButtonText>{t('notInterested.removeConfirmCta')}</ButtonText>
                            </Button>
                            <Button
                                testID="not-interested-remove-cancel"
                                variant="outline"
                                action="secondary"
                                onPress={() => setPending(null)}
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

export default NotInterestedScreen;
