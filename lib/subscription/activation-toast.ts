// The one place a completed subscription is announced to the user.
//
// Friction this removes (the repo rule: name it or don't add the pattern): four
// purchase call sites — ProfileScreen, ManageSubscriptionScreen,
// PersonaL1MeraProtocol and presentFreeTierPaywall — already share one contract,
// `{ billing, confirmed }` from `refreshUserBillingAfterPurchase`, and each of
// them already branches on `confirmed` in the same way. The toast hangs off that
// same branch in all four, so it is one behaviour, not four similar lines.
//
// WHY `confirmed` AND NOT THE APPLE/RevenueCat RESULT: `PAYWALL_RESULT.PURCHASED`
// only means the STORE took the money. Our server learns about it via the
// RevenueCat webhook, which routinely lands seconds later — announcing success on
// the store result would put "your plan is active" on screen while the app is
// still rendering the previous plan. `confirmed: true` is precisely "the server
// agreed", which is the same fact `setServerBilling` commits.
//
// `toastManager` rather than `useToast()`: `presentFreeTierPaywall` is a plain
// module, not a component, and this must behave identically from all four sites.
// Placement/variant match the sign-out toast in AppPreferencesTab
// (`placement: 'top'`, `action="success"`, `variant="solid"`) — showSuccess is
// that same shape. See toast-manager.ts's TOAST_TITLE_COLOR note for why it
// builds plain RN `Text` instead of ToastTitle/ToastDescription.

import i18next from 'i18next';
import { toastManager } from '@/lib/toast-manager';

/**
 * Display name for a server `subscriptionTier`. Reuses the existing
 * `subscription.plan*` keys — the same mapping ManageSubscriptionScreen's local
 * `planName` uses — rather than introducing a second set of plan labels.
 */
function planName(tier: string | null | undefined): string {
    const t = i18next.t as unknown as (k: string) => string;
    if (tier === 'professional') return t('subscription.planProfessional');
    if (tier === 'individual') return t('subscription.planIndividual');
    if (tier === 'starter') return t('subscription.planStarter');
    return t('subscription.planPromo');
}

/**
 * Announce a SERVER-CONFIRMED activation.
 *
 * Call only on `confirmed: true`. Never on `confirmed: false` — that result is
 * the pre-purchase snapshot and is ambiguous by construction (a slow webhook vs.
 * a deferred App Store plan change), which is exactly why the callers refuse to
 * commit it.
 */
export function showSubscriptionActivatedToast(tier: string | null | undefined): void {
    // Guard, not decoration. `planName` falls through to "Promo" for anything it
    // does not recognise, and two live paths can arrive here with no usable
    // tier: `leaveForRouterGate` reads `serverTier` straight after a
    // `syncEntitlement` that writes nothing when its fetch failed, and the late
    // polls pass `later.billing?.subscriptionTier`, which may be undefined.
    // Announcing "Promo is active" after a real purchase is worse than staying
    // quiet — the plan display will still correct itself either way.
    if (tier == null || tier === 'none') return;

    const t = i18next.t as unknown as (k: string, o?: Record<string, unknown>) => string;
    toastManager.showSuccess(
        t('subscription.activatedTitle', { plan: planName(tier) }),
        t('subscription.activatedBody'),
    );
}
