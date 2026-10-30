import AbstractGradientBackdrop from '@/components/custom/AbstractGradientBackdrop';
import { Pressable } from '@/components/ui/pressable';
import { Spinner } from '@/components/ui/spinner';
import { Text } from '@/components/ui/text';
import { MaterialIcons } from '@expo/vector-icons';
import React from 'react';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFeedCounts } from '@/lib/hooks/use-feed-counts';
import { useSupportAction } from '@/lib/intercom';
import { useColors } from '@/lib/theme/tokens';
import ReadingMeter, { useReadingFetch } from './ReadingMeter';
import { useManageSubscription } from './useManageSubscription';
import { useRestorePurchases } from './useRestorePurchases';
import { redeemOfferCode } from '@/lib/subscription/redeem-code';
import DrillDownHeader, { SUBPAGE_TOP_GAP } from '@/components/custom/config-panel/DrillDownHeader';

interface ManageSubscriptionScreenProps {
    onBack?: () => void;
}

/**
 * Manage plan, kept lean (owner): the plan and its one line, the usage card,
 * the four numbers, View plans, Restore purchases, Redeem a code, and for a store
 * subscription the Customer Center and where it is billed.
 *
 * Subscription details + actions: plan and daily reading from our DB
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
    const { openSupport } = useSupportAction();
    const { restoring, restore } = useRestorePurchases();
    const {
        priceString,
        loading,
        purchaseStatus,
        checkAgain,
        isPremium,
        activeEntitlement,
        handleViewPlans,
        handleCustomerCenter,
        planDisplay,
        effectiveTier,
        isPaid,
    } = useManageSubscription();
    const confirming = purchaseStatus === 'confirming';

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
    // A granted Starter (no store entitlement) says it is free; with no plan the title already does.
    const planLine: string | null = (() => {
        if (!activeEntitlement) return !isPaid ? null : isPremium ? t('subscription.active') : t('subscription.freePlan');
        const date = formatDate(activeEntitlement.expirationDate);
        if (!date) return t('subscription.lifetime');
        if (activeEntitlement.store === 'PROMOTIONAL' && !activeEntitlement.willRenew) {
            return t('subscription.promoEndsNoRenew', { date });
        }
        return `${activeEntitlement.willRenew ? t('subscription.renewsOn') : t('subscription.expiresOn')} ${date}`;
    })();

    const reading = useReadingFetch();
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
                            confirmed it yet: stay here and wait. The title also
                            carries `manage-activation-pending` (and the timeout
                            title `manage-activation-timeout`): the device flow
                            keys on those ids. */}
                        {confirming ? (
                            <View testID="manage-confirming-card" style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.line, alignItems: 'center' }]}>
                                <ActivityIndicator size="small" color={colors.ink} />
                                <Text testID="manage-activation-pending" style={{ color: colors.ink, fontSize: 16, fontWeight: '600', textAlign: 'center' }}>{t('subscription.confirmingTitle')}</Text>
                                <Text style={{ color: colors.ink2, fontSize: 14, lineHeight: 20, textAlign: 'center' }}>{t('subscription.confirmingBody')}</Text>
                            </View>
                        ) : null}
                        {/* Both poll budgets are spent. If they paid, support
                            can sort it out; otherwise they can look again. */}
                        {purchaseStatus === 'timed-out' ? (
                            <View testID="manage-timeout-card" style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.line, alignItems: 'center' }]}>
                                <MaterialIcons name="warning-amber" size={24} color={colors.warning} />
                                <Text testID="manage-activation-timeout" style={{ color: colors.ink, fontSize: 16, fontWeight: '600', textAlign: 'center' }}>{t('subscription.confirmTimeoutTitle')}</Text>
                                <Text style={{ color: colors.ink2, fontSize: 14, lineHeight: 20, textAlign: 'center' }}>{t('subscription.confirmTimeoutBody')}</Text>
                                <Pressable
                                    testID="manage-support"
                                    onPress={() => void openSupport()}
                                    accessibilityRole="button"
                                    accessibilityLabel={t('account.contactSupport')}
                                    className="self-center flex-row items-center gap-2 rounded-full border border-primary-500 px-5 py-3"
                                >
                                    <MaterialIcons name="support-agent" size={20} color={colors.ink} />
                                    <Text style={{ color: colors.ink, fontSize: 15, fontWeight: '600' }}>{t('account.contactSupport')}</Text>
                                </Pressable>
                                <Pressable
                                    testID="manage-check-again"
                                    onPress={() => void checkAgain()}
                                    accessibilityRole="button"
                                    accessibilityLabel={t('subscription.checkAgain')}
                                    style={{ paddingVertical: 8, paddingHorizontal: 12 }}
                                >
                                    <Text style={{ color: colors.accentText, fontSize: 15, fontWeight: '600' }}>{t('subscription.checkAgain')}</Text>
                                </Pressable>
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

                        <View testID="manage-usage" style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.line }]}>
                            <ReadingMeter size="screen" {...reading} />
                        </View>

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

                        <Pressable
                            testID="manage-view-plans"
                            onPress={() => void handleViewPlans()}
                            disabled={confirming}
                            accessibilityRole="button"
                            accessibilityLabel={t('subscription.viewPlans')}
                            accessibilityState={{ disabled: confirming }}
                            style={[
                                styles.button,
                                // A disabled button is neutral grey, never a dimmed accent. opacity 1 overrides the primitive's disabled opacity-40.
                                confirming
                                    ? { backgroundColor: colors.surfaceRaised, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line, opacity: 1 }
                                    : { backgroundColor: colors.accent },
                            ]}
                        >
                            <Text style={{ color: confirming ? colors.ink3 : colors.onAccent, fontSize: 16, fontWeight: '600' }}>{t('subscription.viewPlans')}</Text>
                        </Pressable>
                        {/* Tertiary, under View plans. The testID predates the move from Settings. */}
                        <Pressable
                            testID="settings-row-restore-purchases"
                            onPress={() => void restore()}
                            disabled={restoring}
                            accessibilityRole="button"
                            accessibilityLabel={t('you.settings.restorePurchases')}
                            accessibilityState={{ busy: restoring, disabled: restoring }}
                            style={{ minHeight: 44, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 }}
                        >
                            {restoring ? <Spinner size="small" /> : <MaterialIcons name="restore" size={18} color={colors.accentText} />}
                            <Text style={{ color: colors.accentText, fontSize: 15, fontWeight: '600' }}>{t('you.settings.restorePurchases')}</Text>
                        </Pressable>
                        {/* Offer codes are store-run: the iOS sheet or the Play redeem page. */}
                        <Pressable
                            testID="manage-redeem-code"
                            onPress={() => void redeemOfferCode()}
                            accessibilityRole="button"
                            accessibilityLabel={t('subscription.redeemCode')}
                            style={{ minHeight: 44, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 }}
                        >
                            <MaterialIcons name="redeem" size={18} color={colors.accentText} />
                            <Text style={{ color: colors.accentText, fontSize: 15, fontWeight: '600' }}>{t('subscription.redeemCode')}</Text>
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
