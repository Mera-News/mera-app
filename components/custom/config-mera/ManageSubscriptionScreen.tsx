import AbstractGradientBackdrop from '@/components/custom/AbstractGradientBackdrop';
import { Pressable } from '@/components/ui/pressable';
import { Spinner } from '@/components/ui/spinner';
import { Text } from '@/components/ui/text';
import React from 'react';
import { useTranslation } from 'react-i18next';
import { ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFeedCounts } from '@/lib/hooks/use-feed-counts';
import { useColors } from '@/lib/theme/tokens';
import { formatResetTime } from './SettingsUsageCard';
import { useManageSubscription } from './useManageSubscription';
import DrillDownHeader, { SUBPAGE_TOP_GAP } from '@/components/custom/config-panel/DrillDownHeader';

interface ManageSubscriptionScreenProps {
    onBack?: () => void;
}

/**
 * Subscription details + actions: plan and daily article limit from our DB
 * (the source of truth), entitlement details and price from RevenueCat, and
 * the two RevenueCat UI flows (paywall to view/upgrade plans, Customer Center
 * to manage/cancel). Each data source degrades independently — a failed
 * billing fetch hides the usage/plan rows, an unconfigured RevenueCat hides
 * the entitlement rows.
 */
const ManageSubscriptionScreen: React.FC<ManageSubscriptionScreenProps> = ({ onBack }) => {
    const { t, i18n } = useTranslation();
    const colors = useColors();
    const counts = useFeedCounts();
    const insets = useSafeAreaInsets();
    const {
        billing,
        priceString,
        loading,
        activationPending,
        isPremium,
        activeEntitlement,
        handleViewPlans,
        handleCustomerCenter,
        planDisplay,
        effectiveTier,
        isPaid,
    } = useManageSubscription();

    const formatDate = (iso: string | null | undefined): string | null => {
        if (!iso) return null;
        const date = new Date(iso);
        if (Number.isNaN(date.getTime())) return null;
        return date.toLocaleString(i18n.language, {
            year: 'numeric',
            month: 'long',
            day: 'numeric',
        });
    };

    const planName = (tier: string | null | undefined): string => {
        if (tier === 'professional') return t('subscription.planProfessional');
        if (tier === 'individual') return t('subscription.planIndividual');
        if (tier === 'starter') return t('subscription.planStarter');
        return t('subscription.planPromo');
    };


    /** The plan name, qualified when the server has not confirmed it yet. */
    const planLabelText = (): string => {
        if (!isPaid) return t('subscription.freePlan');
        const name = planName(effectiveTier);
        return planDisplay.pending
            ? t('subscription.planPending', { plan: name })
            : name;
    };

    // The plan's one line: "Promo access · ends 17 Oct, won't renew", "Renews
    // on ...", or "Expires on ..." (FinalSettings #4).
    const planLine: string | null = (() => {
        if (!activeEntitlement) return isPaid ? t('subscription.active') : null;
        const date = formatDate(activeEntitlement.expirationDate);
        if (!date) return t('subscription.lifetime');
        if (activeEntitlement.store === 'PROMOTIONAL' && !activeEntitlement.willRenew) {
            return t('subscription.promoEndsNoRenew', { date });
        }
        return `${activeEntitlement.willRenew ? t('subscription.renewsOn') : t('subscription.expiresOn')} ${date}`;
    })();

    const usedToday = billing?.articlesUsedToday ?? 0;
    const dailyLimit = billing?.dailyArticleLimit ?? 0;
    const reset = billing ? formatResetTime(billing.resetAt, i18n?.language) : null;
    const discarded = Math.max(0, counts.analysedCount - counts.relevantCount);
    const number = (n: number) => n.toLocaleString(i18n?.language);

    const tile = (value: number, label: string, testID: string) => (
        <View testID={testID} style={[styles.tile, { backgroundColor: colors.surface, borderColor: colors.line }]}>
            <Text style={{ color: colors.ink, fontSize: 24, fontWeight: '700', fontVariant: ['tabular-nums'] }}>{number(value)}</Text>
            <Text style={{ color: colors.ink2, fontSize: 13 }}>{label}</Text>
        </View>
    );

    return (
        <View style={{ flex: 1 }}>
            <AbstractGradientBackdrop />
            <View style={{ flex: 1, paddingTop: insets.top }}>
                <DrillDownHeader title={t('subscription.managePlan')} onBack={onBack} />
                {loading ? (
                    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
                        <Spinner size="large" />
                    </View>
                ) : (
                    <ScrollView
                        contentContainerStyle={{ paddingHorizontal: 14, paddingTop: SUBPAGE_TOP_GAP, paddingBottom: insets.bottom + 24, gap: 12 }}
                        showsVerticalScrollIndicator={false}
                    >
                        {/* The purchase went through but our server has not
                            caught up. Always clears. */}
                        {activationPending ? (
                            <Text testID="manage-activation-pending" style={{ color: colors.accentText, fontSize: 14 }}>
                                {t('subscription.activationDelayed')}
                            </Text>
                        ) : null}

                        {/* Keyed on `isPremium` (a real store entitlement), NOT
                            the tier: the server reports `starter` for a granted
                            account exactly as for a bought one. */}
                        {!isPremium ? (
                            <View testID="manage-starter-free" style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.line }]}>
                                <Text style={{ color: colors.ink, fontSize: 16, fontWeight: '600' }}>{t('subscription.starterFreeTitle')}</Text>
                                <Text style={{ color: colors.ink2, fontSize: 14, lineHeight: 20 }}>{t('subscription.starterFreeBody')}</Text>
                            </View>
                        ) : null}

                        {/* The plan, named once. */}
                        <View style={{ gap: 2, marginHorizontal: 4 }}>
                            <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 8 }}>
                                {/* A script-safe line box: tight leading clipped Devanagari and Thai marks. */}
                                <Text style={{ flex: 1, color: colors.ink, fontSize: 24, lineHeight: 34, fontWeight: '700' }}>{planLabelText()}</Text>
                                {priceString ? <Text style={{ color: colors.ink, fontSize: 16, fontWeight: '600' }}>{priceString}</Text> : null}
                            </View>
                            {planLine ? <Text style={{ color: colors.ink2, fontSize: 14 }}>{planLine}</Text> : null}
                        </View>

                        {billing ? (
                            <View testID="manage-usage" style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.line }]}>
                                <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 6 }}>
                                    <Text style={{ color: colors.ink, fontSize: 28, fontWeight: '700', fontVariant: ['tabular-nums'] }}>{number(usedToday)}</Text>
                                    {dailyLimit > 0 ? (
                                        <Text style={{ color: colors.ink2, fontSize: 15 }}>{t('subscription.ofLimit', { limit: number(dailyLimit) })}</Text>
                                    ) : null}
                                    <View style={{ flex: 1 }} />
                                    {reset ? <Text style={{ color: colors.ink2, fontSize: 13 }}>{t('you.settings.resetsAt', { time: reset })}</Text> : null}
                                </View>
                                {dailyLimit > 0 ? (
                                    <View style={{ height: 6, borderRadius: 3, backgroundColor: colors.trackFill, overflow: 'hidden' }}>
                                        <View style={{ width: `${Math.min(100, (usedToday / dailyLimit) * 100)}%`, height: 6, backgroundColor: colors.accent }} />
                                    </View>
                                ) : null}
                                <Text style={{ color: colors.ink2, fontSize: 13 }}>{t('subscription.articlesUsedToday')}</Text>
                            </View>
                        ) : null}

                        {/* The last 24 hours: the same four numbers the Feed's
                            status card uses (useFeedCounts), so no new counter. */}
                        <View style={{ flexDirection: 'row', gap: 10 }}>
                            {tile(counts.articleCount, t('subscription.available24h'), 'manage-available')}
                            {tile(counts.analysedCount, t('subscription.analysedForYou'), 'manage-analysed')}
                        </View>
                        <View style={{ flexDirection: 'row', gap: 10 }}>
                            {tile(discarded, t('subscription.discarded'), 'manage-discarded')}
                            {tile(counts.relevantCount, t('subscription.relevantSoFar'), 'manage-relevant')}
                        </View>
                        <Text style={{ color: colors.ink3, fontSize: 13, lineHeight: 18, marginHorizontal: 4 }}>{t('subscription.localOnly')}</Text>

                        <Pressable
                            testID="manage-view-plans"
                            onPress={() => void handleViewPlans()}
                            accessibilityRole="button"
                            accessibilityLabel={t('subscription.viewPlans')}
                            style={[styles.button, { backgroundColor: colors.accent }]}
                        >
                            <Text style={{ color: colors.onAccent, fontSize: 16, fontWeight: '600' }}>{t('subscription.viewPlans')}</Text>
                        </Pressable>
                        {/* Only with a store subscription: the Customer Center
                            opens onto nothing for a granted Starter account. */}
                        {isPremium ? (
                            <Pressable
                                testID="manage-customer-center"
                                onPress={() => void handleCustomerCenter()}
                                accessibilityRole="button"
                                accessibilityLabel={t('subscription.customerCenter')}
                                style={[styles.button, { borderWidth: 1, borderColor: colors.trackBorder }]}
                            >
                                <Text style={{ color: colors.ink, fontSize: 16, fontWeight: '600' }}>{t('subscription.customerCenter')}</Text>
                            </Pressable>
                        ) : null}
                        {/* Where it is billed, only for a store subscription. */}
                        {isPremium && (activeEntitlement?.store === 'APP_STORE' || activeEntitlement?.store === 'PLAY_STORE') ? (
                            <Text style={{ color: colors.ink3, fontSize: 13, lineHeight: 18, textAlign: 'center' }}>
                                {activeEntitlement.store === 'APP_STORE' ? t('subscription.billedAppStore') : t('subscription.billedPlayStore')}
                            </Text>
                        ) : null}
                    </ScrollView>
                )}
            </View>
        </View>
    );
};

const styles = StyleSheet.create({
    card: { borderRadius: 16, borderWidth: 1, padding: 16, gap: 10 },
    tile: { flex: 1, borderRadius: 14, borderWidth: 1, padding: 12, gap: 2 },
    button: { height: 48, borderRadius: 999, alignItems: 'center', justifyContent: 'center' },
});

export default ManageSubscriptionScreen;
