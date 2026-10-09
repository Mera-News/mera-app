import { fetchUserBilling, refreshUserBillingAfterPurchase } from '@/lib/billing-service';
import { resolvePlanDisplay } from '@/lib/subscription/plan-display';
import type { UserBillingInfo } from '@/lib/generated/graphql-types';
import logger from '@/lib/logger';
import { ensureEmailBeforeCheckout } from '@/lib/subscription/email-capture';
import { holdRestartAcrossPurchase } from '@/lib/subscriptions/subscribe-flow';
import { getActiveEntitlementInfo, getActiveTier, getCustomerInfoSafe, getOfferingSafe, logRevenueCatDiagnostics } from '@/lib/revenuecat';
import { useSubscriptionStore } from '@/lib/stores/subscription-store';
import { showSubscriptionActivatedToast } from '@/lib/subscription/activation-toast';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { formatPackagePrice, resolvePricePackage } from '@/lib/subscription/plan-price';
import RevenueCatUI, { PAYWALL_RESULT } from 'react-native-purchases-ui';

export function useManageSubscription() {
    const { t } = useTranslation();
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

    return {
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
    };
}
