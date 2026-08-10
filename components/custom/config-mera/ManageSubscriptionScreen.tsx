import AbstractGradientBackdrop from '@/components/custom/AbstractGradientBackdrop';
import { Box } from '@/components/ui/box';
import { Button, ButtonText } from '@/components/ui/button';
import { HStack } from '@/components/ui/hstack';
import { Pressable } from '@/components/ui/pressable';
import { Spinner } from '@/components/ui/spinner';
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import { fetchUserBilling, refreshUserBillingAfterPurchase } from '@/lib/billing-service';
import { resolvePlanDisplay } from '@/lib/subscription/plan-display';
import type { UserBillingInfo } from '@/lib/generated/graphql-types';
import logger from '@/lib/logger';
import { getActiveEntitlementInfo, getActiveTier, getCustomerInfoSafe, getOfferingSafe, logRevenueCatDiagnostics } from '@/lib/revenuecat';
import { useSubscriptionStore } from '@/lib/stores/subscription-store';
import { showSubscriptionActivatedToast } from '@/lib/subscription/activation-toast';
import { MaterialIcons } from '@expo/vector-icons';
import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ScrollView } from 'react-native';
import { PACKAGE_TYPE } from 'react-native-purchases';
import type { PurchasesOffering, PurchasesPackage } from 'react-native-purchases';
import RevenueCatUI, { PAYWALL_RESULT } from 'react-native-purchases-ui';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import UsageWidget from '../UsageWidget';
import { humanizeKey } from './observability-labels';

const GREEN = '#10b981';
const AMBER = '#f59e0b';

const SectionHeader = ({ title }: { title: string }) => (
    <Box className="pt-6 pb-2">
        <Text size="xs" className="text-gray-500 uppercase tracking-widest font-semibold">
            {title}
        </Text>
    </Box>
);

const StatusPill = ({ text, color }: { text: string; color: string }) => (
    <HStack space="xs" className="items-center self-start bg-black/40 rounded-full px-2.5 py-1 mt-3">
        <Box style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: color }} />
        <Text size="xs" className="text-gray-300">{text}</Text>
    </HStack>
);

const InfoRow = ({ icon, label, value, isLast }: { icon: keyof typeof MaterialIcons.glyphMap; label: string; value: string; isLast?: boolean }) => (
    <HStack className={`items-center px-4 py-3 ${isLast ? '' : 'border-b border-gray-800'}`}>
        <MaterialIcons name={icon} size={16} color="#9ca3af" />
        <Text size="sm" className="text-gray-400 ml-3 flex-1">{label}</Text>
        <Text size="sm" className="text-white" numberOfLines={1}>{value}</Text>
    </HStack>
);

interface ManageSubscriptionScreenProps {
    onBack?: () => void;
}

// Price lives on the offering's packages, not on CustomerInfo — match the
// active entitlement's product to a package.
const resolvePricePackage = (
    productId: string | null,
    offering: PurchasesOffering | null,
): PurchasesPackage | null => {
    if (!productId || !offering) return null;
    return (
        offering.availablePackages.find(
            (p) =>
                p.product.identifier === productId ||
                // Android product ids can carry a ":basePlan" suffix.
                p.product.identifier.startsWith(`${productId}:`) ||
                productId.startsWith(`${p.product.identifier}:`),
        ) ?? null
    );
};

/**
 * The price as displayed: the store's localized `priceString` plus a period
 * suffix, so "€1.99" reads as "€1.99/month" rather than as a one-off charge.
 *
 * GATED ON THE PACKAGE'S ACTUAL PERIOD, never hardcoded. Every plan is monthly
 * today, which is exactly why a hardcoded "/month" would survive review and
 * then quietly start lying the day an annual plan ships. An unrecognised period
 * renders the bare price — no suffix is always better than a wrong one.
 *
 * `priceString` is already locale- and currency-formatted by the store; only
 * the suffix is ours to translate.
 */
export const formatPackagePrice = (
    pkg: PurchasesPackage | null,
    perMonthSuffix: string,
): string | null => {
    if (!pkg) return null;
    const price = pkg.product.priceString;
    if (!price) return null;
    return pkg.packageType === PACKAGE_TYPE.MONTHLY
        ? `${price}${perMonthSuffix}`
        : price;
};

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
    const insets = useSafeAreaInsets();
    const [billing, setBilling] = useState<UserBillingInfo | null>(null);
    const [priceString, setPriceString] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);
    // A purchase completed but the server has not confirmed the new tier yet.
    // Same situation, same copy, as NotSubscribedScreen's `activationDelayed`.
    const [activationPending, setActivationPending] = useState(false);
    const customerInfo = useSubscriptionStore((s) => s.customerInfo);
    const setCustomerInfo = useSubscriptionStore((s) => s.setCustomerInfo);
    // Server-computed, display-only. Nothing here derives entitlement from it.
    const grantExpiresAt = useSubscriptionStore((s) => s.grantExpiresAt);
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
                // Same reasoning as ProfileScreen's late poll: gated on
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
        try {
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

    // r13: the TRIAL and INTRO cases are gone with the store's introductory
    // offers. `humanizeKey` still renders anything unmapped, so a legacy
    // entitlement that somehow reports one degrades to "Trial" rather than to a
    // blank row — it just no longer has a translated string standing ready for
    // a state the product does not offer.
    const periodTypeLabel = (periodType: string): string => {
        switch (periodType) {
            case 'NORMAL': return t('subscription.periodNormal');
            case 'PROMOTIONAL': return t('subscription.periodPromotional');
            default: return humanizeKey(periodType);
        }
    };

    const storeLabel = (store: string): string => {
        switch (store) {
            case 'APP_STORE': return t('subscription.storeAppStore');
            case 'PLAY_STORE': return t('subscription.storePlayStore');
            case 'PROMOTIONAL': return t('subscription.storePromotional');
            default: return humanizeKey(store);
        }
    };

    // ONE rule, shared with ProfileScreen — see plan-display.ts. The optimistic
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

    // Glanceable status pill for the hero card.
    const statusPill: { text: string; color: string } | null = activeEntitlement
        ? (() => {
            const date = formatDate(activeEntitlement.expirationDate);
            if (!date) return { text: t('subscription.lifetime'), color: GREEN };
            const prefix = activeEntitlement.willRenew
                ? t('subscription.renewsOn')
                : t('subscription.expiresOn');
            return { text: `${prefix} ${date}`, color: activeEntitlement.willRenew ? GREEN : AMBER };
        })()
        : isPaid
            ? { text: t('subscription.active'), color: GREEN }
            : null;

    const usedToday = billing?.articlesUsedToday ?? 0;
    const dailyLimit = billing?.dailyArticleLimit ?? 0;

    const detailRows: { icon: keyof typeof MaterialIcons.glyphMap; label: string; value: string }[] = activeEntitlement
        ? [
            {
                icon: activeEntitlement.willRenew ? 'event-available' : 'event-busy',
                label: activeEntitlement.willRenew ? t('subscription.renewsOn') : t('subscription.expiresOn'),
                value: formatDate(activeEntitlement.expirationDate) ?? t('subscription.lifetime'),
            },
            {
                icon: 'autorenew',
                label: t('subscription.autoRenew'),
                value: activeEntitlement.willRenew ? t('common.yes') : t('common.no'),
            },
            { icon: 'schedule', label: t('subscription.periodLabel'), value: periodTypeLabel(activeEntitlement.periodType) },
            { icon: 'store', label: t('subscription.storeLabel'), value: storeLabel(activeEntitlement.store) },
        ]
        : [];

    return (
        // Unpadded wrapper. The backdrop hangs off THIS box, not the padded one
        // below, so it spans the FULL screen including the safe areas — an
        // absolute fill resolves against its parent's CONTENT box, so mounting it
        // inside the padded box left a black strip in the inset.
        <Box className="flex-1">
            {/* Page background. Must be the FIRST child so it paints behind
                everything else on the page. */}
            <AbstractGradientBackdrop />

            {/* No opaque fill: the backdrop above is the page background. */}
            <Box className="flex-1" style={{ paddingTop: insets.top }}>

            <HStack className="px-4 py-3 items-center">
                <Pressable onPress={onBack} className="bg-gray-900 rounded-full p-2" hitSlop={8}>
                    <MaterialIcons name="arrow-back" size={20} color="#ffffff" />
                </Pressable>
                <Text className="text-white font-semibold text-base flex-1 text-center mr-9">
                    {t('subscription.managePlan')}
                </Text>
            </HStack>

            {loading ? (
                <Box className="flex-1 items-center justify-center">
                    <Spinner size="large" />
                </Box>
            ) : (
                <ScrollView
                    className="flex-1"
                    contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: insets.bottom + 24 }}
                    showsVerticalScrollIndicator={false}
                >
                    {/* The purchase went through but our server has not caught
                        up. Shown INSTEAD of committing the pre-purchase plan to
                        the panels below. Always clears. */}
                    {activationPending ? (
                        <Text
                            testID="manage-activation-pending"
                            size="sm"
                            className="text-primary-400 mt-4"
                        >
                            {t('subscription.activationDelayed')}
                        </Text>
                    ) : null}

                    {/* Hero plan card */}
                    <Box className="bg-gray-900 rounded-2xl p-5 border border-gray-800 mt-4">
                        <HStack className="items-center">
                            <Box className="bg-black/40 rounded-full p-2.5">
                                <MaterialIcons
                                    name={isPaid ? 'workspace-premium' : 'person-outline'}
                                    size={22}
                                    color={isPaid ? AMBER : '#9ca3af'}
                                />
                            </Box>
                            <VStack className="ml-3 flex-1">
                                <Text size="xs" className="text-gray-500">{t('subscription.planLabel')}</Text>
                                {/* No `leading-8`: this renders a TRANSLATED plan
                                    name, and 32px on 24px type (1.33) sliced the
                                    top off Devanagari/Thai marks. `text-2xl` now
                                    carries a script-safe 36px line box. */}
                                <Text className="text-white font-bold text-2xl">
                                    {planLabelText()}
                                </Text>
                            </VStack>
                            {priceString ? (
                                <Text className="text-white font-semibold text-lg">{priceString}</Text>
                            ) : null}
                        </HStack>
                        {statusPill ? <StatusPill text={statusPill.text} color={statusPill.color} /> : null}
                    </Box>

                    {/* Usage */}
                    {billing && (
                        <>
                            <SectionHeader title={t('subscription.usageSection')} />
                            <UsageWidget
                                used={usedToday}
                                limit={dailyLimit}
                                usedLabel={t('subscription.usedToday')}
                                planLabel={planLabelText()}
                                onUpgrade={effectiveTier === 'professional' ? undefined : handleViewPlans}
                                upgradeLabel={t('subscription.upgrade')}
                                resetAt={billing.resetAt}
                                resetLabel={t('subscription.resetsOn')}
                            />
                        </>
                    )}

                    {/* Subscription details */}
                    {detailRows.length > 0 && (
                        <>
                            <SectionHeader title={t('subscription.detailsSection')} />
                            <Box className="bg-gray-900 rounded-2xl border border-gray-800 overflow-hidden">
                                {detailRows.map((row, i) => (
                                    <InfoRow
                                        key={row.label}
                                        icon={row.icon}
                                        label={row.label}
                                        value={row.value}
                                        isLast={i === detailRows.length - 1}
                                    />
                                ))}
                            </Box>
                        </>
                    )}

                    <VStack space="md" className="mt-8">
                        <Button onPress={handleViewPlans} className="w-full">
                            <MaterialIcons name="upgrade" size={18} color="#000000" />
                            <ButtonText>{t('subscription.viewPlans')}</ButtonText>
                        </Button>
                        {/* Hidden for a user whose access comes from the
                            server's free 14-day Starter grant. They hold no
                            RevenueCat entitlement at all, so the Customer
                            Center — which manages a store subscription —
                            opens onto nothing. `!isPremium` rather than a
                            tier check because the grant elevates
                            `subscriptionTier` to `starter`, so the tier alone
                            cannot tell a granted user from a paying one; the
                            store's own view can. */}
                        {grantExpiresAt && !isPremium ? null : (
                            <Button variant="outline" action="secondary" onPress={handleCustomerCenter} className="w-full">
                                <MaterialIcons name="settings" size={18} color="#ffffff" />
                                <ButtonText>{t('subscription.customerCenter')}</ButtonText>
                            </Button>
                        )}
                    </VStack>
                </ScrollView>
            )}
        </Box>
        </Box>
    );
};

export default ManageSubscriptionScreen;
