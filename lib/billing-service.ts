import { gql } from '@apollo/client';
import { COMPANION_MODE_ENABLED } from './config/feature-gates';
import client from './apollo-client';
import { UserBillingInfo } from './generated/graphql-types';
import logger from './logger';

const GET_USER_BILLING = gql`
  query GetUserBilling {
    userBilling {
      subscriptionTier
      dailyArticleLimit
      articlesUsedToday
      entitlementExpiresAt
      resetAt
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
const GET_USER_BILLING_LAPSE_STATE = gql`
  query GetUserBillingLapseState {
    userBilling {
      subscriptionTier
      hasEverSubscribed
      showLapseInterstitial
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
    // Not merely tolerated — not SENT at all while companion mode is inert.
    // Verified against prod: the request does fail safely, but the global
    // apollo error-link logs every GraphQL error before this function's catch
    // can see it, so an un-gated call would put a red toast on screen in dev
    // and a Sentry event in prod on every foreground, login and Profile focus.
    // Nothing reads these fields while the ship gate is false anyway.
    if (!COMPANION_MODE_ENABLED) return null;

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

// Self-scoped: no userId argument, the server resolves the caller from the
// session. It stamps `lapseInterstitialShownAt`, which is what makes the
// "shown once" latch survive a reinstall and re-arm on a LATER lapse — a local
// boolean could do neither.
const ACKNOWLEDGE_LAPSE_INTERSTITIAL = gql`
  mutation AcknowledgeLapseInterstitial {
    acknowledgeLapseInterstitial {
      subscriptionTier
      hasEverSubscribed
      showLapseInterstitial
    }
  }
`;

interface UserBillingResponse {
    userBilling: UserBillingInfo;
}

interface AcknowledgeLapseResponse {
    acknowledgeLapseInterstitial: UserBillingInfo;
}

/**
 * Tell the server the lapse interstitial has been shown. Returns the updated
 * snapshot, or null on any error — a failed ack is not worth surfacing: the
 * worst case is the interstitial appearing once more on a later launch.
 */
export async function acknowledgeLapseInterstitial(): Promise<UserBillingInfo | null> {
    try {
        const { data } = await client.mutate<AcknowledgeLapseResponse>({
            mutation: ACKNOWLEDGE_LAPSE_INTERSTITIAL,
        });
        return data?.acknowledgeLapseInterstitial ?? null;
    } catch (error) {
        logger.captureException(error, {
            tags: { component: 'billing-service', method: 'acknowledgeLapseInterstitial' },
        });
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
        return data?.userBilling ?? null;
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
}

export interface BillingRefreshResult {
    /** The freshest snapshot read, or null if every attempt failed. */
    billing: UserBillingInfo | null;
    /**
     * True only when the server actually reported a tier DIFFERENT from
     * `previousTier` — i.e. the webhook landed and this snapshot is the result
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
 * Re-fetch billing after a completed purchase or restore, retrying with backoff
 * until the server-side tier differs from `previousTier` or the attempt budget
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
            if (normalizeTier(billing.subscriptionTier) !== before) {
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
