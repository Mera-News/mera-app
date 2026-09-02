// The one place a completed subscription is announced to the user.
//
// Friction this removes (the repo rule: name it or don't add the pattern): the
// purchase call sites — ProfileScreen, ManageSubscriptionScreen,
// presentFreeTierPaywall and NotSubscribedScreen — share
// one contract, `{ billing, confirmed }` from `refreshUserBillingAfterPurchase`,
// and each already branches on `confirmed` the same way. The toast hangs off that
// same branch everywhere, so it is one behaviour, not five copies.
//
// ## It announces a TRANSITION, not an observation
//
// This is the correction for a real bug: a fresh first-time LOGIN produced
// "🎉 Promo is active" with no purchase anywhere in the session. Two things were
// wrong, and only the second was cosmetic.
//
// 1. The trigger was "we are leaving the paywall gate and the server says a plan
//    exists" — but `NotSubscribedScreen.checkServerSubscribed()` decides that by
//    asking whether `userPersonaByUserId` returns 200, and that query carries NO
//    `SubscriptionGuard` server-side. It returns 200 for everyone. So the gate
//    exit fired for a user who had never had a plan.
// 2. `planName()` fell through to `subscription.planPromo` for a `null` tier,
//    turning "we don't know" into a confident, wrong plan name.
//
// Hence the signature: BOTH the previous and the new tier. The toast fires only
// on `none → <paid>`. Someone who already holds a plan never sees it, and
// neither does someone merely passing through a gate, because there is no
// transition to report.
//
// WHY `confirmed` AND NOT THE APPLE/RevenueCat RESULT: `PAYWALL_RESULT.PURCHASED`
// only means the STORE took the money. Our server learns about it via the
// RevenueCat webhook, which routinely lands seconds later — announcing success on
// the store result would put "your plan is active" on screen while the app is
// still rendering the previous plan. `confirmed: true` is precisely "the server
// agreed", which is the same fact `setServerBilling` commits.
//
// `toastManager` rather than `useToast()`: `presentFreeTierPaywall` is a plain
// module, not a component, and this must behave identically from every site.
// Placement/variant match the sign-out toast in AppPreferencesTab
// (`placement: 'top'`, `action="success"`, `variant="solid"`) — showSuccess is
// that same shape. See toast-manager.ts's TOAST_TITLE_COLOR note for why it
// builds plain RN `Text` instead of ToastTitle/ToastDescription.

import i18next from 'i18next';
import { toastManager } from '@/lib/toast-manager';

/**
 * The only tiers the server ever writes to `UserBilling.subscriptionTier`
 * (`revenue-cat.service.ts` resolves exactly these, plus `'none'`), and the only
 * ones with a plan name. Anything else is by definition unrecognised.
 */
const PAID_TIER_LABEL_KEYS: Record<string, string> = {
    starter: 'subscription.planStarter',
    individual: 'subscription.planIndividual',
    professional: 'subscription.planProfessional',
};

/**
 * Display name for a server `subscriptionTier`, or `null` when there isn't one.
 *
 * Deliberately NOT falling back to `subscription.planPromo` the way
 * ManageSubscriptionScreen's local `planName` does. That key exists for legacy
 * promotional grants; using it as a catch-all turns any unexpected value into a
 * confident mislabel, which is exactly how a login produced "Promo is active".
 * A name we cannot derive means we say nothing.
 */
function planName(tier: string): string | null {
    const key = PAID_TIER_LABEL_KEYS[tier];
    if (!key) return null;
    return (i18next.t as unknown as (k: string) => string)(key);
}

/**
 * Announce a SERVER-CONFIRMED transition from no plan to a paid plan.
 *
 * @param previousTier the tier held BEFORE the purchase. `'none'` is the only
 *   value that permits a toast. `null`/`undefined` mean "we never read one",
 *   which is NOT the same as "inactive" — we cannot claim a transition we did
 *   not observe, so those stay silent.
 * @param newTier the tier the SERVER reported afterwards. Must be a recognised
 *   paid tier.
 *
 * Call only on `confirmed: true`. Never on `confirmed: false` — that result is
 * the pre-purchase snapshot and is ambiguous by construction (a slow webhook vs.
 * a deferred App Store plan change), which is why the callers refuse to commit
 * it either.
 */
export function showSubscriptionActivatedToast(
    previousTier: string | null | undefined,
    newTier: string | null | undefined,
): void {
    // "Was inactive" — explicitly, not merely "not paid". See @param above.
    if (previousTier !== 'none') return;
    if (newTier == null) return;

    const plan = planName(newTier);
    if (plan === null) return;

    const t = i18next.t as unknown as (k: string, o?: Record<string, unknown>) => string;
    toastManager.showSuccess(
        t('subscription.activatedTitle', { plan }),
        t('subscription.activatedBody'),
    );
}
