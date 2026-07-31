import BlockedBanner from '@/components/custom/BlockedBanner';
import UsageWidget from '@/components/custom/UsageWidget';
import FactsList from '@/components/custom/facts/FactsList';
import MeraChatInvite from '@/components/custom/profile/MeraChatInvite';
import HubRow from '@/components/custom/profile-hub/HubRow';
import { Box } from '@/components/ui/box';
import { Button, ButtonText } from '@/components/ui/button';
import { HStack } from '@/components/ui/hstack';
import { Heading } from '@/components/ui/heading';
import { Modal, ModalBackdrop, ModalBody, ModalContent, ModalFooter, ModalHeader } from '@/components/ui/modal';
import { Text } from '@/components/ui/text';
import { fetchUserBilling, refreshUserBillingAfterPurchase } from '@/lib/billing-service';
import { getTotalArticleSuggestionCount } from '@/lib/database/services/article-suggestion-service';
import { getFacts } from '@/lib/database/services/fact-service';
import type { UserBillingInfo } from '@/lib/generated/graphql-types';
import logger from '@/lib/logger';
import { getOfferingSafe } from '@/lib/revenuecat';
import { useFloatingChatFactMutationVersion } from '@/lib/stores/floating-chat-store';
import { useUserStore } from '@/lib/stores/user-store';
import { notifyScrollTick } from '@/lib/visibility-tick';
import { MaterialIcons } from '@expo/vector-icons';
import { router, useFocusEffect } from 'expo-router';
import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ScrollView } from 'react-native';
import RevenueCatUI, { PAYWALL_RESULT } from 'react-native-purchases-ui';

interface ProfileScreenProps {
    readonly userId: string;
}

/**
 * Mirror-first Profile tab (redesign). A completely non-technical user sees:
 *   1. The daily-usage card (articles analyzed today, plan + upgrade, reset
 *      time) — moved here from the Advanced hub so usage is always visible.
 *   2. "About you" — the real facts list (`FactsList`, shared with the Your
 *      Facts screen under Advanced): delete, N-articles pill, chevron expand
 *      → topics. (A brand-new user with no persona instead sees a "Start
 *      talking" CTA.)
 *   3. One "Advanced" row → the full power-user hub (AdvancedHubScreen).
 *
 * Wave r6b replaced the old LLM-generated persona-summary strings (+
 * PersonaStringSheet nudge/refine/remove flow) with this list — `FactsList`
 * owns its own real-time refresh (chat mutations, queue drains); this screen
 * only tracks the fact count to drive the empty-persona CTA.
 */
const ProfileScreen: React.FC<ProfileScreenProps> = ({ userId }) => {
    const { t } = useTranslation();
    const { userPersona, fetchUserPersona } = useUserStore();
    const factMutationVersion = useFloatingChatFactMutationVersion();

    const [factCount, setFactCount] = useState<number | null>(null);
    const [billing, setBilling] = useState<UserBillingInfo | null>(null);
    const [totalArticleCount, setTotalArticleCount] = useState(0);
    const [showArticleCountInfo, setShowArticleCountInfo] = useState(false);

    // Fact count (drives the empty-persona state) + persona (blocked banner).
    const refreshFactCount = useCallback(() => {
        getFacts().then((f) => setFactCount(f.length)).catch(() => { /* keep last */ });
    }, []);

    useEffect(() => {
        refreshFactCount();
        if (!userPersona && userId) fetchUserPersona(userId).catch(() => { /* offline */ });
    }, [userId, userPersona, fetchUserPersona, refreshFactCount]);

    // Billing + on-device article count drive the daily-usage card. Both are
    // best-effort — the widget falls back to the local count when offline.
    const refreshBilling = useCallback(() => {
        fetchUserBilling().then(setBilling).catch(() => { /* offline fallback */ });
    }, []);

    useEffect(() => {
        refreshBilling();
        getTotalArticleSuggestionCount().then(setTotalArticleCount).catch(() => { /* keep last */ });
    }, [refreshBilling]);

    // Refresh the fact count and the usage card on focus (tabs stay mounted →
    // focus fires on every switch back) — the fact count drives the
    // empty-persona CTA, and billing would otherwise stay frozen at whatever it
    // was when the tab first mounted, including after a purchase made
    // elsewhere. FactsList (rendered below) owns its own real-time refresh for
    // the list itself.
    useFocusEffect(
        useCallback(() => {
            refreshFactCount();
            refreshBilling();
        }, [refreshFactCount, refreshBilling]),
    );

    // A chat (or sheet) that mutated facts bumps this — refresh the count so the
    // empty-persona CTA flips promptly.
    useEffect(() => {
        if (factMutationVersion > 0) {
            refreshFactCount();
        }
    }, [factMutationVersion, refreshFactCount]);

    const handleUpgrade = useCallback(async () => {
        try {
            const offering = await getOfferingSafe();
            const result = await RevenueCatUI.presentPaywall({
                ...(offering ? { offering } : {}),
                displayCloseButton: true,
            });
            // A purchase is a discrete event — refresh the usage card on it
            // rather than leaving the old plan on screen until the next focus.
            // The webhook is async, so this retries briefly (bounded).
            if (result === PAYWALL_RESULT.PURCHASED || result === PAYWALL_RESULT.RESTORED) {
                const fresh = await refreshUserBillingAfterPurchase(billing?.subscriptionTier ?? null);
                if (fresh) setBilling(fresh);
            }
        } catch (error) {
            logger.captureException(error, {
                tags: { component: 'ProfileScreen', method: 'upgrade' },
            });
        }
    }, [billing?.subscriptionTier]);

    const isBlocked = userPersona?.blockedByLlm ?? false;
    const isEmptyPersona = factCount === 0;

    return (
        // No `bg-black`: ProfileTabScreen mounts AbstractGradientBackdrop
        // behind this screen — an opaque fill here would fully block it,
        // leaving the fact rows/accordions below with nothing to show through.
        <Box className="flex-1">
            {/* Screen heading — mirrors the ForYou/Explore top-left title idiom. */}
            <HStack className="items-start justify-between px-5 pt-4 mb-2">
                <Heading size="3xl" className="text-white" numberOfLines={1}>
                    {t('tabs.profile')}
                </Heading>
            </HStack>

            <ScrollView
                showsVerticalScrollIndicator={false}
                contentContainerStyle={{ paddingTop: 8, paddingBottom: 140 }}
                onScroll={notifyScrollTick}
                scrollEventThrottle={16}
            >
                {isBlocked && <BlockedBanner reason={userPersona?.blockedByLlmReason} />}

                {/* 1 — Daily-usage card (moved from the Advanced hub) */}
                <UsageWidget
                    className="mx-4 mt-2 mb-5"
                    used={billing?.articlesUsedToday ?? totalArticleCount}
                    limit={billing?.dailyArticleLimit ?? null}
                    usedLabel={t('configPanel.articlesAnalyzedLast24h')}
                    planLabel={
                        billing?.subscriptionTier === 'professional'
                            ? t('configPanel.professionalPlan')
                            : billing?.subscriptionTier === 'individual'
                                ? t('configPanel.individualPlan')
                                : billing?.subscriptionTier === 'starter'
                                    ? t('configPanel.starterPlan')
                                    : t('configPanel.promoPlan')
                    }
                    onUpgrade={billing?.subscriptionTier === 'professional' ? undefined : handleUpgrade}
                    upgradeLabel={t('subscription.upgrade')}
                    resetAt={billing?.resetAt}
                    resetLabel={t('configPanel.resetsOn')}
                    onInfoPress={() => setShowArticleCountInfo(true)}
                />

                {/* Mera chat invite — static comic speech bubble + logo, replaces
                    the former floating bubble. Taps open the persona chat. */}
                <MeraChatInvite />

                {/* 2 — About you (the real facts list — same component FactsScreen uses).
                    No outer px-4 here: FactAccordion carries its own mx-4 inset, matching
                    FactsScreen's layout — an extra wrapper padding would double-indent it. */}
                {!isEmptyPersona && (
                    <Box className="mb-4">
                        <HStack className="mx-4 mb-2 items-center justify-between">
                            <Text className="text-gray-400" style={{ fontSize: 13, fontWeight: '600', letterSpacing: 0.4 }}>
                                {t('profile.aboutYou', { defaultValue: 'ABOUT YOU' }).toUpperCase()}
                            </Text>
                        </HStack>

                        <FactsList />
                    </Box>
                )}

                {/* 3 — Advanced */}
                <Box className="px-4">
                    <HubRow
                        testID="profile-row-advanced"
                        icon="tune"
                        label={t('profile.advanced', { defaultValue: 'Advanced' })}
                        subtitle={t('profile.advancedSubtitle', { defaultValue: 'Facts, sources, saved, activity and more' })}
                        onPress={() => router.push('/logged-in/profile-advanced')}
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

export default ProfileScreen;
