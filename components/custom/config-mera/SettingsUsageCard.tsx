import { Pressable } from '@/components/ui/pressable';
import { Text } from '@/components/ui/text';
import { fetchUserBilling } from '@/lib/billing-service';
import type { UserBillingInfo } from '@/lib/generated/graphql-types';
import { getActiveTier } from '@/lib/revenuecat';
import { useSubscriptionStore } from '@/lib/stores/subscription-store';
import { resolvePlanDisplay } from '@/lib/subscription/plan-display';
import { router, useFocusEffect } from 'expo-router';
import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

const ACCENT = '#E78A53';

/** "02:00" in the reader's own time and locale; null when unusable. */
export function formatResetTime(resetAt: string | null | undefined, language?: string): string | null {
    if (!resetAt) return null;
    const date = new Date(resetAt);
    if (Number.isNaN(date.getTime())) return null;
    try {
        return date.toLocaleTimeString(language, { hour: '2-digit', minute: '2-digit' });
    } catch {
        return date.toLocaleTimeString();
    }
}

/**
 * The plan card at the TOP of Settings: plan name, Manage plan (the only plan
 * entry in Settings), and one usage line.
 *
 * The usage figure is `articlesUsedToday`: articles DELIVERED in the current
 * UTC day. Say "articles today", never "analysed": no analysed-count ledger
 * exists. Offline there is no figure at all; the old fallback was the all-time
 * local suggestion count, which read as a false "today".
 *
 * Billing is fetched on focus (the tab stays mounted) and again whenever the
 * shared server tier changes, so a purchase made elsewhere shows here at once.
 */
const SettingsUsageCard: React.FC = () => {
    const { t, i18n } = useTranslation();
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

    const usageLine = (() => {
        if (!billing) return t('you.settings.usageOffline');
        const used = billing.articlesUsedToday ?? 0;
        const limit = billing.dailyArticleLimit;
        const usage =
            typeof limit === 'number' && limit > 0
                ? t('you.settings.usage', { count: used, limit })
                : t('you.settings.usageNoLimit', { count: used });
        const reset = formatResetTime(billing.resetAt, i18n?.language);
        return reset ? `${usage} · ${t('you.settings.resetsAt', { time: reset })}` : usage;
    })();

    return (
        <View
            testID="settings-plan-card"
            style={{
                gap: 10,
                paddingVertical: 12,
                paddingHorizontal: 14,
                borderRadius: 14,
                backgroundColor: 'rgba(255,255,255,0.07)',
                borderWidth: 1,
                borderColor: 'rgba(255,255,255,0.10)',
            }}
        >
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                <View style={{ flex: 1 }}>
                    {planLabel ? (
                        <Text testID="settings-plan-name" style={{ color: '#ffffff', fontSize: 15 }}>
                            {planLabel}
                        </Text>
                    ) : null}
                    <Text style={{ color: '#A3A3A3', fontSize: 13 }}>{t('you.settings.yourPlan')}</Text>
                </View>
                <Pressable
                    testID="settings-manage-plan"
                    onPress={() => router.push('/logged-in/preferences/manage-subscription')}
                    accessibilityRole="button"
                    accessibilityLabel={t('subscription.managePlan')}
                    style={{ minHeight: 44, paddingHorizontal: 16, borderRadius: 999, backgroundColor: ACCENT, justifyContent: 'center' }}
                >
                    <Text style={{ color: '#121113', fontSize: 14, fontWeight: '600' }}>{t('subscription.managePlan')}</Text>
                </Pressable>
            </View>
            <Text testID="settings-usage-line" style={{ color: '#D4D4D4', fontSize: 13 }}>
                {usageLine}
            </Text>
        </View>
    );
};

export default SettingsUsageCard;
