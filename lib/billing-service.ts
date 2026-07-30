import { gql } from '@apollo/client';
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

interface UserBillingResponse {
    userBilling: UserBillingInfo;
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
// once RevenueCat's webhook has been delivered and processed — a second or two
// later. Fetching once the moment the paywall closes therefore usually reads
// the *pre*-purchase tier, which is the "the phone UI takes a while to update"
// complaint. These bound a short retry: five tries, two seconds apart, then it
// stops. Never an open-ended poll.
const PURCHASE_REFRESH_ATTEMPTS = 5;
const PURCHASE_REFRESH_INTERVAL_MS = 2000;

/** `null`, `undefined` and the server's `'none'` all mean "no paid tier". */
function normalizeTier(tier: string | null | undefined): string {
    return tier == null || tier === 'none' ? 'none' : tier;
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export interface RefreshBillingOptions {
    /** Total fetches, including the first. Default 5. */
    attempts?: number;
    /** Gap between fetches. Default 2000ms. */
    intervalMs?: number;
}

/**
 * Re-fetch billing after a completed purchase or restore, retrying until the
 * server-side tier differs from `previousTier` or the attempt budget runs out.
 * Returns the freshest snapshot it managed to read (null if every attempt
 * failed).
 *
 * Exhausting the budget is a normal outcome, not an error: an App Store
 * *deferred* plan change (upgrade scheduled for the next renewal) leaves the
 * tier deliberately unchanged for the rest of the period, so this simply
 * returns the current — correct — snapshot.
 */
export async function refreshUserBillingAfterPurchase(
    previousTier: string | null | undefined,
    options: RefreshBillingOptions = {},
): Promise<UserBillingInfo | null> {
    const attempts = options.attempts ?? PURCHASE_REFRESH_ATTEMPTS;
    const intervalMs = options.intervalMs ?? PURCHASE_REFRESH_INTERVAL_MS;
    const before = normalizeTier(previousTier);

    let latest: UserBillingInfo | null = null;
    for (let attempt = 0; attempt < attempts; attempt++) {
        const billing = await fetchUserBilling();
        if (billing) {
            latest = billing;
            if (normalizeTier(billing.subscriptionTier) !== before) return billing;
        }
        if (attempt < attempts - 1) await delay(intervalMs);
    }
    return latest;
}
