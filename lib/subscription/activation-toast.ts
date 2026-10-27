// The one place a completed subscription is announced to the user.
//
// Friction this removes (the repo rule: name it or don't add the pattern): the
// purchase call sites — ManageSubscriptionScreen, presentFreeTierPaywall
// and NotSubscribedScreen — share
// one contract, `{ billing, confirmed }` from `refreshUserBillingAfterPurchase`,
// and each already branches on `confirmed` the same way. The toast hangs off that
// same branch everywhere, so it is one behaviour, not five copies.
//
// ## It announces a CONFIRMED PURCHASE, whatever the plan was before
//
// A first-time LOGIN once produced "Promo is active" with no purchase anywhere in the session, so the toast
// must hang only off a server-confirmed purchase (below), never off "a plan exists". Every confirmed purchase
// shows it, including an upgrade between paid tiers and a Starter bought on top of the free grant: the caller
// has already established that a purchase happened, so no previous tier is needed. `planName()` returns null
// for a tier with no plan name rather than inventing one.
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
// showSuccess is the same success MeraToast as the sign-out toast in AppPreferencesTab.

import i18next from 'i18next';
import { Platform } from 'react-native';
import { showDialog } from '@/lib/dialog';
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
 * Announce a SERVER-CONFIRMED purchase.
 *
 * @param newTier the tier the SERVER reported afterwards. Silent unless it is a recognised paid tier.
 *
 * Call only on `confirmed: true`. Never on `confirmed: false` — that result is
 * the pre-purchase snapshot and is ambiguous by construction (a slow webhook vs.
 * a deferred App Store plan change), which is why the callers refuse to commit
 * it either.
 */
export function showSubscriptionActivatedToast(
    newTier: string | null | undefined,
    restored = false,
): void {
    if (newTier == null) return;

    const plan = planName(newTier);
    if (plan === null) return;

    const t = i18next.t as unknown as (k: string, o?: Record<string, unknown>) => string;
    // A restore brings an old plan back; it is not a purchase, so no receipts note.
    if (restored) {
        toastManager.showSuccess(t('subscription.planBack'), '');
        return;
    }
    toastManager.showSuccess(
        t('subscription.activatedTitle', { plan }),
        t('subscription.activatedBody'),
    );
    void showInvoicesNoteOnce(plan, t);
}

const INVOICES_NOTE_KEY = 'invoices_note_shown';

/** Where receipts go, told once per device after the first confirmed purchase. */
async function showInvoicesNoteOnce(plan: string, t: (k: string, o?: Record<string, unknown>) => string): Promise<void> {
    try {
        // Lazy: this module sits on the paywall import path of six surfaces, and a
        // static settings import would open the database in all their suites.
        const { getSetting, setSetting } =
            require('@/lib/database/services/setting-service') as typeof import('@/lib/database/services/setting-service');
        if (await getSetting(INVOICES_NOTE_KEY)) return;
        await setSetting(INVOICES_NOTE_KEY, '1');
        await showDialog({
            title: t('subscription.activatedTitle', { plan }),
            body: t(Platform.OS === 'ios' ? 'subscription.invoicesAppStore' : 'subscription.invoicesPlayStore'),
            confirmLabel: t('common.ok'),
        });
    } catch {
        // A missing note must never break the purchase announcement.
    }
}
