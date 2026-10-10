import { fetchUserBilling, refreshUserBillingAfterPurchase } from '@/lib/billing-service';
import { resolvePlanDisplay } from '@/lib/algorithms/plan-display';
import type { UserBillingInfo } from '@/lib/generated/graphql-types';
import logger from '@/lib/logger';
import { ensureEmailBeforeCheckout } from '@/lib/subscription/email-capture';
import { holdRestartAcrossPurchase } from '@/lib/subscriptions/subscribe-flow';
import { getActiveEntitlementInfo, getActiveTier, getCustomerInfoSafe, getOfferingSafe, logRevenueCatDiagnostics } from '@/lib/revenuecat';
import { useSubscriptionStore } from '@/lib/stores/subscription-store';
import { showSubscriptionActivatedToast } from '@/lib/subscription/activation-toast';
import { rememberLastKnownTier } from '@/lib/subscription/last-known-tier';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { formatPackagePrice, resolvePricePackage } from '@/lib/subscription/plan-price';
import RevenueCatUI, { PAYWALL_RESULT } from 'react-native-purchases-ui';
import type { CustomerInfo } from 'react-native-purchases';

/** `confirming` from the purchase until billing confirms it; `timed-out` when both poll budgets are spent. */
export type PurchaseStatus = 'idle' | 'confirming' | 'confirmed' | 'timed-out';

export function useManageSubscription() {
    const { t } = useTranslation();
    const [billing, setBilling] = useState<UserBillingInfo | null>(null);
    const [priceString, setPriceString] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);
    const [purchaseStatus, setPurchaseStatus] = useState<PurchaseStatus>('idle');
    // What a `checkAgain` needs to rerun the polls: the tier held before paying and the tier the store sold.
    const purchase = useRef<{ before: string | null; purchasedTier: string | null } | null>(null);
    // A purchase completed but the server has not confirmed the new tier yet.
    const activationPending = purchaseStatus === 'confirming';
    const customerInfo = useSubscriptionStore((s) => s.customerInfo);
    const setCustomerInfo = useSubscriptionStore((s) => s.setCustomerInfo);
    const isPremium = useSubscriptionStore((s) => s.isPremium);

    const rcTier = getActiveTier(customerInfo);
    const activeEntitlement = getActiveEntitlementInfo(customerInfo);

    /** The price line, from the active entitlement's product. */
    const applyStoreInfo = useCallback(
        (freshCustomerInfo: CustomerInfo | null, offering: Awaited<ReturnType<typeof getOfferingSafe>>) => {
            if (freshCustomerInfo) setCustomerInfo(freshCustomerInfo);
            const info = freshCustomerInfo ?? useSubscriptionStore.getState().customerInfo;
            const productId = getActiveEntitlementInfo(info)?.productIdentifier ?? null;
            setPriceString(
                formatPackagePrice(
                    resolvePricePackage(productId, offering),
                    t('subscription.perMonth'),
                ),
            );
        },
        [setCustomerInfo, t],
    );

    /** Load every panel on this screen. */
    const load = useCallback(async () => {
        const [billingInfo, freshCustomerInfo, offering] = await Promise.all([
            fetchUserBilling(),
            getCustomerInfoSafe(),
            getOfferingSafe(),
        ]);
        setBilling(billingInfo);
        // Mirror the server's verdict into the store so the free-tier
        // state lifts (or falls) app-wide, not just on this screen's usage card.
        useSubscriptionStore.getState().setServerBilling(billingInfo);
        applyStoreInfo(freshCustomerInfo, offering);
        setLoading(false);
    }, [applyStoreInfo]);

    /**
     * Poll billing until the server confirms the purchase. The first poll is awaited; the longer second look
     * runs detached (the caller must not wait on it) and ends in `confirmed` or `timed-out`. The late poll
     * commits its last snapshot even when unconfirmed, on purpose: it is the server's truth, and a DEFERRED
     * App Store plan change never changes the tier at all.
     */
    const pollPurchase = useCallback(async (before: string | null, purchasedTier: string | null) => {
        setPurchaseStatus('confirming');
        const confirm = (confirmedBilling: UserBillingInfo) => {
            setBilling(confirmedBilling);
            useSubscriptionStore.getState().setServerBilling(confirmedBilling);
            void rememberLastKnownTier(confirmedBilling.subscriptionTier ?? 'none');
            showSubscriptionActivatedToast(confirmedBilling.subscriptionTier);
            setPurchaseStatus('confirmed');
        };
        const first = await refreshUserBillingAfterPurchase(before, { purchasedTier });
        if (first.confirmed && first.billing) return confirm(first.billing);
        void (async () => {
            const later = await refreshUserBillingAfterPurchase(before, {
                attempts: 20,
                intervalMs: 5000,
                backoffFactor: 1,
                purchasedTier,
            });
            if (later.confirmed && later.billing) return confirm(later.billing);
            if (later.billing) {
                setBilling(later.billing);
                useSubscriptionStore.getState().setServerBilling(later.billing);
            }
            setPurchaseStatus('timed-out');
        })();
    }, []);

    /** After PURCHASED/RESTORED: read what the store sold, then poll for the server to agree. */
    const confirmPurchase = useCallback(
        async (before: string | null) => {
            const [info, offering] = await Promise.all([getCustomerInfoSafe(), getOfferingSafe()]);
            applyStoreInfo(info, offering);
            purchase.current = { before, purchasedTier: getActiveTier(info) };
            await pollPurchase(before, purchase.current.purchasedTier);
        },
        [applyStoreInfo, pollPurchase],
    );

    /** From `timed-out`: rerun both polls for the same purchase. */
    const checkAgain = async () => {
        if (purchaseStatus !== 'timed-out' || !purchase.current) return;
        await pollPurchase(purchase.current.before, purchase.current.purchasedTier);
    };

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
        // while `confirmPurchase` -> `refreshUserBillingAfterPurchase` is still retrying,
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
                await confirmPurchase(billing?.subscriptionTier ?? null);
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
        purchaseStatus,
        checkAgain,
        isPremium,
        activeEntitlement,
        handleViewPlans,
        handleCustomerCenter,
        planDisplay,
        effectiveTier,
        isPaid,
    };
}
