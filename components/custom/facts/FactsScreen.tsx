import DrillDownHeader from '@/components/custom/config-panel/DrillDownHeader';
import { Box } from '@/components/ui/box';
import { Button, ButtonText } from '@/components/ui/button';
import { HStack } from '@/components/ui/hstack';
import { Modal, ModalBackdrop, ModalBody, ModalContent, ModalFooter, ModalHeader } from '@/components/ui/modal';
import { Pressable } from '@/components/ui/pressable';
import { Spinner } from '@/components/ui/spinner';
import { Text } from '@/components/ui/text';
import { Toast, ToastDescription, ToastTitle, useToast } from '@/components/ui/toast';
import { VStack } from '@/components/ui/vstack';
import { authClient } from '@/lib/auth-client';
import { PRIVACY_URL } from '@/lib/config/branding';
import { getArticleCountByTopicTexts } from '@/lib/database/services/article-suggestion-service';
import { deleteFact, getFacts, updateFact } from '@/lib/database/services/fact-service';
import { enqueueJob } from '@/lib/database/services/inference-job-service';
import { buildTopicGenContext } from '@/lib/inference/handlers/topic-gen-handler';
import { inferenceQueue } from '@/lib/inference/InferenceQueue';
import logger from '@/lib/logger';
import type { Fact } from '@/lib/mera-protocol-toolkit/types';
import { generateTopicsForFact, mergeTopicsAppend } from '@/lib/mera-protocol/topic-generation-service';
import { useFloatingChatFactMutationVersion, useFloatingChatIsExpanded } from '@/lib/stores/floating-chat-store';
import { useForYouStore } from '@/lib/stores/for-you-store';
import { useIsOnDeviceProcessing } from '@/lib/stores/mera-protocol-store';
import { useUserStore } from '@/lib/stores/user-store';
import { notifyScrollTick } from '@/lib/visibility-tick';
import { openInAppBrowser, withAppLanguage } from '@/lib/web-browser-utils';
import { MaterialIcons } from '@expo/vector-icons';
import { router } from 'expo-router';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { RefreshControl, ScrollView } from 'react-native';
import AddTopicModal from './AddTopicModal';
import DeleteFactModal from './DeleteFactModal';
import FactAccordion from './FactAccordion';
import GenerateMoreModal from './GenerateMoreModal';

interface FactsScreenProps {
    readonly onBack: () => void;
}

const GENERATE_MORE_TOPIC_COUNT = 10;

/**
 * Facts sub-screen (Wave 12). The entire fact-management UX that used to live in
 * PersonaL1MeraProtocol's megascroll — delete fact, per-topic article counts →
 * persona-articles, delete topic, add topic, generate more — moved verbatim to
 * a dedicated pushed route off the Profile hub. Services, params, and routes are
 * unchanged; only the surrounding hub chrome (usage widget, audit/hygiene rows,
 * refresh-suggestions button) was left behind on the hub.
 */
const FactsScreen: React.FC<FactsScreenProps> = ({ onBack }) => {
    const { data: session } = authClient.useSession();
    const userId = session?.user?.id;
    const { fetchUserPersona } = useUserStore();
    const toast = useToast();
    const { t } = useTranslation();

    const [isLoading, setIsLoading] = useState(true);
    const [refreshing, setRefreshing] = useState(false);
    const [localFacts, setLocalFacts] = useState<Fact[]>([]);
    const [articleCountByTopic, setArticleCountByTopic] = useState<Map<string, number>>(new Map());
    const [expandedFactIds, setExpandedFactIds] = useState<Set<string>>(new Set());
    const [factToDelete, setFactToDelete] = useState<Fact | null>(null);
    const [isDeleting, setIsDeleting] = useState(false);
    const [showPrivacyInfo, setShowPrivacyInfo] = useState(false);
    const [addTopicFact, setAddTopicFact] = useState<Fact | null>(null);
    const [addTopicText, setAddTopicText] = useState('');
    const [isAddingTopic, setIsAddingTopic] = useState(false);
    const [generateMoreFact, setGenerateMoreFact] = useState<Fact | null>(null);
    const [generatingMoreFactIds, setGeneratingMoreFactIds] = useState<Set<string>>(new Set());

    const isChatExpanded = useFloatingChatIsExpanded();
    const isOnDeviceProcessing = useIsOnDeviceProcessing();
    const factMutationVersion = useFloatingChatFactMutationVersion();
    const knownFactIdsRef = useRef<Set<string>>(new Set());
    const isInitialLoadRef = useRef(true);
    const wasChatExpandedRef = useRef(false);

    const loadLocalFacts = useCallback(async () => {
        const [facts, counts] = await Promise.all([
            getFacts(),
            getArticleCountByTopicTexts(),
        ]);

        if (!isInitialLoadRef.current) {
            const newIds = facts
                .filter(f => !knownFactIdsRef.current.has(f.id))
                .map(f => f.id);
            if (newIds.length > 0) {
                setExpandedFactIds(new Set([newIds[newIds.length - 1]]));
            }
        }
        isInitialLoadRef.current = false;
        knownFactIdsRef.current = new Set(facts.map(f => f.id));

        setLocalFacts(facts);
        setArticleCountByTopic(counts);
        return facts;
    }, []);

    useEffect(() => {
        const init = async () => {
            setIsLoading(true);
            await Promise.all([
                loadLocalFacts(),
                userId ? fetchUserPersona(userId) : Promise.resolve(),
            ]);
            setIsLoading(false);
        };
        init();
    }, [userId, fetchUserPersona, loadLocalFacts]);

    // Real-time refresh when on-device LLM saves/deletes a fact or generates topics
    useEffect(() => {
        if (factMutationVersion > 0 && userId) {
            loadLocalFacts();
            fetchUserPersona(userId, true);
            useForYouStore.getState().setFeedNeedsRefresh(true);
        }
    }, [factMutationVersion, loadLocalFacts, fetchUserPersona, userId]);

    // When the floating chat popover collapses (true→false transition), reload
    // facts + persona — the same refresh the old embedded chat's closeChat did.
    useEffect(() => {
        if (wasChatExpandedRef.current && !isChatExpanded && userId) {
            loadLocalFacts();
            fetchUserPersona(userId, true);
        }
        wasChatExpandedRef.current = isChatExpanded;
    }, [isChatExpanded, loadLocalFacts, fetchUserPersona, userId]);

    const onRefresh = useCallback(async () => {
        if (!userId) return;
        setRefreshing(true);
        await Promise.all([loadLocalFacts(), fetchUserPersona(userId, true)]);
        setRefreshing(false);
    }, [userId, fetchUserPersona, loadLocalFacts]);

    const toggleFact = useCallback((factId: string) => {
        setExpandedFactIds(prev => {
            if (prev.has(factId)) return new Set();
            return new Set([factId]);
        });
    }, []);

    const handleDeletePress = useCallback((fact: Fact) => {
        setFactToDelete(fact);
    }, []);

    const handleDeleteConfirm = useCallback(async () => {
        if (!factToDelete || !userId) return;
        setIsDeleting(true);
        try {
            await deleteFact(factToDelete.id);

            setFactToDelete(null);
            loadLocalFacts();
            fetchUserPersona(userId, true);
            useForYouStore.getState().setFeedNeedsRefresh(true);
            toast.show({
                placement: 'top',
                render: () => (
                    <Toast action="success" variant="solid">
                        <ToastTitle>{t('configPanel.factDeletedTitle')}</ToastTitle>
                        <ToastDescription>{t('configPanel.factDeletedDescription')}</ToastDescription>
                    </Toast>
                ),
            });
        } catch (error) {
            logger.error('[FactsScreen] deleteFact failed', error, {
                factId: factToDelete?.id,
            });
            toast.show({
                placement: 'top',
                render: () => (
                    <Toast action="error" variant="solid">
                        <ToastTitle>{t('configPanel.deleteFailedTitle')}</ToastTitle>
                        <ToastDescription>{t('configPanel.deleteFailedDescription')}</ToastDescription>
                    </Toast>
                ),
            });
        } finally {
            setIsDeleting(false);
        }
    }, [factToDelete, userId, loadLocalFacts, fetchUserPersona, toast, t]);

    const handleDeleteCancel = useCallback(() => {
        setFactToDelete(null);
    }, []);

    const handleFactArticlesPress = useCallback((fact: Fact) => {
        const topicTexts = fact.metadata?.topics ?? [];
        if (topicTexts.length === 0) return;
        router.push({
            pathname: '/logged-in/persona-articles',
            params: { topicTexts: JSON.stringify(topicTexts), factStatement: fact.statement },
        });
    }, []);

    const handleTopicPress = useCallback((topicText: string) => {
        router.push({
            pathname: '/logged-in/persona-articles',
            params: { topicTexts: JSON.stringify([topicText]) },
        });
    }, []);

    const handleDeleteTopic = useCallback(async (fact: Fact, topicText: string) => {
        if (!userId) return;
        const currentTopics = fact.metadata?.topics ?? [];
        const updatedTopics = currentTopics.filter(topic => topic !== topicText);
        try {
            await updateFact(fact.id, {
                metadata: { ...(fact.metadata ?? {}), topics: updatedTopics },
            });
            loadLocalFacts();
            fetchUserPersona(userId, true);
            useForYouStore.getState().setFeedNeedsRefresh(true);
        } catch (error) {
            logger.error('[FactsScreen] deleteTopic failed', error, { factId: fact.id, topicText });
        }
    }, [loadLocalFacts, fetchUserPersona, userId]);

    const handleAddTopicPress = useCallback((fact: Fact) => {
        setAddTopicFact(fact);
        setAddTopicText('');
    }, []);

    const handleAddTopicConfirm = useCallback(async () => {
        if (!addTopicFact || !addTopicText.trim() || !userId) return;
        setIsAddingTopic(true);
        try {
            const currentTopics = addTopicFact.metadata?.topics ?? [];
            const trimmed = addTopicText.trim();
            if (currentTopics.includes(trimmed)) {
                setAddTopicFact(null);
                return;
            }
            await updateFact(addTopicFact.id, {
                metadata: { ...(addTopicFact.metadata ?? {}), topics: [...currentTopics, trimmed] },
            });
            setAddTopicFact(null);
            loadLocalFacts();
            fetchUserPersona(userId, true);
            useForYouStore.getState().setFeedNeedsRefresh(true);
        } catch (error) {
            logger.error('[FactsScreen] addTopic failed', error, { factId: addTopicFact?.id });
        } finally {
            setIsAddingTopic(false);
        }
    }, [addTopicFact, addTopicText, loadLocalFacts, fetchUserPersona, userId]);

    const handleAddTopicCancel = useCallback(() => {
        setAddTopicFact(null);
        setAddTopicText('');
    }, []);

    const handleGenerateMorePress = useCallback((fact: Fact) => {
        setGenerateMoreFact(fact);
    }, []);

    const handleGenerateMoreCancel = useCallback(() => {
        setGenerateMoreFact(null);
    }, []);

    const clearGeneratingMore = useCallback((factId: string) => {
        setGeneratingMoreFactIds(prev => {
            if (!prev.has(factId)) return prev;
            const next = new Set(prev);
            next.delete(factId);
            return next;
        });
    }, []);

    const showGenerateMoreFailedToast = useCallback(() => {
        toast.show({
            placement: 'top',
            render: () => (
                <Toast action="error" variant="solid">
                    <ToastTitle>{t('configPanel.generateMoreTopicsFailedTitle')}</ToastTitle>
                    <ToastDescription>{t('configPanel.generateMoreTopicsFailedDescription')}</ToastDescription>
                </Toast>
            ),
        });
    }, [toast, t]);

    const handleGenerateMoreConfirm = useCallback(async () => {
        const fact = generateMoreFact;
        if (!fact || generatingMoreFactIds.has(fact.id) || !userId) return;
        setGenerateMoreFact(null);
        setGeneratingMoreFactIds(prev => new Set(prev).add(fact.id));
        const existingTopics = fact.metadata?.topics ?? [];
        try {
            if (isOnDeviceProcessing) {
                await enqueueJob('topic_gen', {
                    factId: fact.id,
                    factStatement: fact.statement,
                    useCloud: false,
                    mode: 'append',
                    totalCount: GENERATE_MORE_TOPIC_COUNT,
                    excludeTopics: existingTopics,
                });
                // Busy state clears when the queue drains (job done or failed);
                // the handler's notifyFactMutation() refreshes the fact list.
                inferenceQueue.onDrain(() => clearGeneratingMore(fact.id));
                inferenceQueue.notify();
                return;
            }
            const allFacts = await getFacts();
            const { userLocation, otherFacts } = buildTopicGenContext(allFacts, fact.id);
            const newTopics = await generateTopicsForFact({
                factStatement: fact.statement,
                userLocation,
                otherFacts,
                useCloud: true,
                totalCount: GENERATE_MORE_TOPIC_COUNT,
                excludeTopics: existingTopics,
            });
            if (newTopics.length === 0) {
                showGenerateMoreFailedToast();
            } else {
                await updateFact(fact.id, {
                    metadata: { ...(fact.metadata ?? {}), topics: mergeTopicsAppend(existingTopics, newTopics) },
                });
                loadLocalFacts();
                fetchUserPersona(userId, true);
                useForYouStore.getState().setFeedNeedsRefresh(true);
            }
            clearGeneratingMore(fact.id);
        } catch (error) {
            logger.error('[FactsScreen] generateMoreTopics failed', error, { factId: fact.id });
            showGenerateMoreFailedToast();
            clearGeneratingMore(fact.id);
        }
    }, [generateMoreFact, generatingMoreFactIds, userId, isOnDeviceProcessing, clearGeneratingMore, showGenerateMoreFailedToast, loadLocalFacts, fetchUserPersona]);

    return (
        <Box className="flex-1 bg-black">
            <DrillDownHeader
                title={t('facts.screenTitle', { defaultValue: 'Your facts' })}
                subtitle={t('facts.screenSubtitle', { defaultValue: 'What Mera knows about you' })}
                onBack={onBack}
            />

            {isLoading ? (
                <Box className="flex-1 items-center justify-center">
                    <Spinner size="large" />
                </Box>
            ) : localFacts.length === 0 ? (
                <VStack className="flex-1 items-center justify-center p-6" space="md">
                    <MaterialIcons name="chat" size={48} color="#666666" />
                    <Text size="md" className="text-gray-400 text-center">
                        {t('configPanel.emptyStateMessage')}
                    </Text>
                </VStack>
            ) : (
                <ScrollView
                    showsVerticalScrollIndicator={false}
                    contentContainerStyle={{ paddingTop: 12, paddingBottom: 96 }}
                    onScroll={notifyScrollTick}
                    scrollEventThrottle={16}
                    refreshControl={
                        <RefreshControl
                            refreshing={refreshing}
                            onRefresh={onRefresh}
                            tintColor="#ffffff"
                            colors={['#ffffff']}
                        />
                    }
                >
                    {/* Facts heading */}
                    <HStack className="mx-4 mb-2 items-center justify-between">
                        <Text size="sm" className="text-gray-400 font-medium">{t('configPanel.factsHeading')}</Text>
                        <Pressable
                            onPress={() => setShowPrivacyInfo(true)}
                            hitSlop={8}
                            accessibilityRole="button"
                            accessibilityLabel={t('configPanel.privacyNoticeTitle')}
                            className="w-8 h-8 rounded-full items-center justify-center"
                        >
                            <MaterialIcons name="help-outline" size={18} color="#60a5fa" />
                        </Pressable>
                    </HStack>

                    {localFacts.map((fact) => (
                        <FactAccordion
                            key={fact.id}
                            fact={fact}
                            isExpanded={expandedFactIds.has(fact.id)}
                            articleCountByTopic={articleCountByTopic}
                            isGeneratingMore={generatingMoreFactIds.has(fact.id)}
                            onToggle={toggleFact}
                            onDeletePress={handleDeletePress}
                            onFactArticles={handleFactArticlesPress}
                            onTopicPress={handleTopicPress}
                            onDeleteTopic={handleDeleteTopic}
                            onAddTopic={handleAddTopicPress}
                            onGenerateMore={handleGenerateMorePress}
                        />
                    ))}
                </ScrollView>
            )}

            {/* Privacy notice */}
            <Modal isOpen={showPrivacyInfo} onClose={() => setShowPrivacyInfo(false)} size="sm">
                <ModalBackdrop />
                <ModalContent>
                    <ModalHeader className="pb-3">
                        <HStack className="items-center" space="xs">
                            <MaterialIcons name="shield" size={18} color="#9ca3af" />
                            <Text className="text-base font-semibold text-white">{t('configPanel.privacyNoticeTitle')}</Text>
                        </HStack>
                    </ModalHeader>
                    <ModalBody className="py-4">
                        <Text className="text-gray-300 text-sm leading-relaxed">
                            {isOnDeviceProcessing
                                ? t('configPanel.privacyOnDevice')
                                : t('configPanel.privacyCloud')}{' '}
                            <Text className="text-primary-400 underline text-sm" onPress={() => openInAppBrowser(withAppLanguage(PRIVACY_URL))}>
                                {t('configPanel.privacyPolicy')}
                            </Text>
                        </Text>
                    </ModalBody>
                    <ModalFooter className="border-t border-gray-700 pt-4">
                        <Button
                            variant="outline"
                            action="secondary"
                            onPress={() => setShowPrivacyInfo(false)}
                            className="w-full"
                        >
                            <ButtonText>{t('configPanel.gotIt')}</ButtonText>
                        </Button>
                    </ModalFooter>
                </ModalContent>
            </Modal>

            <AddTopicModal
                isOpen={addTopicFact !== null}
                value={addTopicText}
                isAdding={isAddingTopic}
                onChangeText={setAddTopicText}
                onConfirm={handleAddTopicConfirm}
                onCancel={handleAddTopicCancel}
            />

            <GenerateMoreModal
                isOpen={generateMoreFact !== null}
                onConfirm={handleGenerateMoreConfirm}
                onCancel={handleGenerateMoreCancel}
            />

            <DeleteFactModal
                fact={factToDelete}
                isDeleting={isDeleting}
                onConfirm={handleDeleteConfirm}
                onCancel={handleDeleteCancel}
            />
        </Box>
    );
};

export default FactsScreen;
