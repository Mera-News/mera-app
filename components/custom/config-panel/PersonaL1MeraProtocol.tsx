import BlockedBanner from '@/components/custom/BlockedBanner';
import MeraAIBubble from '@/components/custom/MeraAIBubble';
import TranslatableDynamic from '@/components/custom/TranslatableDynamic';
import MeraPersonaUpdateChat from '@/components/custom/chat/MeraPersonaUpdateChat';
import { Box } from '@/components/ui/box';
import { Button, ButtonText } from '@/components/ui/button';
import { HStack } from '@/components/ui/hstack';
import { Modal, ModalBackdrop, ModalBody, ModalContent, ModalFooter, ModalHeader } from '@/components/ui/modal';
import { Pressable } from '@/components/ui/pressable';
import { Progress, ProgressFilledTrack } from '@/components/ui/progress';
import { Spinner } from '@/components/ui/spinner';
import { Text } from '@/components/ui/text';
import { Toast, ToastDescription, ToastTitle, useToast } from '@/components/ui/toast';
import { VStack } from '@/components/ui/vstack';
import { AccountService, type UserTopic } from '@/lib/account-service';
import { PRIVACY_URL } from '@/lib/config/branding';
import { runSync } from '@/lib/services/SuggestionSyncService';
import { deleteFact, getFacts, getFactTopicLinks, resolveTopicIdsForFact } from '@/lib/database/services/fact-service';
import {
    getAllNoisyLinks,
    getNoisyTopicIdsForFact,
} from '@/lib/database/services/noisy-user-topic-service';
import logger from '@/lib/logger';
import type { Fact, FactTopicLink } from '@/lib/mera-protocol-toolkit/types';
import { useChatPopupIsExpanded, useChatPopupStore, useChatPopupFactMutationVersion } from '@/lib/stores/chat-popup-store';
import { useForYouStore } from '@/lib/stores/for-you-store';
import { useInjectNoise, useIsOnDeviceProcessing } from '@/lib/stores/mera-protocol-store';
import { Switch } from '@/components/ui/switch';
import { useTopicSyncIsSyncing, useTopicSyncProgress } from '@/lib/stores/topic-sync-store';
import { useUserStore } from '@/lib/stores/user-store';
import { notifyScrollTick } from '@/lib/visibility-tick';
import { openInAppBrowser } from '@/lib/web-browser-utils';
import { MaterialIcons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { router } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Dimensions, Keyboard, Pressable as RNPressable, RefreshControl, ScrollView, View } from 'react-native';
import { KeyboardStickyView } from 'react-native-keyboard-controller';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

interface PersonaL1MeraProtocolProps {
    readonly userId: string;
    readonly expandMeraChat?: boolean;
}

const PersonaL1MeraProtocol: React.FC<PersonaL1MeraProtocolProps> = ({ userId, expandMeraChat }) => {
    const { userPersona, fetchUserPersona } = useUserStore();
    const toast = useToast();
    const { t } = useTranslation();
    const [isLoading, setIsLoading] = useState(true);
    const [refreshing, setRefreshing] = useState(false);
    const [localFacts, setLocalFacts] = useState<Fact[]>([]);
    const [allLinks, setAllLinks] = useState<FactTopicLink[]>([]);
    const [noisyLinks, setNoisyLinks] = useState<
        { factId: string; serverTopicId: string; newsTopicText: string }[]
    >([]);
    const [showNoise, setShowNoise] = useState(false);
    const injectNoiseEnabled = useInjectNoise();
    const [expandedFactIds, setExpandedFactIds] = useState<Set<string>>(new Set());
    const [factToDelete, setFactToDelete] = useState<Fact | null>(null);
    const [isDeleting, setIsDeleting] = useState(false);
    const [isRefreshingSuggestions, setIsRefreshingSuggestions] = useState(false);
    const isChatExpanded = useChatPopupIsExpanded();
    const isOnDeviceProcessing = useIsOnDeviceProcessing();
    const insets = useSafeAreaInsets();
    const knownFactIdsRef = useRef<Set<string>>(new Set());
    const isInitialLoadRef = useRef(true);

    // Topic sync progress
    const isSyncing = useTopicSyncIsSyncing();
    const { total, completed } = useTopicSyncProgress();
    const factMutationVersion = useChatPopupFactMutationVersion();

    const loadLocalFacts = useCallback(async () => {
        const [facts, links, noisy] = await Promise.all([
            getFacts(),
            getFactTopicLinks(),
            getAllNoisyLinks(),
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
        setAllLinks(links);
        setNoisyLinks(noisy);
        return facts;
    }, []);

    useEffect(() => {
        const init = async () => {
            setIsLoading(true);
            await Promise.all([
                loadLocalFacts(),
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
        }
    }, [factMutationVersion, loadLocalFacts, fetchUserPersona, userId]);

    const closeChat = useCallback(() => {
        useChatPopupStore.getState().collapse();
        loadLocalFacts();
        fetchUserPersona(userId, true);
    }, [loadLocalFacts, fetchUserPersona, userId]);

    const onRefresh = useCallback(async () => {
        setRefreshing(true);
        await Promise.all([loadLocalFacts(), fetchUserPersona(userId, true)]);
        setRefreshing(false);
    }, [userId, fetchUserPersona, loadLocalFacts]);

    const interests = useMemo(() => userPersona?.userTopics ?? [], [userPersona?.userTopics]);

    const toggleFact = useCallback((factId: string) => {
        setExpandedFactIds(prev => {
            if (prev.has(factId)) return new Set();
            return new Set([factId]);
        });
    }, []);

    const noisyIdsByFactId = useMemo(() => {
        const map = new Map<string, Set<string>>();
        for (const link of noisyLinks) {
            const set = map.get(link.factId) ?? new Set<string>();
            set.add(link.serverTopicId);
            map.set(link.factId, set);
        }
        return map;
    }, [noisyLinks]);

    const getTopicsForFact = useCallback(
        (fact: Fact): { real: UserTopic[]; noisy: UserTopic[] } => {
            const realIds = resolveTopicIdsForFact(fact, allLinks, interests);
            const realIdSet = new Set(realIds);
            const real = interests.filter((i) => realIdSet.has(i._id));
            const noisyIds = noisyIdsByFactId.get(fact.id) ?? new Set<string>();
            const noisy = interests.filter((i) => noisyIds.has(i._id) && !realIdSet.has(i._id));
            return { real, noisy };
        },
        [allLinks, interests, noisyIdsByFactId],
    );

    const handleDeletePress = useCallback((fact: Fact) => {
        setFactToDelete(fact);
    }, []);

    const handleDeleteConfirm = useCallback(async () => {
        if (!factToDelete) return;
        setIsDeleting(true);
        try {
            // Resolve which server-side topic IDs belong to this fact (real +
            // noisy). Noisy topics share the same lifecycle as real topics —
            // include them in the withdrawal so we don't leave decoys orphaned
            // on the server.
            const links = await getFactTopicLinks(factToDelete.id);
            const noisyIds = await getNoisyTopicIdsForFact(factToDelete.id);
            const factTopicIds = [
                ...resolveTopicIdsForFact(factToDelete, links, interests),
                ...noisyIds,
            ];

            // Determine which topics would become exclusive to this fact if deleted
            // (compute WITHOUT deleting — we only delete locally after the server confirms)
            let exclusiveIds: string[] = [];
            if (factTopicIds.length > 0) {
                const allExistingLinks = await getFactTopicLinks();
                const allExistingFacts = await getFacts();
                const survivingTopicIds = new Set<string>();
                for (const f of allExistingFacts) {
                    if (f.id === factToDelete.id) continue;
                    const fLinks = allExistingLinks.filter(l => l.factId === f.id);
                    for (const id of resolveTopicIdsForFact(f, fLinks, interests)) {
                        survivingTopicIds.add(id);
                    }
                }
                // Noisy topics from OTHER facts also survive — guard against
                // a topicId that's noisy under both fact A and fact B.
                for (const link of noisyLinks) {
                    if (link.factId !== factToDelete.id) {
                        survivingTopicIds.add(link.serverTopicId);
                    }
                }
                exclusiveIds = factTopicIds.filter(id => !survivingTopicIds.has(id));
            }

            // Attempt server withdrawal, but don't block local deletion on it.
            // A fact stuck mid-generation has no valid server topics to withdraw,
            // and without this, the user would be trapped on a corrupt fact.
            // Worst case: a few orphaned UserTopic rows server-side.
            if (exclusiveIds.length > 0) {
                try {
                    await AccountService.withdrawUserTopics(userId, exclusiveIds);
                } catch (err) {
                    logger.error('[PersonaL1MeraProtocol] withdrawUserTopics failed — proceeding with local delete', err, {
                        factId: factToDelete.id,
                        exclusiveIds,
                    });
                }
            }

            await deleteFact(factToDelete.id);

            setFactToDelete(null);
            loadLocalFacts();
            fetchUserPersona(userId, true);
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
    }, [factToDelete, interests, noisyLinks, userId, loadLocalFacts, fetchUserPersona, toast, t]);

    const handleDeleteCancel = useCallback(() => {
        setFactToDelete(null);
    }, []);

    const handleRefreshSuggestions = useCallback(async () => {
        if (isRefreshingSuggestions) return;
        const personaId = userPersona?._id;
        if (!personaId) return;
        setIsRefreshingSuggestions(true);
        try {
            await useForYouStore.getState().clearData();
            await runSync(personaId);
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

    useEffect(() => {
        if (expandMeraChat) {
            useChatPopupStore.getState().expand();
        }
    }, [expandMeraChat]);

    const handleBubblePress = useCallback(() => {
        useChatPopupStore.getState().expand();
    }, []);

    const handleInterestPress = useCallback(
        (interest: UserTopic) => {
            router.push({
                pathname: '/logged-in/persona-articles',
                params: { interestId: interest._id, interestText: interest.news_topic_text },
            });
        },
        []
    );

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

                    <Box className="mx-4 mb-3 px-3 py-2 border border-primary-500 rounded-lg bg-gray-900">
                        <HStack className="items-start" space="sm">
                            <MaterialIcons name="shield" size={16} color="#9ca3af" style={{ marginTop: 2 }} />
                            <Text size="xs" className="text-gray-400 flex-1">
                                {isOnDeviceProcessing
                                    ? t('configPanel.privacyOnDevice')
                                    : t('configPanel.privacyCloud')}{' '}
                                <Text size="xs" className="text-primary-400 underline" onPress={() => openInAppBrowser(PRIVACY_URL)}>
                                    {t('configPanel.privacyPolicy')}
                                </Text>
                            </Text>
                        </HStack>
                    </Box>

                    <Box className="mx-4 mb-3">
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
                    </Box>

                    {isSyncing && (
                        <Box className="px-4 py-2">
                            <Text size="xs" className="text-gray-400 mb-1">{t('configPanel.updatingTopics', { completed, total })}</Text>
                            <Progress value={total > 0 ? (completed / total) * 100 : 0} size="sm">
                                <ProgressFilledTrack />
                            </Progress>
                        </Box>
                    )}

                    {localFacts.length === 0 && interests.length === 0 ? (
                        <VStack className="flex-1 items-center justify-center p-6" space="md">
                            <MaterialIcons name="chat" size={48} color="#666666" />
                            <Text size="md" className="text-gray-400 text-center">
                                {t('configPanel.emptyStateMessage')}
                            </Text>
                        </VStack>
                    ) : (
                        <ScrollView
                            showsVerticalScrollIndicator={false}
                            contentContainerStyle={{ paddingTop: 12, paddingBottom: 80 }}
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
                            {/* Facts heading + (debug) Noise switch */}
                            <HStack className="mx-4 mb-2 items-center justify-between">
                                <Text size="sm" className="text-gray-400 font-medium">{t('configPanel.factsHeading')}</Text>
                                {injectNoiseEnabled && (
                                    <HStack space="xs" className="items-center">
                                        <Text size="xs" className="text-red-400">
                                            {t('configPanel.noiseSwitchLabel')}
                                        </Text>
                                        <Switch
                                            size="sm"
                                            value={showNoise}
                                            onValueChange={setShowNoise}
                                            trackColor={{ false: '#374151', true: '#7f1d1d' }}
                                            thumbColor={showNoise ? '#fca5a5' : '#9ca3af'}
                                        />
                                    </HStack>
                                )}
                            </HStack>

                            {/* Fact accordions */}
                            {localFacts.map((fact) => {
                                const { real: realFactTopics, noisy: noisyFactTopics } = getTopicsForFact(fact);
                                const displayedTopics: { topic: UserTopic; isNoisy: boolean }[] = [
                                    ...realFactTopics.map((t) => ({ topic: t, isNoisy: false })),
                                    ...(showNoise
                                        ? noisyFactTopics.map((t) => ({ topic: t, isNoisy: true }))
                                        : []),
                                ];
                                const factTopics = realFactTopics; // settled-check is driven by REAL topics only
                                const expectedTopicCount = fact.metadata?.topics?.length ?? 0;
                                const topicGenError = fact.metadata?.topicGenError?.[0];
                                // Keep the spinner visible until topic-gen produced topics AND
                                // every one of them has been linked to a server-side UserTopic
                                // (i.e. appears in factTopics). This covers:
                                //   • topic-gen still running                        → expectedTopicCount === 0
                                //   • topic-gen done but server still indexing       → factTopics.length < expectedTopicCount
                                // On failure, topicGenError is set — stop spinning and surface the error.
                                const topicsSettled =
                                    !!topicGenError ||
                                    (expectedTopicCount > 0 && factTopics.length >= expectedTopicCount);
                                const isExpanded = expandedFactIds.has(fact.id);
                                return (
                                    <Box
                                        key={fact.id}
                                        className="mx-4 mb-3 border border-gray-700 rounded-lg overflow-hidden"
                                    >
                                        {/* Accordion header */}
                                        <Pressable onPress={() => toggleFact(fact.id)}>
                                            <HStack className="px-4 py-3 items-center justify-between">
                                                <Box className="flex-1 mr-3">
                                                    <TranslatableDynamic
                                                        text={fact.statement}
                                                        size="md"
                                                        className="text-white capitalize"
                                                        numberOfLines={2}
                                                    />
                                                </Box>
                                                <HStack space="sm" className="items-center">
                                                    {!topicsSettled && (
                                                        <Spinner size="small" />
                                                    )}
                                                    <Pressable
                                                        onPress={() => handleDeletePress(fact)}
                                                        hitSlop={8}
                                                    >
                                                        <MaterialIcons name="delete-outline" size={20} color="#ef4444" />
                                                    </Pressable>
                                                    <MaterialIcons
                                                        name={isExpanded ? 'expand-less' : 'expand-more'}
                                                        size={20}
                                                        color="#9ca3af"
                                                    />
                                                </HStack>
                                            </HStack>
                                        </Pressable>

                                        {/* Accordion body */}
                                        {isExpanded && (
                                            <Box className="border-t border-gray-700">
                                                {topicGenError ? (
                                                    <Box className="px-4 py-3">
                                                        <Text className="text-red-400 text-sm">
                                                            {t('configPanel.topicGenFailed', { error: topicGenError })}
                                                        </Text>
                                                    </Box>
                                                ) : !topicsSettled ? (
                                                    <Box className="px-4 py-3">
                                                        <Text className="text-typography-400 text-sm">
                                                            {expectedTopicCount === 0
                                                                ? t('configPanel.generatingTopics')
                                                                : t('configPanel.updatingTopics', {
                                                                    completed: factTopics.length,
                                                                    total: expectedTopicCount,
                                                                })}
                                                        </Text>
                                                    </Box>
                                                ) : (
                                                    displayedTopics.map(({ topic, isNoisy }, tIdx) => {
                                                        const isLast = tIdx === displayedTopics.length - 1;
                                                        const rowClass = isNoisy
                                                            ? `px-4 py-3 bg-red-950/30${isLast ? '' : ' border-b border-red-900/60'}`
                                                            : `px-4 py-3${isLast ? '' : ' border-b border-gray-800'}`;
                                                        return (
                                                            <Pressable
                                                                key={`${isNoisy ? 'n' : 'r'}-${topic._id}`}
                                                                onPress={() => handleInterestPress(topic)}
                                                                className={rowClass}
                                                            >
                                                                <HStack className="items-center justify-between">
                                                                    <VStack className="flex-1 mr-3" space="xs">
                                                                        <HStack space="xs" className="items-center">
                                                                            <TranslatableDynamic
                                                                                text={topic.news_topic_text}
                                                                                size="sm"
                                                                                className={isNoisy ? 'text-red-300' : 'text-white'}
                                                                            />
                                                                            {isNoisy && (
                                                                                <Text size="xs" className="text-red-400">
                                                                                    {t('configPanel.noiseBadge')}
                                                                                </Text>
                                                                            )}
                                                                        </HStack>
                                                                        <Text size="xs" className={isNoisy ? 'text-red-500' : 'text-gray-500'}>
                                                                            {t('configPanel.clusterCount', { count: topic.cluster_count })}
                                                                        </Text>
                                                                    </VStack>
                                                                    <MaterialIcons
                                                                        name="chevron-right"
                                                                        size={18}
                                                                        color={isNoisy ? '#fca5a5' : '#999999'}
                                                                    />
                                                                </HStack>
                                                            </Pressable>
                                                        );
                                                    })
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

            {!isChatExpanded && (
                <Box style={{ position: 'absolute', bottom: 8, alignSelf: 'center', width: '100%', alignItems: 'center' }}>
                    <MeraAIBubble onPress={handleBubblePress} />
                </Box>
            )}

            {isChatExpanded && (
                <View
                    style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, justifyContent: 'flex-end' }}
                    pointerEvents="box-none"
                >
                    <RNPressable
                        style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }}
                        onPress={() => Keyboard.dismiss()}
                    />
                    <KeyboardStickyView offset={{ closed: -(insets.bottom + 16) }}>
                        <View
                            style={{
                                backgroundColor: 'transparent',
                                borderTopLeftRadius: 24,
                                borderTopRightRadius: 24,
                                borderTopWidth: 1,
                                borderLeftWidth: 1,
                                borderRightWidth: 1,
                                borderColor: 'transparent',
                                minHeight: Dimensions.get('window').height * 0.35,
                                paddingTop: 16,
                                justifyContent: 'flex-end',
                            }}
                        >
                            <MeraPersonaUpdateChat onClose={closeChat} />
                        </View>
                    </KeyboardStickyView>
                </View>
            )}

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
