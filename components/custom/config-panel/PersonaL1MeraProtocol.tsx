// DEPRECATED(wave-12): replaced by the Profile hub; delete in wave-13 cleanup.
// No longer mounted in the live tree — ProfileTabScreen renders ProfileHubScreen
// and the facts UX moved to components/custom/facts/FactsScreen.
import BlockedBanner from '@/components/custom/BlockedBanner';
import TranslatableDynamic from '@/components/custom/TranslatableDynamic';
import UsageWidget from '@/components/custom/UsageWidget';
import { Box } from '@/components/ui/box';
import { Button, ButtonText } from '@/components/ui/button';
import { HStack } from '@/components/ui/hstack';
import { Input, InputField } from '@/components/ui/input';
import { Modal, ModalBackdrop, ModalBody, ModalContent, ModalFooter, ModalHeader } from '@/components/ui/modal';
import { Pressable } from '@/components/ui/pressable';
import { Spinner } from '@/components/ui/spinner';
import { Text } from '@/components/ui/text';
import { Toast, ToastDescription, ToastTitle, useToast } from '@/components/ui/toast';
import { VStack } from '@/components/ui/vstack';
import { PRIVACY_URL } from '@/lib/config/branding';
import { AppScheduler } from '@/lib/scheduler/AppScheduler';
import { deleteFact, getFacts, updateFact } from '@/lib/database/services/fact-service';
import { enqueueJob } from '@/lib/database/services/inference-job-service';
import { inferenceQueue } from '@/lib/inference/InferenceQueue';
import { buildTopicGenContext } from '@/lib/inference/handlers/topic-gen-handler';
import { generateTopicsForFact, mergeTopicsAppend } from '@/lib/mera-protocol/topic-generation-service';
import { getArticleCountByTopicTexts, getTotalArticleSuggestionCount } from '@/lib/database/services/article-suggestion-service';
import { fetchUserBilling } from '@/lib/billing-service';
import { getPendingCount, subscribeHygieneChange } from '@/lib/database/services/hygiene-service';
import type { UserBillingInfo } from '@/lib/generated/graphql-types';
import logger from '@/lib/logger';
import type { Fact } from '@/lib/mera-protocol-toolkit/types';
import { getOfferingSafe } from '@/lib/revenuecat';
import { useFloatingChatIsExpanded, useFloatingChatFactMutationVersion } from '@/lib/stores/floating-chat-store';
import { useForYouStore } from '@/lib/stores/for-you-store';
import { useIsOnDeviceProcessing } from '@/lib/stores/mera-protocol-store';
import { useUserStore } from '@/lib/stores/user-store';
import { notifyScrollTick } from '@/lib/visibility-tick';
import { openInAppBrowser, withAppLanguage } from '@/lib/web-browser-utils';
import { MaterialIcons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { router, useFocusEffect } from 'expo-router';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Animated, RefreshControl, ScrollView, View } from 'react-native';
import RevenueCatUI from 'react-native-purchases-ui';

interface PersonaL1MeraProtocolProps {
    readonly userId: string;
}

const GENERATE_MORE_TOPIC_COUNT = 10;

const PersonaL1MeraProtocol: React.FC<PersonaL1MeraProtocolProps> = ({ userId }) => {
    const { userPersona, fetchUserPersona } = useUserStore();
    const toast = useToast();
    const { t } = useTranslation();
    const [isLoading, setIsLoading] = useState(true);
    const [refreshing, setRefreshing] = useState(false);
    const [localFacts, setLocalFacts] = useState<Fact[]>([]);
    const [articleCountByTopic, setArticleCountByTopic] = useState<Map<string, number>>(new Map());
    const [expandedFactIds, setExpandedFactIds] = useState<Set<string>>(new Set());
    const [factToDelete, setFactToDelete] = useState<Fact | null>(null);
    const [isDeleting, setIsDeleting] = useState(false);
    const [isRefreshingSuggestions, setIsRefreshingSuggestions] = useState(false);
    const [totalArticleCount, setTotalArticleCount] = useState(0);
    const [billing, setBilling] = useState<UserBillingInfo | null>(null);
    const [showArticleCountInfo, setShowArticleCountInfo] = useState(false);
    const [showPrivacyInfo, setShowPrivacyInfo] = useState(false);
    const [addTopicFact, setAddTopicFact] = useState<Fact | null>(null);
    const [addTopicText, setAddTopicText] = useState('');
    const [isAddingTopic, setIsAddingTopic] = useState(false);
    const [generateMoreFact, setGenerateMoreFact] = useState<Fact | null>(null);
    const [generatingMoreFactIds, setGeneratingMoreFactIds] = useState<Set<string>>(new Set());
    const feedNeedsRefresh = useForYouStore(s => s.feedNeedsRefresh);
    const glowAnim = useRef(new Animated.Value(0.3)).current;
    const isChatExpanded = useFloatingChatIsExpanded();
    const isOnDeviceProcessing = useIsOnDeviceProcessing();
    const [hygieneCount, setHygieneCount] = useState(0);
    const knownFactIdsRef = useRef<Set<string>>(new Set());
    const isInitialLoadRef = useRef(true);
    const wasChatExpandedRef = useRef(false);
    const factMutationVersion = useFloatingChatFactMutationVersion();

    const loadLocalFacts = useCallback(async () => {
        const [facts, counts, total] = await Promise.all([
            getFacts(),
            getArticleCountByTopicTexts(),
            getTotalArticleSuggestionCount(),
        ]);
        setTotalArticleCount(total);

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
                fetchUserBilling().then(setBilling),
                !userPersona && userId ? fetchUserPersona(userId) : Promise.resolve(),
            ]);
            setIsLoading(false);
        };
        init();
    }, [userId, userPersona, fetchUserPersona, loadLocalFacts]);

    // Real-time refresh when on-device LLM saves/deletes a fact or generates topics
    useEffect(() => {
        if (factMutationVersion > 0 && userId) {
            loadLocalFacts();
            fetchUserPersona(userId, true);
            useForYouStore.getState().setFeedNeedsRefresh(true);
        }
    }, [factMutationVersion, loadLocalFacts, fetchUserPersona, userId]);

    useEffect(() => {
        if (feedNeedsRefresh) {
            const animation = Animated.loop(
                Animated.sequence([
                    Animated.timing(glowAnim, { toValue: 1, duration: 800, useNativeDriver: true }),
                    Animated.timing(glowAnim, { toValue: 0.3, duration: 800, useNativeDriver: true }),
                ])
            );
            animation.start();
            return () => animation.stop();
        } else {
            glowAnim.stopAnimation();
            glowAnim.setValue(0);
        }
    }, [feedNeedsRefresh, glowAnim]);

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
        setRefreshing(true);
        await Promise.all([loadLocalFacts(), fetchUserPersona(userId, true)]);
        setRefreshing(false);
    }, [userId, fetchUserPersona, loadLocalFacts]);

    // Pending persona-hygiene proposal count — drives the small indicator row.
    // Refreshed on change (sweep/accept/reject) and whenever the screen regains
    // focus (e.g. returning from the review sheet).
    const refreshHygieneCount = useCallback(() => {
        getPendingCount()
            .then(setHygieneCount)
            .catch(() => {
                /* non-fatal — leave the last count */
            });
    }, []);

    useEffect(() => {
        refreshHygieneCount();
        return subscribeHygieneChange(refreshHygieneCount);
    }, [refreshHygieneCount]);

    useFocusEffect(
        useCallback(() => {
            refreshHygieneCount();
        }, [refreshHygieneCount]),
    );

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
        if (!factToDelete) return;
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
            logger.error('[PersonaL1MeraProtocol] deleteFact failed', error, {
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
    }, [factToDelete, loadLocalFacts, fetchUserPersona, userId, toast, t]);

    const handleDeleteCancel = useCallback(() => {
        setFactToDelete(null);
    }, []);

    const handleRefreshSuggestions = useCallback(async () => {
        if (isRefreshingSuggestions) return;
        const personaId = userPersona?._id;
        if (!personaId) return;
        setIsRefreshingSuggestions(true);
        useForYouStore.getState().setFeedNeedsRefresh(false);
        try {
            await useForYouStore.getState().pruneOrphanedData();
            await AppScheduler.trigger('feed-sync');
            toast.show({
                placement: 'top',
                render: () => (
                    <Toast action="success" variant="solid">
                        <ToastTitle>{t('configPanel.refreshSuggestionsSuccessTitle')}</ToastTitle>
                        <ToastDescription>{t('configPanel.refreshSuggestionsSuccessDescription')}</ToastDescription>
                    </Toast>
                ),
            });
        } catch {
            toast.show({
                placement: 'top',
                render: () => (
                    <Toast action="error" variant="solid">
                        <ToastTitle>{t('configPanel.refreshSuggestionsFailedTitle')}</ToastTitle>
                        <ToastDescription>{t('configPanel.refreshSuggestionsFailedDescription')}</ToastDescription>
                    </Toast>
                ),
            });
        } finally {
            setIsRefreshingSuggestions(false);
        }
    }, [userPersona, isRefreshingSuggestions, toast, t]);

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
        const currentTopics = fact.metadata?.topics ?? [];
        const updatedTopics = currentTopics.filter(t => t !== topicText);
        try {
            await updateFact(fact.id, {
                metadata: { ...(fact.metadata ?? {}), topics: updatedTopics },
            });
            loadLocalFacts();
            fetchUserPersona(userId, true);
            useForYouStore.getState().setFeedNeedsRefresh(true);
        } catch (error) {
            logger.error('[PersonaL1MeraProtocol] deleteTopic failed', error, { factId: fact.id, topicText });
        }
    }, [loadLocalFacts, fetchUserPersona, userId]);

    const handleAddTopicPress = useCallback((fact: Fact) => {
        setAddTopicFact(fact);
        setAddTopicText('');
    }, []);

    const handleAddTopicConfirm = useCallback(async () => {
        if (!addTopicFact || !addTopicText.trim()) return;
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
            logger.error('[PersonaL1MeraProtocol] addTopic failed', error, { factId: addTopicFact?.id });
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
        if (!fact || generatingMoreFactIds.has(fact.id)) return;
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
            logger.error('[PersonaL1MeraProtocol] generateMoreTopics failed', error, { factId: fact.id });
            showGenerateMoreFailedToast();
            clearGeneratingMore(fact.id);
        }
    }, [generateMoreFact, generatingMoreFactIds, isOnDeviceProcessing, clearGeneratingMore, showGenerateMoreFailedToast, loadLocalFacts, fetchUserPersona, userId]);

    const handleUpgrade = useCallback(async () => {
        try {
            const offering = await getOfferingSafe();
            await RevenueCatUI.presentPaywall({
                ...(offering ? { offering } : {}),
                displayCloseButton: true,
            });
        } catch (error) {
            logger.captureException(error, {
                tags: { component: 'PersonaL1MeraProtocol', method: 'upgrade' },
            });
        }
    }, []);

    const isBlocked = userPersona?.blockedByLlm ?? false;

    return (
        <Box className="flex-1">
            {isLoading ? (
                <Box className="flex-1 items-center justify-center">
                    <Spinner size="large" />
                </Box>
            ) : (
                <>
                    {isBlocked && (
                        <BlockedBanner reason={userPersona?.blockedByLlmReason} />
                    )}

                    {/* Metrics card — server-side delivery tally (user-daily-usage);
                        local count is only an offline fallback. */}
                    <UsageWidget
                        className="mx-4 mb-3"
                        used={billing?.articlesUsedToday ?? totalArticleCount}
                        limit={billing?.dailyArticleLimit ?? null}
                        usedLabel={t('configPanel.articlesAnalyzedLast24h')}
                        planLabel={
                            billing?.subscriptionTier === 'professional'
                                ? t('configPanel.professionalPlan')
                                : billing?.subscriptionTier === 'individual'
                                    ? t('configPanel.individualPlan')
                                    : t('configPanel.promoPlan')
                        }
                        onUpgrade={billing?.subscriptionTier === 'professional' ? undefined : handleUpgrade}
                        upgradeLabel={t('subscription.upgrade')}
                        resetAt={billing?.resetAt}
                        resetLabel={t('configPanel.resetsOn')}
                        onInfoPress={() => setShowArticleCountInfo(true)}
                    />

                    {/* Persona change-log audit trail (every automated/explicit
                        persona mutation, with per-row revert). */}
                    <Pressable
                        onPress={() => router.push('/logged-in/persona-audit')}
                        accessibilityRole="button"
                        className="mx-4 mb-3 flex-row items-center justify-between px-3 py-3 border border-gray-700 rounded-lg"
                    >
                        <HStack className="items-center" space="sm">
                            <MaterialIcons name="history" size={18} color="#60a5fa" />
                            <Text size="sm" className="text-gray-200">{t('personaAudit.entryRow')}</Text>
                        </HStack>
                        <MaterialIcons name="chevron-right" size={20} color="#6b7280" />
                    </Pressable>

                    {/* Persona-health indicator — only when the weekly hygiene
                        sweep has pending cleanup suggestions. Opens the same
                        deterministic review sheet as the notification chip. */}
                    {hygieneCount > 0 && (
                        <Pressable
                            onPress={() => router.push('/logged-in/hygiene-review')}
                            accessibilityRole="button"
                            className="mx-4 mb-3 flex-row items-center justify-between px-3 py-3 border border-amber-700/60 rounded-lg bg-amber-950/30"
                        >
                            <HStack className="items-center" space="sm">
                                <MaterialIcons name="cleaning-services" size={18} color="#EDA77E" />
                                <Text size="sm" className="text-gray-200">
                                    {t('hygiene.profileRow', {
                                        count: hygieneCount,
                                        defaultValue: 'Persona health · {{count}} suggestions',
                                    })}
                                </Text>
                            </HStack>
                            <MaterialIcons name="chevron-right" size={20} color="#6b7280" />
                        </Pressable>
                    )}

                    <View style={{ marginHorizontal: 16, marginBottom: feedNeedsRefresh && !isRefreshingSuggestions ? 6 : 12, position: 'relative' }}>
                        {feedNeedsRefresh && !isRefreshingSuggestions && (
                            <Animated.View
                                pointerEvents="none"
                                style={{
                                    position: 'absolute',
                                    top: -3,
                                    left: -3,
                                    right: -3,
                                    bottom: -3,
                                    borderRadius: 12,
                                    borderWidth: 2,
                                    borderColor: '#60a5fa',
                                    opacity: glowAnim,
                                }}
                            />
                        )}
                        <Button
                            variant="outline"
                            action="primary"
                            size="sm"
                            onPress={handleRefreshSuggestions}
                            disabled={isRefreshingSuggestions}
                        >
                            {isRefreshingSuggestions ? (
                                <HStack space="sm" className="items-center">
                                    <Spinner size="small" />
                                    <ButtonText>{t('configPanel.refreshingSuggestions')}</ButtonText>
                                </HStack>
                            ) : (
                                <HStack space="sm" className="items-center">
                                    <MaterialIcons name="refresh" size={16} color="#60a5fa" />
                                    <ButtonText>{t('configPanel.refreshSuggestions')}</ButtonText>
                                </HStack>
                            )}
                        </Button>
                    </View>
                    {feedNeedsRefresh && !isRefreshingSuggestions && (
                        <Box className="mx-4 mb-3 px-3 py-2 bg-blue-950/60 border border-blue-800 rounded-lg">
                            <HStack space="xs" className="items-start">
                                <MaterialIcons name="auto-awesome" size={14} color="#93c5fd" style={{ marginTop: 1 }} />
                                <Text size="xs" className="text-blue-300 flex-1">
                                    {t('configPanel.personaUpdatedRefreshHint')}
                                </Text>
                            </HStack>
                        </Box>
                    )}

                    {localFacts.length === 0 ? (
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

                            {/* Fact accordions */}
                            {localFacts.map((fact) => {
                                const factTopics = fact.metadata?.topics ?? [];
                                const expectedTopicCount = factTopics.length;
                                const topicGenError = fact.metadata?.topicGenError?.[0];
                                const topicsSettled =
                                    !!topicGenError || expectedTopicCount > 0;
                                const isExpanded = expandedFactIds.has(fact.id);
                                const totalCount = factTopics.reduce(
                                    (sum, t) => sum + (articleCountByTopic.get(t) ?? 0),
                                    0,
                                );
                                return (
                                    <Box
                                        key={fact.id}
                                        className="mx-4 mb-3 border border-gray-700 rounded-lg overflow-hidden"
                                    >
                                        {/* Accordion header */}
                                        <HStack className="px-4 py-3 items-center">
                                            <Pressable
                                                onPress={() => handleDeletePress(fact)}
                                                hitSlop={8}
                                                className="mr-3"
                                            >
                                                <MaterialIcons name="delete-outline" size={20} color="#ef4444" />
                                            </Pressable>
                                            <Pressable
                                                onPress={() => toggleFact(fact.id)}
                                                className="flex-1 mr-2"
                                            >
                                                <TranslatableDynamic
                                                    text={fact.statement}
                                                    size="md"
                                                    className="text-white capitalize"
                                                    numberOfLines={2}
                                                />
                                            </Pressable>
                                            <HStack space="xs" className="items-center">
                                                {!topicsSettled && <Spinner size="small" />}
                                                {topicsSettled && totalCount > 0 && (
                                                    <Button
                                                        variant="outline"
                                                        size="xs"
                                                        onPress={() => handleFactArticlesPress(fact)}
                                                        className="rounded-full"
                                                    >
                                                        <ButtonText>{t('configPanel.articleCount', { count: totalCount })}</ButtonText>
                                                    </Button>
                                                )}
                                                <Pressable onPress={() => toggleFact(fact.id)} hitSlop={8}>
                                                    <MaterialIcons
                                                        name={isExpanded ? 'expand-less' : 'expand-more'}
                                                        size={20}
                                                        color="#9ca3af"
                                                    />
                                                </Pressable>
                                            </HStack>
                                        </HStack>

                                        {/* Accordion body */}
                                        {isExpanded && (
                                            <Box className="border-t border-gray-700 px-4 py-3">
                                                {topicGenError ? (
                                                    <Text className="text-red-400 text-sm">
                                                        {t('configPanel.topicGenFailed', { error: topicGenError })}
                                                    </Text>
                                                ) : !topicsSettled ? (
                                                    <Text className="text-typography-400 text-sm">
                                                        {t('configPanel.generatingTopics')}
                                                    </Text>
                                                ) : (
                                                    <VStack space="sm">
                                                        {factTopics.map(topicText => {
                                                            const count = articleCountByTopic.get(topicText) ?? 0;
                                                            return (
                                                                <HStack key={topicText} className="items-center">
                                                                    <Pressable
                                                                        className="flex-1"
                                                                        onPress={() => handleTopicPress(topicText)}
                                                                    >
                                                                        <HStack className="items-center justify-between flex-1 mr-3">
                                                                            <TranslatableDynamic
                                                                                text={topicText}
                                                                                size="sm"
                                                                                className="text-gray-200 flex-1 mr-2 capitalize"
                                                                                numberOfLines={2}
                                                                            />
                                                                            <Text size="xs" className="text-gray-500">
                                                                                {t('configPanel.articleCount', { count })}
                                                                            </Text>
                                                                        </HStack>
                                                                    </Pressable>
                                                                    <Pressable
                                                                        onPress={() => handleDeleteTopic(fact, topicText)}
                                                                        hitSlop={8}
                                                                        className="ml-1"
                                                                    >
                                                                        <MaterialIcons name="delete-outline" size={16} color="#6b7280" />
                                                                    </Pressable>
                                                                </HStack>
                                                            );
                                                        })}
                                                        <Pressable
                                                            onPress={() => handleAddTopicPress(fact)}
                                                            className="mt-1"
                                                        >
                                                            <HStack className="items-center" space="xs">
                                                                <MaterialIcons name="add" size={16} color="#60a5fa" />
                                                                <Text size="sm" className="text-blue-400">{t('configPanel.addTopic')}</Text>
                                                            </HStack>
                                                        </Pressable>
                                                        {generatingMoreFactIds.has(fact.id) ? (
                                                            <HStack className="items-center mt-1" space="xs">
                                                                <Spinner size="small" />
                                                                <Text size="sm" className="text-typography-400">{t('configPanel.generatingMoreTopics')}</Text>
                                                            </HStack>
                                                        ) : (
                                                            <Pressable
                                                                onPress={() => handleGenerateMorePress(fact)}
                                                                className="mt-1"
                                                            >
                                                                <HStack className="items-center" space="xs">
                                                                    <MaterialIcons name="auto-awesome" size={16} color="#60a5fa" />
                                                                    <Text size="sm" className="text-blue-400">{t('configPanel.generateMoreTopics')}</Text>
                                                                </HStack>
                                                            </Pressable>
                                                        )}
                                                    </VStack>
                                                )}
                                            </Box>
                                        )}
                                    </Box>
                                );
                            })}
                        </ScrollView>
                    )}
                </>
            )}

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

            <Modal isOpen={showArticleCountInfo} onClose={() => setShowArticleCountInfo(false)} size="sm">
                <ModalBackdrop />
                <ModalContent>
                    <ModalHeader className="pb-3">
                        <HStack className="items-center" space="xs">
                            <MaterialIcons name="info-outline" size={18} color="#9ca3af" />
                            <Text className="text-base font-semibold text-white">{t('configPanel.articleAnalysisTitle')}</Text>
                        </HStack>
                    </ModalHeader>
                    <ModalBody className="py-4">
                        <Text className="text-gray-300 text-sm leading-relaxed">
                            {t('configPanel.articleAnalysisDescription')}
                        </Text>
                    </ModalBody>
                    <ModalFooter className="border-t border-gray-700 pt-4">
                        <Button
                            variant="outline"
                            action="secondary"
                            onPress={() => setShowArticleCountInfo(false)}
                            className="w-full"
                        >
                            <ButtonText>{t('configPanel.gotIt')}</ButtonText>
                        </Button>
                    </ModalFooter>
                </ModalContent>
            </Modal>

            <Modal isOpen={addTopicFact !== null} onClose={handleAddTopicCancel} size="sm">
                <ModalBackdrop />
                <ModalContent>
                    <ModalHeader className="pb-4">
                        <Text className="text-xl font-semibold text-white">{t('configPanel.addTopic')}</Text>
                    </ModalHeader>
                    <ModalBody className="py-4">
                        <Text className="text-gray-400 text-sm mb-4">
                            {t('configPanel.addTopicDescription')}
                        </Text>
                        <Input>
                            <InputField
                                placeholder={t('configPanel.addTopicPlaceholder')}
                                value={addTopicText}
                                onChangeText={setAddTopicText}
                                autoFocus
                                returnKeyType="done"
                                onSubmitEditing={handleAddTopicConfirm}
                            />
                        </Input>
                    </ModalBody>
                    <ModalFooter className="border-t border-gray-700 pt-4">
                        <VStack className="w-full" space="md">
                            <Button
                                onPress={handleAddTopicConfirm}
                                disabled={isAddingTopic || !addTopicText.trim()}
                                className="w-full"
                            >
                                <ButtonText>{isAddingTopic ? t('configPanel.adding') : t('configPanel.addTopic')}</ButtonText>
                            </Button>
                            <Button
                                variant="outline"
                                action="secondary"
                                onPress={handleAddTopicCancel}
                                disabled={isAddingTopic}
                                className="w-full"
                            >
                                <ButtonText>{t('common.cancel')}</ButtonText>
                            </Button>
                        </VStack>
                    </ModalFooter>
                </ModalContent>
            </Modal>

            <Modal isOpen={generateMoreFact !== null} onClose={handleGenerateMoreCancel} size="sm">
                <ModalBackdrop />
                <ModalContent>
                    <ModalHeader className="pb-4">
                        <Text className="text-xl font-semibold text-white">{t('configPanel.generateMoreTopicsTitle')}</Text>
                    </ModalHeader>
                    <ModalBody className="py-4">
                        <Text className="text-gray-300 text-base leading-relaxed">
                            {t('configPanel.generateMoreTopicsWarning')}
                        </Text>
                    </ModalBody>
                    <ModalFooter className="border-t border-gray-700 pt-4">
                        <VStack className="w-full" space="md">
                            <Button
                                onPress={handleGenerateMoreConfirm}
                                className="w-full"
                            >
                                <ButtonText>{t('configPanel.generateMoreTopicsConfirm')}</ButtonText>
                            </Button>
                            <Button
                                variant="outline"
                                action="secondary"
                                onPress={handleGenerateMoreCancel}
                                className="w-full"
                            >
                                <ButtonText>{t('common.cancel')}</ButtonText>
                            </Button>
                        </VStack>
                    </ModalFooter>
                </ModalContent>
            </Modal>

            <Modal isOpen={factToDelete !== null} onClose={handleDeleteCancel} size="sm">
                <ModalBackdrop />
                <ModalContent>
                    <ModalHeader className="border-gray-700 pb-4">
                        <Text className="text-xl font-semibold text-red-400">{t('configPanel.deleteFactTitle')}</Text>
                    </ModalHeader>
                    <ModalBody className="py-6">
                        <Text className="text-gray-300 text-base leading-relaxed mb-4">
                            {t('configPanel.deleteFactConfirm')}
                        </Text>
                        {factToDelete && (
                            <Text className="text-white text-base font-medium mb-4 capitalize">
                                &ldquo;{factToDelete.statement}&rdquo;
                            </Text>
                        )}
                        <Text className="text-red-400 text-sm font-medium">
                            {t('configPanel.deleteFactWarning')}
                        </Text>
                    </ModalBody>
                    <ModalFooter className="border-t border-gray-700 pt-4">
                        <VStack className="w-full" space="md">
                            <Button
                                action="negative"
                                onPress={handleDeleteConfirm}
                                disabled={isDeleting}
                                className="w-full"
                            >
                                <ButtonText>
                                    {isDeleting ? t('configPanel.deletingFact') : t('configPanel.yesDelete')}
                                </ButtonText>
                            </Button>
                            <Button
                                variant="outline"
                                action="secondary"
                                onPress={handleDeleteCancel}
                                disabled={isDeleting}
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

export default PersonaL1MeraProtocol;
