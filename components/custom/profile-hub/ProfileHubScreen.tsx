import BlockedBanner from '@/components/custom/BlockedBanner';
import UsageWidget from '@/components/custom/UsageWidget';
import HubRow from '@/components/custom/profile-hub/HubRow';
import { Box } from '@/components/ui/box';
import { Button, ButtonText } from '@/components/ui/button';
import { HStack } from '@/components/ui/hstack';
import { Modal, ModalBackdrop, ModalBody, ModalContent, ModalFooter, ModalHeader } from '@/components/ui/modal';
import { Spinner } from '@/components/ui/spinner';
import { Text } from '@/components/ui/text';
import { Toast, ToastDescription, ToastTitle, useToast } from '@/components/ui/toast';
import { fetchUserBilling } from '@/lib/billing-service';
import { getTotalArticleSuggestionCount } from '@/lib/database/services/article-suggestion-service';
import { getFacts } from '@/lib/database/services/fact-service';
import { getActive } from '@/lib/database/services/publication-preference-service';
import { getPendingCount, subscribeHygieneChange } from '@/lib/database/services/hygiene-service';
import type { UserBillingInfo } from '@/lib/generated/graphql-types';
import logger from '@/lib/logger';
import { getOfferingSafe } from '@/lib/revenuecat';
import { AppScheduler } from '@/lib/scheduler/AppScheduler';
import { useFloatingChatFactMutationVersion } from '@/lib/stores/floating-chat-store';
import { useForYouStore } from '@/lib/stores/for-you-store';
import { useUserStore } from '@/lib/stores/user-store';
import { notifyScrollTick } from '@/lib/visibility-tick';
import { MaterialIcons } from '@expo/vector-icons';
import { router, useFocusEffect } from 'expo-router';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Animated, ScrollView, View } from 'react-native';
import RevenueCatUI from 'react-native-purchases-ui';

interface ProfileHubScreenProps {
    readonly userId: string;
}

/**
 * Profile hub (Wave 12). Replaces PersonaL1MeraProtocol's megascroll: keeps the
 * blocked banner, daily-usage widget (with its upgrade/paywall handling), and
 * the refresh-suggestions button, then exposes the persona surfaces as focused
 * hub rows (Facts / Locations / Saved / Source preferences / Activity / Persona
 * health) that push dedicated sub-screens. The floating chat bubble stays docked
 * at the ProfileTabScreen level.
 */
const ProfileHubScreen: React.FC<ProfileHubScreenProps> = ({ userId }) => {
    const { t } = useTranslation();
    const toast = useToast();
    const { userPersona, fetchUserPersona } = useUserStore();
    const [isLoading, setIsLoading] = useState(true);
    const [billing, setBilling] = useState<UserBillingInfo | null>(null);
    const [totalArticleCount, setTotalArticleCount] = useState(0);
    const [factCount, setFactCount] = useState(0);
    const [prefCount, setPrefCount] = useState(0);
    const [hygieneCount, setHygieneCount] = useState(0);
    const [showArticleCountInfo, setShowArticleCountInfo] = useState(false);
    const [isRefreshingSuggestions, setIsRefreshingSuggestions] = useState(false);

    const feedNeedsRefresh = useForYouStore(s => s.feedNeedsRefresh);
    const factMutationVersion = useFloatingChatFactMutationVersion();
    const glowAnim = useRef(new Animated.Value(0.3)).current;

    // Lightweight counts for the hub-row subtitles/badges. Refreshed on focus so
    // returning from a sub-screen (or the chat) reflects the latest state.
    const refreshCounts = useCallback(() => {
        getFacts().then(f => setFactCount(f.length)).catch(() => { /* keep last */ });
        getActive().then(p => setPrefCount(p.length)).catch(() => { /* keep last */ });
        getTotalArticleSuggestionCount().then(setTotalArticleCount).catch(() => { /* keep last */ });
    }, []);

    const refreshHygieneCount = useCallback(() => {
        getPendingCount()
            .then(setHygieneCount)
            .catch(() => { /* non-fatal — leave the last count */ });
    }, []);

    useEffect(() => {
        const init = async () => {
            setIsLoading(true);
            await Promise.all([
                fetchUserBilling().then(setBilling).catch(() => { /* offline fallback */ }),
                !userPersona && userId ? fetchUserPersona(userId) : Promise.resolve(),
                Promise.resolve(refreshCounts()),
                Promise.resolve(refreshHygieneCount()),
            ]);
            setIsLoading(false);
        };
        init();
    }, [userId, userPersona, fetchUserPersona, refreshCounts, refreshHygieneCount]);

    // Hygiene count reacts to sweep/accept/reject changes.
    useEffect(() => {
        refreshHygieneCount();
        return subscribeHygieneChange(refreshHygieneCount);
    }, [refreshHygieneCount]);

    // Refresh counts + hygiene whenever the tab regains focus.
    useFocusEffect(
        useCallback(() => {
            refreshCounts();
            refreshHygieneCount();
        }, [refreshCounts, refreshHygieneCount]),
    );

    // On-device LLM fact mutations bump the fact count + mark the feed stale.
    useEffect(() => {
        if (factMutationVersion > 0) {
            refreshCounts();
        }
    }, [factMutationVersion, refreshCounts]);

    // Glow pulse on the refresh-suggestions button while the feed is stale.
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
        }
        glowAnim.stopAnimation();
        glowAnim.setValue(0);
    }, [feedNeedsRefresh, glowAnim]);

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

    const handleUpgrade = useCallback(async () => {
        try {
            const offering = await getOfferingSafe();
            await RevenueCatUI.presentPaywall({
                ...(offering ? { offering } : {}),
                displayCloseButton: true,
            });
        } catch (error) {
            logger.captureException(error, {
                tags: { component: 'ProfileHubScreen', method: 'upgrade' },
            });
        }
    }, []);

    const isBlocked = userPersona?.blockedByLlm ?? false;

    const factsSubtitle = factCount > 0
        ? t('profileHub.factsCount', { count: factCount, defaultValue: '{{count}} facts shaping your feed' })
        : t('profileHub.factsEmpty', { defaultValue: 'Tap to add what Mera should know' });
    const prefsSubtitle = prefCount > 0
        ? t('profileHub.prefsCount', { count: prefCount, defaultValue: '{{count}} sources adjusted' })
        : t('profileHub.prefsEmpty', { defaultValue: 'Boost, downrank or mute sources' });
    const hygieneSubtitle = hygieneCount > 0
        ? t('profileHub.healthPending', { count: hygieneCount, defaultValue: '{{count}} cleanup suggestions' })
        : t('profileHub.healthAllHealthy', { defaultValue: 'All healthy' });

    if (isLoading) {
        return (
            <Box className="flex-1 items-center justify-center">
                <Spinner size="large" />
            </Box>
        );
    }

    return (
        <Box className="flex-1">
            <ScrollView
                showsVerticalScrollIndicator={false}
                contentContainerStyle={{ paddingTop: 12, paddingBottom: 120 }}
                onScroll={notifyScrollTick}
                scrollEventThrottle={16}
            >
                {isBlocked && <BlockedBanner reason={userPersona?.blockedByLlmReason} />}

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

                {/* Refresh-suggestions button (compact) with stale-feed glow. */}
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

                {/* Hub rows */}
                <Box className="px-4">
                    <HubRow
                        icon="psychology"
                        label={t('profileHub.facts', { defaultValue: 'Facts' })}
                        subtitle={factsSubtitle}
                        onPress={() => router.push('/logged-in/facts')}
                    />
                    <HubRow
                        icon="place"
                        label={t('profileHub.locations', { defaultValue: 'Locations' })}
                        subtitle={t('profileHub.locationsSubtitle', { defaultValue: 'Places that shape your feed' })}
                        onPress={() => router.push('/logged-in/locations')}
                    />
                    <HubRow
                        icon="bookmark"
                        label={t('profileHub.saved', { defaultValue: 'Saved' })}
                        subtitle={t('profileHub.savedSubtitle', { defaultValue: 'Articles you saved for later' })}
                        onPress={() => router.push('/logged-in/saved-suggestions')}
                    />
                    <HubRow
                        icon="tune"
                        label={t('profileHub.preferences', { defaultValue: 'Source preferences' })}
                        subtitle={prefsSubtitle}
                        onPress={() => router.push('/logged-in/publication-preferences')}
                    />
                    <HubRow
                        icon="history"
                        label={t('profileHub.activity', { defaultValue: 'Activity' })}
                        subtitle={t('profileHub.activitySubtitle', { defaultValue: 'Your persona change history' })}
                        onPress={() => router.push('/logged-in/persona-audit')}
                    />
                    <HubRow
                        icon="cleaning-services"
                        label={t('profileHub.personaHealth', { defaultValue: 'Persona health' })}
                        subtitle={hygieneSubtitle}
                        badgeCount={hygieneCount}
                        onPress={() => router.push('/logged-in/hygiene-review')}
                    />
                </Box>
            </ScrollView>

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
        </Box>
    );
};

export default ProfileHubScreen;
