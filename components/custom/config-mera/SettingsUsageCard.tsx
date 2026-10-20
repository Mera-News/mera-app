import { Pressable } from '@/components/ui/pressable';
import { Text } from '@/components/ui/text';
import { fetchUserBilling } from '@/lib/billing-service';
import type { UserBillingInfo } from '@/lib/generated/graphql-types';
import { getActiveTier } from '@/lib/revenuecat';
import { useSubscriptionStore } from '@/lib/stores/subscription-store';
import { useColors } from '@/lib/theme/tokens';
import { resolvePlanDisplay } from '@/lib/algorithms/plan-display';
import { router, useFocusEffect } from 'expo-router';
import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';
import ReadingMeter, { useReadingFetch } from './ReadingMeter';

/**
 * The plan card at the TOP of Settings (FinalSettings #1): plan name, Manage
 * plan (the only plan entry in Settings), then the reading meter. Offline with
 * nothing known the meter says so; it never shows a made-up figure.
 *
 * Billing is fetched on focus (the tab stays mounted) and again whenever the
 * shared server tier changes, so a purchase made elsewhere shows here at once.
 */
const SettingsUsageCard: React.FC = () => {
    const { t } = useTranslation();
    const colors = useColors();
    const [billing, setBilling] = useState<UserBillingInfo | null>(null);

    const refreshBilling = useCallback(() => {
        fetchUserBilling()
            .then((fresh) => {
                setBilling(fresh);
                // Mirrored into the store so the tier lifts app-wide; this
                // focus refresh also heals a purchase whose webhook outlived
                // every poll.
                useSubscriptionStore.getState().setServerBilling(fresh);
            })
            .catch(() => { /* offline: no figure */ });
    }, []);

    useFocusEffect(
        useCallback(() => {
            refreshBilling();
        }, [refreshBilling]),
    );

    // A purchase confirmed on another screen mirrors into the shared store;
    // re-fetch when the shared tier moves.
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
        ? null
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

    const reading = useReadingFetch();

    return (
        <View
            testID="settings-plan-card"
            style={{
                gap: 10,
                padding: 16,
                borderRadius: 16,
                backgroundColor: colors.surface,
                borderWidth: 1,
                borderColor: colors.line,
            }}
        >
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                <View style={{ flex: 1 }}>
                    {planLabel ? (
                        <Text testID="settings-plan-name" style={{ color: colors.ink, fontSize: 16, fontWeight: '700' }}>
                            {planLabel}
                        </Text>
                    ) : null}
                    <Text style={{ color: colors.ink2, fontSize: 13 }}>{t('you.settings.yourPlan')}</Text>
                </View>
                <Pressable
                    testID="settings-manage-plan"
                    onPress={() => router.push('/logged-in/preferences/manage-subscription')}
                    accessibilityRole="button"
                    accessibilityLabel={t('subscription.managePlan')}
                    style={{
                        minHeight: 44,
                        paddingHorizontal: 14,
                        borderRadius: 999,
                        borderWidth: 1,
                        borderColor: colors.trackBorder,
                        justifyContent: 'center',
                    }}
                >
                    <Text style={{ color: colors.ink, fontSize: 14, fontWeight: '600' }}>{t('subscription.managePlan')}</Text>
                </Pressable>
            </View>
            <ReadingMeter size="card" {...reading} />
        </View>
    );
};

export default SettingsUsageCard;
