// The one way a free-tier surface opens the paywall.
//
// Friction this removes (the repo rule: name it or don't add the pattern):
// four surfaces — FreeTierCard, FreeTierInlineNotice,
// FreeTierReadOnlyBanner and useTrackButton — each carried a byte-identical
// resolve-offering → presentPaywall → try/catch block. That is not three
// similar lines; it is four copies of one behaviour, and all four had drifted
// into the same bug: none of them re-read entitlement afterwards.
//
// Why the re-read is the whole point: `deriveAiAccess` consults `serverTier`
// FIRST and returns 'locked' whenever it is 'none', and `markServerLocked()`
// pins it to 'none' on any 402 from a guarded AI query. RevenueCat's
// `addCustomerInfoUpdateListener` therefore CANNOT heal the state after a
// purchase — the server tier outranks it. Without this, a user who buys from a
// free-tier surface stays on Mera News Free until the app backgrounds and
// foregrounds.

import { refreshUserBillingAfterPurchase } from '@/lib/billing-service';
import logger from '@/lib/logger';
import { getOfferingSafe } from '@/lib/revenuecat';
import { useSubscriptionStore } from '@/lib/stores/subscription-store';
import { syncEntitlement } from '@/lib/subscription/entitlement-sync';
import { showSubscriptionActivatedToast } from '@/lib/subscription/activation-toast';
import { rememberLastKnownTier } from '@/lib/subscription/last-known-tier';
import RevenueCatUI, { PAYWALL_RESULT } from 'react-native-purchases-ui';

/**
 * Present the free-tier paywall, then refresh entitlement so the lock lifts.
 *
 * @param source Which surface asked. Carried into Sentry as the `method` tag,
 *               so the per-site diagnostics the four inlined copies had are not
 *               lost to the extraction.
 *
 * On PURCHASED/RESTORED this follows ProfileScreen's proven contract rather
 * than firing one `syncEntitlement`: at the instant `presentPaywall` resolves
 * the RevenueCat webhook has usually NOT reached our server, so a single read
 * would fetch back `subscriptionTier: 'none'` and re-pin the lock — green
 * against a Test Store, broken against a real purchase.
 * `refreshUserBillingAfterPurchase` already owns that retry budget.
 *
 * `confirmed: false` means "gave up still seeing the old tier", which is
 * ambiguous (slow webhook vs. a deferred App Store plan change). The snapshot
 * is stale by definition, so it is NOT committed — committing it is the exact
 * bug P12 fixed on the billing screens. A forced `syncEntitlement` is left
 * running so the state still self-heals on the next successful read, and the
 * surface simply stays locked until then.
 *
 * Every other resolution (cancelled, error, not presented) still forces one
 * cheap sync: a RESTORE or a purchase that landed while the sheet was open
 * must not be missed, and one query on dismiss is far cheaper than the poll.
 *
 * Never throws — every caller fires this from a press handler. Nothing is
 * refreshed when `presentPaywall` itself throws: nothing was presented, so
 * nothing can have changed.
 */
export async function presentFreeTierPaywall(source: string): Promise<void> {
    try {
        const offering = await getOfferingSafe();
        const result = await RevenueCatUI.presentPaywall({
            ...(offering ? { offering } : {}),
            // Dismissible: this is an invitation from inside a mode the user is
            // entitled to stay in, not a gate they must clear.
            displayCloseButton: true,
        });

        if (result !== PAYWALL_RESULT.PURCHASED && result !== PAYWALL_RESULT.RESTORED) {
            // `force`, because the 60s debounce would otherwise swallow exactly
            // the moment the value is most likely to have just changed.
            await syncEntitlement({ force: true });
            return;
        }

        // Read non-reactively: this runs in an event handler, and the store is
        // the same `serverTier` `deriveAiAccess` is about to be re-derived from.
        const previousTier = useSubscriptionStore.getState().serverTier;
        const { billing, confirmed } = await refreshUserBillingAfterPurchase(previousTier);

        if (confirmed && billing) {
            useSubscriptionStore.getState().setServerBilling(billing);
            // This branch does NOT go through syncEntitlement, so it needs its
            // own write of the device's last-known tier. It matters more than
            // most: a purchase made from the PRE-ONBOARDING paywall is exactly
            // how a device ends up with a real tier and zero local facts, i.e.
            // the one profile that still meets the onboarding entitlement gate
            // on its next cold start. See lib/subscription/last-known-tier.ts.
            void rememberLastKnownTier(billing.subscriptionTier ?? 'none');
            // Only here — the server has agreed. On the unconfirmed branch below
            // the snapshot is the PRE-purchase tier, so a toast there would
            // announce a plan the app is still not showing.
            showSubscriptionActivatedToast(previousTier, billing.subscriptionTier);
            return;
        }

        void syncEntitlement({ force: true });
    } catch (error) {
        logger.captureException(error, {
            tags: { component: 'presentFreeTierPaywall', method: source },
        });
    }
}
