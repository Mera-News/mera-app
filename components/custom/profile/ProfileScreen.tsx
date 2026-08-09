import BlockedBanner from '@/components/custom/BlockedBanner';
import UsageWidget from '@/components/custom/UsageWidget';
import FactsList from '@/components/custom/facts/FactsList';
import MeraChatInvite from '@/components/custom/profile/MeraChatInvite';
import HubRow from '@/components/custom/profile-hub/HubRow';
import { useFreeTierReadOnly } from '@/components/custom/subscription/FreeTierReadOnlyBanner';
import { Box } from '@/components/ui/box';
import { Button, ButtonIcon, ButtonText } from '@/components/ui/button';
import { HStack } from '@/components/ui/hstack';
import { Heading } from '@/components/ui/heading';
import { HelpCircleIcon } from '@/components/ui/icon';
import { Modal, ModalBackdrop, ModalBody, ModalContent, ModalFooter, ModalHeader } from '@/components/ui/modal';
import { Text } from '@/components/ui/text';
import { fetchUserBilling } from '@/lib/billing-service';
import { useSubscriptionStore } from '@/lib/stores/subscription-store';
import { resolvePlanDisplay } from '@/lib/subscription/plan-display';
import { getTotalArticleSuggestionCount } from '@/lib/database/services/article-suggestion-service';
import { getFacts } from '@/lib/database/services/fact-service';
import type { UserBillingInfo } from '@/lib/generated/graphql-types';
import { getActiveTier } from '@/lib/revenuecat';
import { useFloatingChatFactMutationVersion } from '@/lib/stores/floating-chat-store';
import { useUserStore } from '@/lib/stores/user-store';
import { notifyScrollTick } from '@/lib/visibility-tick';
import { MaterialIcons } from '@expo/vector-icons';
import { router, useFocusEffect } from 'expo-router';
import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ScrollView } from 'react-native';

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
    // ProfileScreen is only reached via the main tab navigator (after
    // onboarding, a separate route) — no isOnboarding exemption needed here,
    // unlike MeraProtocolSettingsScreen which is also mounted mid-onboarding.
    const readOnly = useFreeTierReadOnly();

    const [factCount, setFactCount] = useState<number | null>(null);
    const [billing, setBilling] = useState<UserBillingInfo | null>(null);
    const [totalArticleCount, setTotalArticleCount] = useState(0);
    const [showArticleCountInfo, setShowArticleCountInfo] = useState(false);
    // A purchase completed but the server has not confirmed the new tier yet.
    // Mirrors NotSubscribedScreen's `activationDelayed` handling: an honest
    // "still working on it" beats committing a snapshot we know is stale.

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
        fetchUserBilling()
            .then((fresh) => {
                setBilling(fresh);
                // Mirror into the store too, so the free-tier state lifts app-wide
                // and not just on this card. This focus-driven refresh is also
                // the backstop that eventually heals a purchase whose webhook
                // outlived every poll below.
                useSubscriptionStore.getState().setServerBilling(fresh);
            })
            .catch(() => { /* offline fallback */ });
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

    // A purchase confirmed on ANOTHER screen (e.g. Manage Subscription) mirrors
    // its result into the shared store (`setServerBilling`), but this screen
    // keeps its own local `billing` copy for the full usage-card snapshot
    // (limit/used-today aren't tracked in the store). Without this, Profile
    // stays stuck on its last local fetch until it happens to regain focus —
    // exactly the "purchased elsewhere, still shows the old plan here" bug.
    // Re-fetching the moment the shared tier changes closes that gap
    // immediately, independent of navigation.
    const storeServerTier = useSubscriptionStore((s) => s.serverTier);
    const customerInfo = useSubscriptionStore((s) => s.customerInfo);
    const rcTier = getActiveTier(customerInfo);
    useEffect(() => {
        if (storeServerTier == null) return;
        setBilling((current) => {
            if (current && current.subscriptionTier === storeServerTier) return current;
            refreshBilling();
            return current;
        });
    }, [storeServerTier, refreshBilling]);

    // A chat (or sheet) that mutated facts bumps this — refresh the count so the
    // empty-persona CTA flips promptly.
    useEffect(() => {
        if (factMutationVersion > 0) {
            refreshFactCount();
        }
    }, [factMutationVersion, refreshFactCount]);

    const isBlocked = userPersona?.blockedByLlm ?? false;
    const isEmptyPersona = factCount === 0;

    // ONE rule, shared with ManageSubscriptionScreen — see plan-display.ts.
    // This screen used to derive the label here and the free-tier notice from
    // `deriveAiAccess`, which have DIFFERENT fallbacks: the label fell back to
    // RevenueCat's tier, the gate deliberately does not. The result was a
    // Profile card reading "Individual Plan" directly above a notice saying the
    // user had no plan. Both were right by their own rule; the rule was the bug.
    const planDisplay = resolvePlanDisplay({
        serverTier: billing?.subscriptionTier,
        rcTier,
        serverLoaded: billing != null,
    });
    const effectiveTier = planDisplay.tier ?? undefined;

    // `pending` means the plan name came from RevenueCat and the server has NOT
    // confirmed it — the gate below is still locked. Saying "activating" rather
    // than naming it flat is the difference between the card agreeing with the
    // free-tier notice and contradicting it.
    const planLabel = !planDisplay.known
        // Still loading — no label beats a wrong one; avoids a flash on every
        // cold mount before the first fetch resolves.
        ? undefined
        : planDisplay.tier == null
            ? t('subscription.freePlan')
            : (() => {
                const name =
                    planDisplay.tier === 'professional'
                        ? t('configPanel.professionalPlan')
                        : planDisplay.tier === 'individual'
                            ? t('configPanel.individualPlan')
                            : t('configPanel.starterPlan');
                return planDisplay.pending
                    ? t('subscription.planPending', { plan: name })
                    : name;
            })();

    return (
        // No `bg-black`: ProfileTabScreen mounts AbstractGradientBackdrop
        // behind this screen — an opaque fill here would fully block it,
        // leaving the fact rows/accordions below with nothing to show through.
        <Box className="flex-1">
            {/* Screen heading — mirrors the ForYou/Explore top-left title idiom. */}
            <HStack className="items-center justify-between px-5 pt-4 mb-2">
                {/* Clamp AND scale, matching Feed/Dashboard/Explore: a bare
                    1-line clamp truncated the screen's own name at large Dynamic
                    Type, and letting it wrap breaks a single long localized word
                    mid-word. One line, shrunk to fit, is Apple's own answer for a
                    title that shares its row with a control — and this row now
                    has one. */}
                <Heading
                    size="4xl"
                    className="text-white flex-1 mr-3"
                    numberOfLines={1}
                >
                    {t('tabs.profile')}
                </Heading>
                {/* `/tutorials` is a TOP-LEVEL route, not nested under
                    /logged-in — pushing a nested path here silently no-ops.
                    Same target as the paywall screen's "Learn how Mera works",
                    so both entry points land in the same place. */}
                <Button
                    testID="profile-learn-about-mera"
                    variant="outline"
                    size="xs"
                    className="rounded-full flex-shrink-0"
                    onPress={() => router.push('/tutorials' as any)}
                >
                    <ButtonIcon as={HelpCircleIcon} className="mr-1 text-white" />
                    <ButtonText className="text-white">
                        {t('tutorials.learnAboutMera')}
                    </ButtonText>
                </Button>
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
                    planLabel={planLabel}
                    // "Manage", not "Upgrade": this pill now opens subscription
                    // management instead of the paywall, so it is NOT gated on
                    // tier the way the paywall version was. A professional
                    // subscriber had nothing to upgrade to and so got no pill at
                    // all — but they still have a plan to manage, and this tab
                    // was their only route to it besides Settings.
                    onUpgrade={() =>
                        router.push('/logged-in/preferences/manage-subscription' as any)
                    }
                    upgradeLabel={t('subscription.manageBadge')}
                    upgradeIcon="credit-card"
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

                        <FactsList readOnly={readOnly} />
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
