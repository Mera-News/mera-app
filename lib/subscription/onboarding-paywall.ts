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

import { getAiAccess, useSubscriptionStore } from '@/lib/stores/subscription-store';
import { loginRevenueCat } from '@/lib/revenuecat';
import { syncEntitlement } from '@/lib/subscription/entitlement-sync';
import { aiAccessIsServerResolved, type AiAccess } from '@/lib/subscription/ai-access';
import {
    aiAccessFromLastKnownTier,
    readLastKnownTier,
    rememberLastKnownTier,
} from '@/lib/subscription/last-known-tier';

/**
 * How long the splash may hold waiting for the server's billing verdict.
 *
 * Generous on purpose. The realistic resolution is one GraphQL round trip
 * (~300ms); this is a ceiling that only ever elapses when the server is
 * unreachable or pathologically slow, and racing a short timer would push
 * exactly the users this gate protects onto the timeout branch.
 *
 * Only ever paid by a user with ZERO local facts — i.e. one who is about to
 * enter onboarding. An already-onboarded user never reaches it.
 */
export const ONBOARDING_ENTITLEMENT_WAIT_MS = 8_000;

/** What the pre-onboarding gate decided to do. */
export type OnboardingEntry =
    /** No active plan, never dismissed → the existing paywall screen. */
    | 'paywall'
    /** No active plan, already dismissed → Mera News Free, onboarding skipped. */
    | 'free-tier'
    /** Active plan (or an unresolvable verdict) → the wizard, as before. */
    | 'onboarding';

export interface OnboardingEntryInputs {
    /**
     * The resolved verdict. `'unknown'` here means the bounded wait below
     * EXPIRED **and** this device has no last-known tier to fall back on — i.e.
     * it has NEVER resolved entitlement WITH OUR SERVER. Callers must not pass
     * a verdict they are still waiting on, or they will decide during the
     * loading state this gate exists to hold.
     */
    aiAccess: AiAccess;
    /**
     * `readFirstOpenDismissed()` — consulted on every non-entitled branch.
     *
     * Callers MUST read it whenever `aiAccess !== 'entitled'`, not just on
     * `'locked'`: since 2026-08-06 `'unknown'` also diverts, and a caller that
     * hard-coded `false` there would send a user who already dismissed the
     * paywall straight back to it — the dismiss → paywall → dismiss loop
     * `first-open-dismissal.ts` exists to prevent.
     */
    firstOpenDismissed: boolean;
}

/**
 * The whole ordering decision, as one pure function.
 *
 * Keyed on `aiAccess === 'locked'` and NOTHING else. Deliberately not
 * `hasEverSubscribed === false` the way `FirstOpenPaywallGate` is: that field
 * comes from `fetchUserBillingLapseState()`, which is explicitly allowed to fail
 * on a server that predates the lapse fields and then stays `null` forever — a
 * strictly-false check would make this gate silently unreachable there. `locked`
 * is also the correct reading of "not already a paying or trialing customer":
 * the server's `resolveTier` is period_type-agnostic, so an active trial is
 * already a real tier and lands on `'entitled'` with no special-casing, and a
 * LAPSED user is correctly included.
 */
export function decideOnboardingEntry({
    aiAccess,
    firstOpenDismissed,
}: OnboardingEntryInputs): OnboardingEntry {
    if (aiAccess === 'entitled') return 'onboarding';

    // `'unknown'` FAILS OPEN. This is the third position this line has held, so
    // the reasoning for each is worth keeping.
    //
    //  - Originally `if (aiAccess !== 'locked') return 'onboarding'`, on the
    //    argument that a timeout should land on "exactly today's behaviour".
    //  - REVERSED 2026-08-06: with the ship gate on, `'unknown'` was the state
    //    of every cold start before billing answered, so a slow server dropped
    //    brand-new users into the persona chat instead of the paywall. Both
    //    non-entitled states routed to the paywall from then on.
    //  - REVERSED AGAIN (r13): the server now GRANTS every account a free
    //    14-day Starter window, and enforcement of that grant is entirely
    //    server-side. Once the server is the thing deciding, a client guess of
    //    "locked" while waiting is not a safe default — it is the failure mode.
    //    It puts a paywall in front of precisely the new users the grant exists
    //    to convert, on the slow first launch where it does the most damage.
    //
    // Guessing optimistically now costs nothing to be wrong about: if the user
    // genuinely is not entitled, the feed answers 402, `recordAiLocked` writes
    // `serverTier: 'none'`, and the free-tier UI catches them on the very next
    // pass. There is no state a client can reach by guessing 'onboarding' that
    // grants it any server content.
    //
    // Note this is only reachable at all when `'unknown'` survives
    // `resolveEntitlementForOnboarding`, which since r13 means "OUR SERVER has
    // never answered on this device" — not "RevenueCat says no".
    if (aiAccess === 'unknown') return 'onboarding';

    // `'locked'` is a real, server-backed refusal. Dismissal must not loop back
    // to the paywall, and must not strand the user un-onboarded either: the
    // moment they subscribe the verdict becomes `'entitled'` and onboarding
    // runs on the next pass.
    return firstOpenDismissed ? 'free-tier' : 'paywall';
}

/**
 * Resolve `aiAccess` to something other than `'unknown'`, or give up.
 *
 * Kicks the fetches itself rather than assuming a caller did: the deep-link
 * verify path reaches onboarding WITHOUT going through
 * `app/logged-in/index.tsx`, so on that path nothing has called
 * `syncEntitlement` or `loginRevenueCat` yet. `loginRevenueCat` matters beyond
 * the verdict — without it a purchase made from the pre-onboarding paywall would
 * attach to an anonymous RevenueCat id.
 *
 * `'unknown'` is returned ONLY by a device that has never resolved a tier. Any
 * other unresolvable outcome is answered from this device's memory — see
 * `lib/subscription/last-known-tier.ts`.
 */
export async function resolveEntitlementForOnboarding(opts: {
    userId?: string;
    isConnected: boolean;
    timeoutMs?: number;
}): Promise<AiAccess> {
    // FIRST statement, and load-bearing: with the ship gate false (or a dev
    // override set) `serverResolvedAiAccess` answers synchronously, so the gate
    // costs nothing at all. It also short-circuits the common case where
    // billing is already known.
    //
    // Keyed on OUR SERVER having answered, not merely on the verdict having
    // left `'unknown'`. Before r13 this read `getAiAccess() !== 'unknown'`,
    // which returned a RevenueCat-derived `'locked'` — from a cached,
    // identified-but-empty CustomerInfo — before `syncEntitlement` had even
    // been called. That is the cold-start race: RevenueCat cannot know about
    // the server's free 14-day grant, so its "no entitlement" is not an answer
    // to the question being asked.
    const immediate = serverResolvedAiAccess();
    if (immediate !== 'unknown') {
        void recordResolvedTier();
        return immediate;
    }

    // Offline: unresolvable from the network, and no amount of waiting changes
    // that. Return straight away rather than holding the splash for the full
    // timeout — but consult this device's memory first, which is what lets an
    // OFFLINE SUBSCRIBER keep working instead of meeting a purchase sheet they
    // could not use anyway.
    if (!opts.isConnected) return lastKnownFallback();

    if (opts.userId) {
        void loginRevenueCat(opts.userId)
            .then((info) => {
                if (info) useSubscriptionStore.getState().setCustomerInfo(info);
            })
            .catch(() => {
                // RevenueCat is only the fallback signal; the server below is
                // the one that decides.
            });
    }
    // Forced: this is a fresh session and the 60s debounce would otherwise make
    // a brand-new user wait it out on the splash.
    void syncEntitlement({ force: true });

    // BOUNDED, still. An unbounded hold is a worse failure mode than a wrong
    // guess — it is a splash screen with no exit.
    const waited = await waitForAiAccessResolved(
        opts.timeoutMs ?? ONBOARDING_ENTITLEMENT_WAIT_MS,
    );
    if (waited !== 'unknown') {
        void recordResolvedTier();
        return waited;
    }

    // The wait expired. Trust what this device already learned; only a device
    // that has NEVER resolved a tier stays 'unknown' from here.
    return lastKnownFallback();
}

/**
 * Persist whatever tier the store currently holds, so a LATER unresolvable cold
 * start has something to fall back on.
 *
 * Reads the tier rather than the derived verdict — see `last-known-tier.ts` for
 * why. `serverTier` first (the source of truth), then RevenueCat's mirror, which
 * is the only signal present when a purchase has completed but our webhook has
 * not landed yet. Both `null` means nothing was actually learned (a `'locked'`
 * verdict derived purely from an identified-but-empty CustomerInfo), and
 * `rememberLastKnownTier` no-ops on that — which also keeps the ship-gate-off
 * path free of any database write.
 */
async function recordResolvedTier(): Promise<void> {
    const state = useSubscriptionStore.getState();
    await rememberLastKnownTier(state.serverTier ?? state.tier);
}

/** Re-derive a verdict from this device's memory. `'unknown'` ⇒ never resolved. */
async function lastKnownFallback(): Promise<AiAccess> {
    return aiAccessFromLastKnownTier(await readLastKnownTier());
}

/**
 * Resolve as soon as `aiAccess` leaves `'unknown'`, or with whatever it is when
 * `timeoutMs` elapses.
 *
 * Exported for the tests; production code should call
 * `resolveEntitlementForOnboarding`, which also starts the fetches.
 */
export function waitForAiAccessResolved(timeoutMs: number): Promise<AiAccess> {
    const now = serverResolvedAiAccess();
    if (now !== 'unknown') return Promise.resolve(now);

    return new Promise<AiAccess>((resolve) => {
        let settled = false;
        let unsubscribe: (() => void) | undefined;

        const finish = (value: AiAccess) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            unsubscribe?.();
            resolve(value);
        };

        const timer = setTimeout(() => finish(serverResolvedAiAccess()), timeoutMs);

        unsubscribe = useSubscriptionStore.subscribe(() => {
            const next = serverResolvedAiAccess();
            if (next !== 'unknown') finish(next);
        });

        // Re-check after subscribing: a store write that landed between the
        // read above and the subscription would otherwise be missed and cost
        // the full timeout.
        const afterSubscribe = serverResolvedAiAccess();
        if (afterSubscribe !== 'unknown') finish(afterSubscribe);
    });
}

/**
 * `getAiAccess()`, but `'unknown'` until OUR SERVER has actually answered.
 *
 * The single discriminator this whole gate turns on. `deriveAiAccess` is
 * allowed to answer optimistically from RevenueCat — that is right for the
 * surfaces it feeds, where a just-completed purchase should unlock chrome
 * seconds before our webhook lands. It is wrong for ROUTING, because RevenueCat
 * has no knowledge of the server's free 14-day Starter grant and answers from
 * local cache long before our GraphQL round trip completes. Taking its
 * `'locked'` as final is what would paywall a granted user.
 *
 * Not a general-purpose replacement for `getAiAccess`: use it only where a
 * wrong guess ROUTES a user somewhere, never where it merely renders.
 */
function serverResolvedAiAccess(): AiAccess {
    const { serverTier } = useSubscriptionStore.getState();
    return aiAccessIsServerResolved(serverTier) ? getAiAccess() : 'unknown';
}
