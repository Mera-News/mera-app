import UsageWidget from '@/components/custom/UsageWidget';
import { Button, ButtonText } from '@/components/ui/button';
import { HStack } from '@/components/ui/hstack';
import { Modal, ModalBackdrop, ModalBody, ModalContent, ModalFooter, ModalHeader } from '@/components/ui/modal';
import { Text } from '@/components/ui/text';
import { fetchUserBilling } from '@/lib/billing-service';
import { getTotalArticleSuggestionCount } from '@/lib/database/services/article-suggestion-service';
import type { UserBillingInfo } from '@/lib/generated/graphql-types';
import { getActiveTier } from '@/lib/revenuecat';
import { useSubscriptionStore } from '@/lib/stores/subscription-store';
import { resolvePlanDisplay } from '@/lib/subscription/plan-display';
import { MaterialIcons } from '@expo/vector-icons';
import { router, useFocusEffect } from 'expo-router';
import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

/**
 * The daily-usage card at the TOP of Settings (owner call: it moved here from
 * Profile, which is about the person, not the plan). Its "Manage plan" button
 * is the Settings entry to plan management; there is no separate Account row.
 * Manage subscription keeps its own UsageWidget.
 *
 * Billing is fetched on focus (the tab stays mounted) and again whenever the
 * shared server tier changes, so a purchase made elsewhere shows here at once.
 */
const SettingsUsageCard: React.FC = () => {
    const { t } = useTranslation();
    const [billing, setBilling] = useState<UserBillingInfo | null>(null);
    const [totalArticleCount, setTotalArticleCount] = useState(0);
    const [showInfo, setShowInfo] = useState(false);

    const refreshBilling = useCallback(() => {
        fetchUserBilling()
            .then((fresh) => {
                setBilling(fresh);
                // Mirrored into the store so the tier lifts app-wide; this
                // focus refresh also heals a purchase whose webhook outlived
                // every poll.
                useSubscriptionStore.getState().setServerBilling(fresh);
            })
            .catch(() => { /* offline: the local count stands in */ });
    }, []);

    useEffect(() => {
        getTotalArticleSuggestionCount().then(setTotalArticleCount).catch(() => { /* keep last */ });
    }, []);

    useFocusEffect(
        useCallback(() => {
            refreshBilling();
        }, [refreshBilling]),
    );

    // A purchase confirmed on another screen mirrors into the shared store;
    // this card keeps its own snapshot (limit and used-today are not in the
    // store), so it re-fetches when the shared tier moves.
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

    // ONE rule, shared with ManageSubscriptionScreen: see plan-display.ts.
    const planDisplay = resolvePlanDisplay({
        serverTier: billing?.subscriptionTier,
        rcTier,
        serverLoaded: billing != null,
    });
    const planLabel = !planDisplay.known
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
                return planDisplay.pending ? t('subscription.planPending', { plan: name }) : name;
            })();

    return (
        <>
            <UsageWidget
                className="mb-2"
                used={billing?.articlesUsedToday ?? totalArticleCount}
                limit={billing?.dailyArticleLimit ?? null}
                usedLabel={t('configPanel.articlesAnalyzedLast24h')}
                planLabel={planLabel}
                onUpgrade={() => router.push('/logged-in/preferences/manage-subscription' as any)}
                upgradeLabel={t('subscription.managePlan')}
                upgradeIcon="credit-card"
                resetAt={billing?.resetAt}
                resetLabel={t('configPanel.resetsOn')}
                onInfoPress={() => setShowInfo(true)}
            />
            <Modal isOpen={showInfo} onClose={() => setShowInfo(false)} size="sm">
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
                        <Button variant="outline" action="secondary" onPress={() => setShowInfo(false)} className="w-full">
                            <ButtonText>{t('configPanel.gotIt')}</ButtonText>
                        </Button>
                    </ModalFooter>
                </ModalContent>
            </Modal>
        </>
    );
};

export default SettingsUsageCard;
