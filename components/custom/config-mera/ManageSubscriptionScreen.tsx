import AbstractGradientBackdrop from '@/components/custom/AbstractGradientBackdrop';
import { Pressable } from '@/components/ui/pressable';
import { Spinner } from '@/components/ui/spinner';
import { Text } from '@/components/ui/text';
import { fetchUserBilling, refreshUserBillingAfterPurchase } from '@/lib/billing-service';
import { resolvePlanDisplay } from '@/lib/subscription/plan-display';
import type { UserBillingInfo } from '@/lib/generated/graphql-types';
import logger from '@/lib/logger';
import { ensureEmailBeforeCheckout } from '@/lib/subscription/email-capture';
import { holdRestartAcrossPurchase } from '@/lib/subscriptions/subscribe-flow';
import { getActiveEntitlementInfo, getActiveTier, getCustomerInfoSafe, getOfferingSafe, logRevenueCatDiagnostics } from '@/lib/revenuecat';
import { useSubscriptionStore } from '@/lib/stores/subscription-store';
import { showSubscriptionActivatedToast } from '@/lib/subscription/activation-toast';
import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ScrollView, StyleSheet, View } from 'react-native';
import { formatPackagePrice, resolvePricePackage } from '@/lib/subscription/plan-price';
import RevenueCatUI, { PAYWALL_RESULT } from 'react-native-purchases-ui';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFeedCounts } from '@/lib/hooks/use-feed-counts';
import { useColors } from '@/lib/theme/tokens';
import { formatResetTime } from './SettingsUsageCard';
import DrillDownHeader from '@/components/custom/config-panel/DrillDownHeader';

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
    const [billing, setBilling] = useState<UserBillingInfo | null>(null);
    const [priceString, setPriceString] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);
    // A purchase completed but the server has not confirmed the new tier yet.
    // Same situation, same copy, as NotSubscribedScreen's `activationDelayed`.
    const [activationPending, setActivationPending] = useState(false);
    const customerInfo = useSubscriptionStore((s) => s.customerInfo);
    const setCustomerInfo = useSubscriptionStore((s) => s.setCustomerInfo);
    const isPremium = useSubscriptionStore((s) => s.isPremium);

    const rcTier = getActiveTier(customerInfo);
    const activeEntitlement = getActiveEntitlementInfo(customerInfo);

    /**
     * Load every panel on this screen. Pass `awaitTierChangeFrom` after a
     * completed purchase/restore: the RevenueCat → server webhook is async, so
     * a single fetch the moment the paywall closes normally still reads the
     * pre-purchase tier. It retries briefly, then gives up (see
     * refreshUserBillingAfterPurchase).
     */
    const load = useCallback(async (awaitTierChangeFrom?: string | null) => {
        const isPostPurchase = awaitTierChangeFrom !== undefined;
        const [billingResult, freshCustomerInfo, offering] = await Promise.all([
            isPostPurchase
                ? refreshUserBillingAfterPurchase(awaitTierChangeFrom)
                : fetchUserBilling().then((b) => ({ billing: b, confirmed: true })),
            getCustomerInfoSafe(),
            getOfferingSafe(),
        ]);
        const { billing: billingInfo, confirmed } = billingResult;

        // On an UNCONFIRMED post-purchase read, `billingInfo` is the tier the
        // user had BEFORE they paid. Committing it here is the pre-existing bug
        // — the screen says the purchase succeeded and then renders the old
        // plan. Leave the panels showing what they already had and let the
        // secondary poll below settle it.
        if (confirmed) {
            setBilling(billingInfo);
            // Mirror the server's verdict into the store so the free-tier
            // state lifts (or falls) app-wide, not just on this screen's usage card.
            useSubscriptionStore.getState().setServerBilling(billingInfo);
            // `isPostPurchase &&` is load-bearing: the non-purchase branch above
            // hardcodes `confirmed: true`, so `if (confirmed)` alone would toast
            // on every mount and after every customer-center dismissal.
            if (isPostPurchase) {
                showSubscriptionActivatedToast(
                    awaitTierChangeFrom,
                    billingInfo?.subscriptionTier,
                );
            }
        }
        setActivationPending(isPostPurchase && !confirmed);

        if (isPostPurchase && !confirmed) {
            // Longer, still-bounded second look. Always clears the notice, even
            // unresolved: a DEFERRED App Store plan change never changes the
            // tier at all, so waiting for one would strand the user in
            // "activating…" forever.
            void (async () => {
                const later = await refreshUserBillingAfterPurchase(awaitTierChangeFrom, {
                    attempts: 20,
                    intervalMs: 5000,
                    backoffFactor: 1,
                });
                if (later.billing) {
                    setBilling(later.billing);
                    useSubscriptionStore.getState().setServerBilling(later.billing);
                }
                // The late poll is gated on
                // `confirmed`, never on `later.billing` — this branch commits
                // unconfirmed snapshots on purpose.
                if (later.confirmed) {
                    showSubscriptionActivatedToast(
                        awaitTierChangeFrom,
                        later.billing?.subscriptionTier,
                    );
                }
                setActivationPending(false);
            })();
        }

        if (freshCustomerInfo) setCustomerInfo(freshCustomerInfo);

        const info = freshCustomerInfo ?? useSubscriptionStore.getState().customerInfo;
        const productId = getActiveEntitlementInfo(info)?.productIdentifier ?? null;
        setPriceString(
            formatPackagePrice(
                resolvePricePackage(productId, offering),
                t('subscription.perMonth'),
            ),
        );
        setLoading(false);
    }, [setCustomerInfo, t]);

    useEffect(() => {
        void load();
        // Pending-plan-change probe (dev only, zero UI): dumps the RevenueCat
        // subscription rows so we can settle whether a deferred upgrade is
        // visible client-side at all. See lib/revenuecat.ts describeSubscriptions().
        if (__DEV__) void logRevenueCatDiagnostics();
    }, [load]);

    const handleViewPlans = async () => {
        // THE MONEY PATH'S RESTART HOLD, and this is the app's primary purchase
        // route (Profile -> Manage subscription -> View Plans).
        //
        // Every true background -> foreground return reloads the app. Without
        // this, the return that carries the user back from a purchase is the
        // return that throws away the entitlement refresh below, mid-flight:
        // they paid and the app does not know.
        //
        // TAKEN AHEAD OF `ensureEmailBeforeCheckout()`, not just ahead of the
        // paywall. That gate sends the user to their mail app for a code, which
        // is a true departure on both platforms — and the one that arrives back
        // with a half-finished checkout behind it.
        //
        // NOT RELEASED HERE, and deliberately not in a `finally`. The release is
        // timer-owned (see holdRestartAcrossPurchase): this function returns
        // while `load()` -> `refreshUserBillingAfterPurchase` is still retrying,
        // which is exactly the window the hold exists to cover. Releasing on the
        // way out would release before the thing it protects. The returned
        // immediate release is only valid where nothing was opened and the user
        // provably cannot be away; there is no such path here, so it goes
        // uncalled and the two timers own it.
        holdRestartAcrossPurchase('purchase');
        try {
            // S10: verified email is required before checkout for anonymous
            // accounts; a dismissed sheet aborts quietly.
            if (!(await ensureEmailBeforeCheckout())) return;
            const offering = await getOfferingSafe();
            // Browsing/upgrading from settings — show a close button so the user
            // can dismiss without purchasing (unlike the hard gate).
            const result = await RevenueCatUI.presentPaywall({
                ...(offering ? { offering } : {}),
                displayCloseButton: true,
            });
            // A purchase is a discrete event — refresh on it rather than making
            // the user wait for the next time this screen mounts.
            if (result === PAYWALL_RESULT.PURCHASED || result === PAYWALL_RESULT.RESTORED) {
                await load(billing?.subscriptionTier ?? null);
            }
        } catch (error) {
            logger.captureException(error, {
                tags: { component: 'ManageSubscriptionScreen', method: 'viewPlans' },
            });
        }
    };

    const handleCustomerCenter = async () => {
        try {
            await RevenueCatUI.presentCustomerCenter();
            // The user may have cancelled or changed plan in there — re-read
            // once on dismissal instead of showing stale rows.
            await load();
        } catch (error) {
            logger.captureException(error, {
                tags: { component: 'ManageSubscriptionScreen', method: 'customerCenter' },
            });
        }
    };

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

    // ONE rule, shared with the Settings plan card — see plan-display.ts. The optimistic
    // RevenueCat fallback is kept (a fresh purchase should show its plan name
    // immediately), but it is now MARKED pending rather than asserted as fact,
    // because the access gate has no such fallback and the two screens were
    // free to disagree with the free-tier notice sitting right below them.
    const planDisplay = resolvePlanDisplay({
        serverTier: billing?.subscriptionTier,
        rcTier,
        serverLoaded: billing != null,
    });
    const effectiveTier = planDisplay.tier ?? undefined;
    const isPaid = planDisplay.tier != null;

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
                        contentContainerStyle={{ paddingHorizontal: 14, paddingBottom: insets.bottom + 24, gap: 12 }}
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
