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
    DEV_FORCE_AI_ACCESS,
    DEV_FORCE_LAPSED,
} from '@/lib/config/feature-gates';

/**
 * - `unknown` — we have not heard from the server yet. Surfaces must keep
 *   showing their existing loading state rather than guessing in either
 *   direction, which is why this state is distinct and load-bearing.
 * - `entitled` — the AI layer is on. Every account reaches this once the
 *   server answers.
 * - `locked` — **NOTHING PRODUCES THIS ANY MORE. Do not write a new branch on
 *   it, and do not treat an existing one as live code.**
 *
 *   Starter is granted to every account as a permanent read-time baseline, so
 *   there is no longer a state that denies the AI layer. All three producers
 *   were removed in the `starter-free` wave:
 *     - `deriveAiAccess` denying on an identified-but-empty RevenueCat
 *       CustomerInfo, which under a server-side grant described a fully
 *       ENTITLED user and put a spurious `'locked'` window on every cold start;
 *     - `deriveAiAccess` reading `serverTier === 'none'`, a tier the server no
 *       longer sends;
 *     - `recordAiLocked` (`ai-lock.ts`, deleted) pinning the store to `'none'`
 *       from a 402 or a /token 403.
 *
 *   The member is KEPT deliberately rather than deleted. Around 30 call sites
 *   across five areas still branch on it, and removing the member would break
 *   all of them at once for no behavioural gain, since none of those branches
 *   can be entered. Removing those consumers is separate, deliberate work; it
 *   was scoped and explicitly declined, not overlooked.
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

    // The server having ANSWERED is now the whole test. Every account without a
    // purchase carries Starter as a permanent read-time baseline, so the tier
    // string can no longer be a refusal — `'none'` is not a value the server
    // sends any more. Comparing against it would be a branch nothing can enter.
    if (inputs.serverTier !== null) return 'entitled';

    // RevenueCat may GRANT, and may NEVER deny.
    //
    // An active entitlement is a fact regardless of which customer record holds
    // it — including a purchase made before `Purchases.logIn` runs. Granting on
    // it is what lets a just-completed purchase work seconds before our webhook
    // lands.
    //
    // It used to be allowed to deny too, on an identified-but-empty
    // CustomerInfo. That is now WRONG BY CONSTRUCTION: every account without a
    // purchase holds Starter, granted server-side, and RevenueCat has no
    // knowledge of that grant and never will — the same reason
    // `aiAccessIsServerResolved` exists. An empty CustomerInfo therefore
    // describes a fully entitled user, and since RevenueCat answers from local
    // cache far faster than a GraphQL round trip, denying on it produced a
    // `'locked'` window on EVERY cold start, for every user who had not paid.
    //
    // `'unknown'` is the honest answer while only RevenueCat has spoken:
    // surfaces hold their loading state rather than acting on a verdict our
    // server has not given. A real refusal now comes from one place, the server
    // saying `'none'` above.
    if (inputs.isPremium) return 'entitled';

    return 'unknown';
}

/**
 * Has OUR SERVER contributed to the current `aiAccess` verdict?
 *
 * ## Why this exists
 *
 * The server now grants every account a free 14-day Starter window. RevenueCat
 * knows nothing about that grant and never will — it is derived from the
 * account's creation date on our side. So a verdict reached WITHOUT the server
 * is not merely incomplete for a granted user, it is actively wrong: RevenueCat
 * answers from local cache far faster than a GraphQL round trip, and an
 * identified-but-empty `CustomerInfo` makes `deriveAiAccess` return `'locked'`
 * while `serverTier` is still `null`. Routing on that verdict shows a paywall
 * to exactly the cohort the grant exists to convert, on exactly the slow first
 * launch where it is least recoverable.
 *
 * `aiAccess !== 'unknown'` is therefore NOT the right test for "have we heard
 * enough to route". This is.
 *
 * The short-circuit above `deriveAiAccess`'s server branch is mirrored here,
 * because there the server is genuinely irrelevant: the dev override outranks
 * every signal.
 */
export function aiAccessIsServerResolved(serverTier: string | null): boolean {
    if (__DEV__ && DEV_FORCE_AI_ACCESS !== null) return true;
    return serverTier !== null;
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
