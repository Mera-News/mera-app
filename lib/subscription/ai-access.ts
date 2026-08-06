// The single place the app decides whether Mera's AI layer is available.
//
// "AI layer" means the four server queries behind `SubscriptionGuard`
// (articleIdsForTopics / articleIdsForPersona / articlesForTopicsByIds /
// articlesForStories), Mera chat, and starting a new tracked story. It does NOT
// mean the user's own data: saved articles, tracked-story history, reading
// history, persona facts and settings stay readable in every state.
//
// Kept pure and free of store imports so both the zustand selector and the
// imperative getter derive from the SAME function. A stored `aiAccess` field
// would go stale the first time one of its three writers forgot to recompute.

import {
    FREE_TIER_MODE_ENABLED,
    DEV_FORCE_AI_ACCESS,
    DEV_FORCE_LAPSED,
} from '@/lib/config/feature-gates';

/**
 * - `unknown` — we have not heard from the server OR RevenueCat yet. Surfaces
 *   must keep showing their existing loading state. Treating it as `locked`
 *   flashes Mera News Free at a paying subscriber on every cold start;
 *   treating it as `entitled` flashes real chrome at a locked user. Both are
 *   wrong, which is why this state is distinct and load-bearing.
 * - `entitled` — the AI layer is on.
 * - `locked` — Mera News Free: no NEW AI content, everything already on the
 *   device stays visible, scrollable and interactable.
 */
export type AiAccess = 'unknown' | 'entitled' | 'locked';

/** The raw signals `deriveAiAccess` reduces. Mirrored by the subscription store. */
export interface AiAccessInputs {
    /**
     * `subscriptionTier` as last read from OUR server (`userBilling`), or
     * `'none'` when the server answered a guarded query with a 402. `null`
     * means "never heard from the server", NOT "no subscription".
     */
    serverTier: string | null;
    /**
     * Has RevenueCat answered **about this user** — i.e. we hold a CustomerInfo
     * AND it belongs to an identified customer, not the anonymous one the SDK
     * mints at configure time. An anonymous payload describes nobody, so it
     * cannot be read as "this user is not subscribed".
     */
    hasCustomerInfo: boolean;
    /** RevenueCat's own verdict. Only consulted when the server is silent. */
    isPremium: boolean;
}

/**
 * Reduce the entitlement signals to one verdict.
 *
 * Precedence, highest first:
 *  1. the dev override (dev builds only — see feature-gates.ts),
 *  2. our server, which is the source of truth for tier (the same reason
 *     `billing-service.ts` already prefers it over RevenueCat's mirror),
 *  3. RevenueCat, as an optimistic stand-in while the server is unreachable —
 *     it knows about a just-completed purchase seconds before our webhook does,
 *  4. `unknown`.
 */
export function deriveAiAccess(inputs: AiAccessInputs): AiAccess {
    if (__DEV__ && DEV_FORCE_AI_ACCESS !== null) return DEV_FORCE_AI_ACCESS;

    // Ship gate. While false this wave is inert and the app behaves exactly as
    // it did before it — see FREE_TIER_MODE_ENABLED for why the OTA must not be
    // the cutover. Below the dev override so the harness can still drive every
    // state; above everything else so nothing can leak past it.
    if (!FREE_TIER_MODE_ENABLED) return 'entitled';

    if (inputs.serverTier !== null) {
        return inputs.serverTier === 'none' ? 'locked' : 'entitled';
    }

    // Asymmetric on purpose: RevenueCat may GRANT on any evidence, but may only
    // DENY on evidence about an identified customer.
    //
    // An active entitlement is a fact regardless of which customer record holds
    // it — including a purchase made before `Purchases.logIn` runs, which is a
    // real path (the pre-onboarding paywall). Granting on it is what lets a
    // just-completed purchase work seconds before our webhook lands.
    //
    // The absence of an entitlement is only meaningful once RevenueCat knows who
    // it is being asked about. While anonymous it knows nothing, and the honest
    // answer is 'unknown' — surfaces hold their loading state instead of
    // flashing Mera News Free at someone who has paid.
    if (inputs.isPremium) return 'entitled';
    if (inputs.hasCustomerInfo) return 'locked';

    return 'unknown';
}

/**
 * Whether the "your plan has ended" interstitial is owed to this user.
 *
 * The real answer is the SERVER's — a timestamp comparison on `UserBilling`
 * that survives reinstall, spans devices, and re-arms on a second lapse, which
 * no local boolean latch can do.
 *
 * `DEV_FORCE_LAPSED` seeds it rather than clamping it: once the gate has
 * acknowledged the interstitial (which in dev also records `devAcked`), the
 * override stops applying. A clamp would re-show the interstitial on every
 * relaunch, hiding exactly the "shown once" behaviour it exists to test.
 */
export function deriveShowLapseInterstitial(
    serverFlag: boolean | null,
    devAcked: boolean,
): boolean {
    if (__DEV__ && DEV_FORCE_LAPSED && !devAcked) return true;
    return serverFlag === true;
}

/**
 * `hasEverSubscribed`, with the one dev accommodation the first-open push needs.
 *
 * That field only exists on a server carrying the lapse change, and the query
 * for it is skipped entirely while the ship gate is false — so on the harness
 * it stays `null` forever, and `null` is deliberately not `false`, which makes
 * the first-open push unreachable. When the override is explicitly forcing
 * `'locked'`, "never subscribed" is exactly the state being simulated, so
 * resolve unknown to `false` there and nowhere else.
 */
export function deriveHasEverSubscribed(serverValue: boolean | null): boolean | null {
    if (__DEV__ && DEV_FORCE_AI_ACCESS === 'locked' && serverValue === null) return false;
    return serverValue;
}

/** Local device setting recording a dev-only acknowledgement of `DEV_FORCE_LAPSED`. */
export const DEV_LAPSE_ACK_SETTING_KEY = 'dev_free_tier_lapse_acked';
