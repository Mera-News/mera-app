// Paywall BEFORE onboarding.
//
// ## The bug this exists to fix
//
// With the server's `FORCE_SUBSCRIPTIONS` flag on, no new user could sign up at
// all. Onboarding step 2 is a Mera chat screen; it prewarms the cloud-chat path,
// which needs the Mera JWT from `/api/auth/token`; the auth service's
// `subscriptionTokenGate` refuses that token with 403 SUBSCRIPTION_REQUIRED for
// anyone without an active tier and has no onboarding exemption; the inference
// gateway then answers 401 and the chat dies with
// `NEAR attestation failed (401)`. The paywall was only presented AFTER
// onboarding, so the user never got a chance to pay their way out of it.
//
// The fix is ordering, not new UI: resolve entitlement first, and route a
// user with no active plan to the EXISTING paywall screen before the wizard can
// mount.
//
// ## Where this is used
//
// `components/custom/onboarding/OnboardingScreen.tsx` — the ONLY mounter of
// `OnboardingWizard`, and therefore the real chokepoint. Both doorways into
// onboarding pass through it: the cold-start route (`app/logged-in/index.tsx`)
// and the deep-link-verify redirect (`DeepLinkVerifyScreen`), which goes
// straight to `/logged-in/onboarding` and bypasses the cold-start gate entirely.
//
// 2026-08-06: `app/login.tsx` used to be a THIRD doorway — it redirected a live
// session straight to `/logged-in/onboarding`, skipping the identity, local-fact
// and entitlement gates in `app/logged-in/index.tsx`. It now redirects to
// `/logged-in`, so that path resolves like every other entry. The deep-link
// verify redirect still bypasses the cold-start gate, so the chokepoint argument
// above survives with one doorway fewer.
//
// `app/logged-in/index.tsx` calls the same two functions on its no-facts branch
// so the cold-start path resolves the decision in place instead of bouncing
// through the onboarding route first. Same logic, one definition.
//
// ## Ship gate
//
// While `FREE_TIER_MODE_ENABLED` is false, `deriveAiAccess` short-circuits to
// `'entitled'`, so `resolveEntitlementForOnboarding` returns on its FIRST
// statement — no network wait, no store subscription, no behaviour change.
// Everything here is inert until that flag flips. `DEV_FORCE_AI_ACCESS` sits
// above the ship gate, so the simulator harness can still drive every branch.

import { useSubscriptionStore } from '@/lib/stores/subscription-store';
import { loginRevenueCat } from '@/lib/revenuecat';
import { syncEntitlement } from '@/lib/subscription/entitlement-sync';

/**
 * Fire the two entitlement calls that used to sit behind the pre-onboarding
 * wait, WITHOUT waiting for either.
 *
 * ## What was here, and why it went
 *
 * This module used to hold the splash for up to 8 seconds resolving a verdict,
 * then route a user with no active plan away from onboarding, because the
 * wizard's step 2 is a Mera chat whose token the server refused without a
 * subscription. Starter is now granted to every account, so there is no verdict
 * that routes anywhere else: every outcome of that wait led to the wizard. A
 * wait whose branches have converged is pure latency, and it was paid on the
 * slowest launch there is, a brand-new user's first.
 *
 * ## What is kept, and why
 *
 * `loginRevenueCat` is the load-bearing half and is NOT optional: without it a
 * purchase made later attaches to the anonymous RevenueCat id the SDK mints at
 * configure time, and the entitlement lands on nobody. It was already
 * fire-and-forget inside the old wait; only the await around the verdict is
 * gone.
 *
 * `syncEntitlement({ force: true })` is forced for the same reason it always
 * was: this is a fresh session, and the 60s debounce would otherwise make a
 * brand-new user wait it out.
 *
 * Never throws and never rejects. Callers fire it and move on.
 */
export function startEntitlementWarmup(userId?: string): void {
    if (userId) {
        void loginRevenueCat(userId)
            .then((info) => {
                if (info) useSubscriptionStore.getState().setCustomerInfo(info);
            })
            .catch(() => {
                // RevenueCat is a mirror, not the source of truth. A failure
                // here costs nothing that `syncEntitlement` does not recover.
            });
    }
    void syncEntitlement({ force: true });
}
