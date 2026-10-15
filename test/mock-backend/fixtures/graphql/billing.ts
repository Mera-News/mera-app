import type { UserBillingInfo } from '@/lib/generated/graphql-types';
import type { Scenario } from '../../scenario';

type Tier = Scenario['tier'];

const DAY_MS = 86_400_000;
const nextUtcMidnight = (now: number): string => new Date((Math.floor(now / DAY_MS) + 1) * DAY_MS).toISOString();

// Invented limits for the paid tiers; only Starter's 250 is the real product number.
const LIMIT: Record<Tier, number> = { none: 0, starter: 250, individual: 1000, professional: 2500 };
/** The plan's cloud reading as a multiple of Starter's; an unentitled account reads as Starter. */
const MULTIPLIER: Record<Tier, number> = { none: 1, starter: 1, individual: 5, professional: 20 };

/** What `userBilling` reports for a tier. Starter is the unpaid default the server
 *  grants for 14 days (`grantExpiresAt` set, nothing from the store); the paid tiers
 *  carry an `entitlementExpiresAt` and no grant; `none` is unentitled with no history. */
export function billingFor(
    tier: Tier,
    now: number,
    opts: { limitReached?: boolean; readingUsed?: number | null } = {},
): UserBillingInfo {
    const paid = tier === 'individual' || tier === 'professional';
    const limit = LIMIT[tier];
    return {
        __typename: 'UserBillingInfo',
        subscriptionTier: tier,
        dailyArticleLimit: limit,
        articlesUsedToday: opts.limitReached ? limit : 0,
        entitlementExpiresAt: paid ? new Date(now + 30 * DAY_MS).toISOString() : null,
        grantExpiresAt: tier === 'starter' ? new Date(now + 10 * DAY_MS).toISOString() : null,
        resetAt: nextUtcMidnight(now),
        hasEverSubscribed: paid,
        showLapseInterstitial: false,
        planMultiplier: MULTIPLIER[tier],
        readingUsed: opts.readingUsed === undefined ? 0 : opts.readingUsed,
        readingResetAt: nextUtcMidnight(now),
    };
}

export { nextUtcMidnight };

/** Static snapshots for `fixture()`: timestamps are anchored at the epoch-day of the
 *  moment the module loaded, so they are only for shape assertions. */
export const billingStarter: UserBillingInfo = billingFor('starter', Date.now());
export const billingNone: UserBillingInfo = billingFor('none', Date.now());
