import { gql } from '@apollo/client';
import client from './apollo-client';
import { UserBillingInfo } from './generated/graphql-types';
import logger from './logger';
import { noteBillingTier } from './subscription/plan-rise';
import { setReadHold } from './subscription/read-hold';

const GET_USER_BILLING = gql`
  query GetUserBilling {
    userBilling {
      subscriptionTier
      dailyArticleLimit
      articlesUsedToday
      entitlementExpiresAt
      resetAt
      grantExpiresAt
    }
  }
`;

// DELIBERATELY A SEPARATE QUERY, not two more fields on the one above.
//
// `hasEverSubscribed` / `showLapseInterstitial` exist on the server's `dev`
// branch and are NOT deployed to prod yet (this repo's branch→env model has no
// CD from `dev`). Selecting an unknown field is a GraphQL VALIDATION error, and
// validation rejects the WHOLE operation — so folding them into the query above
// would not degrade the lapse feature, it would take out `subscriptionTier`,
// `dailyArticleLimit` and `articlesUsedToday` too, for every user, immediately.
// That is the same failure mode `feature-gates.ts` documents at length for
// HEADLINE_DEPTH_UI_ENABLED.
//
// Split like this, an un-deployed server costs exactly one swallowed error and
// leaves `hasEverSubscribed` null — which every consumer already reads as
// "unknown, do nothing". Delete this split and re-merge the fields once the
// server change is live in prod.
//
// `grantExpiresAt` USED to live only here for the same reason — it was new on
// the server's `dev` branch when this split was written. It is now live in
// prod, so it was re-merged onto `GET_USER_BILLING` above (r14). It is kept
// here too rather than removed: this query already reads it (free-tier-gated,
// see `fetchUserBillingLapseState` below) and there is no cost to leaving it,
// only a cost to a partial edit that misses a caller.
const GET_USER_BILLING_LAPSE_STATE = gql`
  query GetUserBillingLapseState {
    userBilling {
      subscriptionTier
      hasEverSubscribed
      showLapseInterstitial
      grantExpiresAt
    }
  }
`;

/**
 * Fetch ONLY the lapse-related fields. Returns null on any error — including
 * the expected "this server doesn't know those fields yet" validation error,
 * which is why this is deliberately quiet: it would otherwise fire a Sentry
 * event on every foreground, every login and every Profile focus, for every
 * user, until the server change reaches prod.
 */
export async function fetchUserBillingLapseState(): Promise<UserBillingInfo | null> {
    try {
        const { data } = await client.query<UserBillingResponse>({
            query: GET_USER_BILLING_LAPSE_STATE,
            fetchPolicy: 'no-cache',
        });
        return data?.userBilling ?? null;
    } catch {
        // Intentionally not reported. See the query's comment.
        return null;
    }
}

interface UserBillingResponse {
    userBilling: UserBillingInfo;
}

// The reading meter, DELIBERATELY its own query, for the reason the lapse split
// above gives: selecting a field the deployed server does not know fails the
// WHOLE operation, and these three are new. Split, a server without them costs
// one swallowed error and takes nothing else down. Merge into GET_USER_BILLING
// once the server change is live in prod.
const GET_USER_READING = gql`
  query GetUserReading {
    userBilling {
      readingUsed
      readingResetAt
      planMultiplier
    }
  }
`;

/** The reading meter as the server reports it. `readingUsed` is the share of
 *  today's cloud reading used (0..1), null when the meter is unreachable. */
export interface UserReading {
    readingUsed: number | null;
    readingResetAt: string | null;
    planMultiplier: number;
}

/**
 * Fetch the reading meter and mirror it into the read hold. Quiet on failure
 * (see GET_USER_READING): returns null and reports nothing.
 *
 * `resetAt` is written ONLY when the day is used up: the server's
 * `readingResetAt` is the next reset whether or not anything is held, and
 * writing it unconditionally would hold every user. A lower `readingUsed`
 * never ends a hold either; only a tier rise does (plan-rise.ts).
 */
export async function fetchUserReading(): Promise<UserReading | null> {
    try {
        const { data } = await client.query<{ userBilling: UserReading }>({
            query: GET_USER_READING,
            fetchPolicy: 'no-cache',
            // The error link runs before the catch below, so quiet needs both:
            // the missing-fields code is a breadcrumb, and no error here is a
            // Feed sync failure (lib/apollo-client.ts).
            context: { noSyncStatus: true, expectedErrorCodes: ['GRAPHQL_VALIDATION_FAILED'] },
        });
        const reading = data?.userBilling ?? null;
        if (!reading) return null;
        const used = typeof reading.readingUsed === 'number' ? reading.readingUsed : null;
        const resetAt = reading.readingResetAt ? Date.parse(reading.readingResetAt) : NaN;
        if (used != null && used >= 1 && Number.isFinite(resetAt)) {
            await setReadHold({ used, resetAt });
        } else if (used != null) {
            await setReadHold({ used });
        }
        return reading;
    } catch {
        // Intentionally not reported. See the query's comment.
        return null;
    }
}

/**
 * Fetch the current user's billing/quota snapshot from the server — the DB is
 * the source of truth for tier and daily article limit (RevenueCat customerInfo
 * is only optimistic client state). Returns null on any error; callers fall
 * back to promo/default display.
 */
export async function fetchUserBilling(): Promise<UserBillingInfo | null> {
    try {
        const { data } = await client.query<UserBillingResponse>({
            query: GET_USER_BILLING,
            fetchPolicy: 'no-cache',
        });
        const billing = data?.userBilling ?? null;
        // A tier that rose since the last read applies now (plan-rise.ts).
        if (billing) noteBillingTier(billing.subscriptionTier);
        return billing;
    } catch (error) {
        logger.captureException(error, {
            tags: { component: 'billing-service', method: 'fetchUserBilling' },
        });
        return null;
    }
}

// A purchase is a discrete event, but the tier it produces only reaches our DB
// once RevenueCat's webhook has been delivered and processed. Fetching once the
// moment the paywall closes therefore usually reads the *pre*-purchase tier,
// which is the "the phone UI takes a while to update" complaint.
//
// The old budget was 5 tries, 2s apart — ~9 seconds. That was optimistic:
// `RevenueCatService.syncSubscriber()` makes its own outbound REST call BACK to
// RevenueCat before it writes Mongo, on top of RevenueCat's own webhook
// dispatch delay, so the round trip can structurally exceed 9s. Losing that
// race is what made a real purchase sit on screen showing the old plan.
//
// TODO(tune): this budget is a reasoned placeholder — roughly 2.5× the old one,
// with backoff so a fast webhook still resolves in ~2s. It is NOT measured. The
// plan's QA step (a sandbox purchase in the simulator, timing the gap between
// "purchase successful" and the `UserBilling` write landing in Mongo) produces
// the real number; size these three constants from it once it exists.
const PURCHASE_REFRESH_ATTEMPTS = 8;
const PURCHASE_REFRESH_INTERVAL_MS = 1500;
const PURCHASE_REFRESH_BACKOFF = 1.5;
const PURCHASE_REFRESH_MAX_INTERVAL_MS = 4000;

/** `null`, `undefined` and the server's `'none'` all mean "no paid tier". */
function normalizeTier(tier: string | null | undefined): string {
    return tier == null || tier === 'none' ? 'none' : tier;
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export interface RefreshBillingOptions {
    /** Total fetches, including the first. Default 8. */
    attempts?: number;
    /** Gap before the SECOND fetch; grows by `backoffFactor`. Default 1500ms. */
    intervalMs?: number;
    /** Multiplier applied to the gap after each attempt. Default 1.5. */
    backoffFactor?: number;
    /** Ceiling for the growing gap. Default 4000ms. */
    maxIntervalMs?: number;
    /** The tier RevenueCat reports as bought, when known. See `purchaseConfirmed`. */
    purchasedTier?: string | null;
}

export interface BillingRefreshResult {
    /** The freshest snapshot read, or null if every attempt failed. */
    billing: UserBillingInfo | null;
    /**
     * True only when the server's snapshot passes `purchaseConfirmed` (a tier
     * different from `previousTier`, or a paid Starter) — i.e. the webhook landed and this snapshot is the result
     * of the purchase.
     *
     * False means "we gave up still seeing the old tier". Callers must NOT
     * commit the snapshot to their plan display on false: it is stale by
     * definition, and committing it is precisely the bug where a successful
     * purchase kept showing the previous plan until the user happened to leave
     * the tab and come back.
     */
    confirmed: boolean;
}

/**
 * Is `billing` the result of the purchase? The tier string alone cannot say: every account reads `'starter'`
 * on the free grant, which has no store entitlement and so no `entitlementExpiresAt`. A bought plan always
 * carries one (the webhook writes it from the store entitlement).
 *
 * `purchasedTier` is the tier RevenueCat reports as active right after the purchase. With it, the server must
 * agree on that exact tier. Without it, a `'starter'` reading must be a paid one, and any other tier must
 * differ from the starting tier.
 */
function purchaseConfirmed(billing: UserBillingInfo, before: string, purchasedTier?: string | null): boolean {
    const tier = normalizeTier(billing.subscriptionTier);
    const paid = billing.entitlementExpiresAt != null;
    if (purchasedTier) return tier === purchasedTier && (tier !== 'starter' || paid);
    // ponytail: with no RevenueCat tier this can confirm early for someone who already pays for Starter and is
    // upgrading (their old paid Starter reads as confirmed). It only happens when RevenueCat returned nothing.
    if (tier === 'starter') return paid;
    return tier !== before && tier !== 'none';
}

/**
 * Re-fetch billing after a completed purchase or restore, retrying with backoff
 * until the server confirms the purchase (see `purchaseConfirmed`) or the attempt budget
 * runs out.
 *
 * `confirmed: false` is genuinely ambiguous and callers must treat it as
 * "unresolved", not "failed" — it covers both a webhook that is merely slow AND
 * an App Store *deferred* plan change (an upgrade scheduled for the next
 * renewal), where the tier is deliberately unchanged for the rest of the
 * period and will never differ. Nothing client-side can tell those apart, which
 * is why the right response is a bounded "activating…" state that eventually
 * settles rather than a spinner that waits forever.
 */
export async function refreshUserBillingAfterPurchase(
    previousTier: string | null | undefined,
    options: RefreshBillingOptions = {},
): Promise<BillingRefreshResult> {
    const attempts = options.attempts ?? PURCHASE_REFRESH_ATTEMPTS;
    const backoffFactor = options.backoffFactor ?? PURCHASE_REFRESH_BACKOFF;
    const maxIntervalMs = options.maxIntervalMs ?? PURCHASE_REFRESH_MAX_INTERVAL_MS;
    const before = normalizeTier(previousTier);

    let intervalMs = options.intervalMs ?? PURCHASE_REFRESH_INTERVAL_MS;
    let latest: UserBillingInfo | null = null;

    for (let attempt = 0; attempt < attempts; attempt++) {
        const billing = await fetchUserBilling();
        if (billing) {
            latest = billing;
            if (purchaseConfirmed(billing, before, options.purchasedTier)) {
                return { billing, confirmed: true };
            }
        }
        if (attempt < attempts - 1) {
            await delay(intervalMs);
            intervalMs = Math.min(intervalMs * backoffFactor, maxIntervalMs);
        }
    }
    return { billing: latest, confirmed: false };
}
