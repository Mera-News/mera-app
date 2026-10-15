// A plan that rose mid-session applies at once.
//
// The gateway meters each user against the multiplier their JWT carries, and
// the stored limit only ever rises within a day. So when a billing read shows
// a higher tier than the last one this process saw, the cached JWT (minted for
// the old tier) is dropped and the read hold ends: the next submit carries the
// new tier and is measured against the larger allowance.
//
// This hangs off EVERY successful billing read (`fetchUserBilling`), not only
// entitlement-sync: the Settings plan card and the post-purchase refresh read
// billing directly, and whichever read sees the new tier first is the moment.
// The first read of a process only records the tier: a cold start mints a
// fresh JWT anyway.

import { setReadHold } from './read-hold';

const MULTIPLIER: Readonly<Record<string, number>> = {
  starter: 1,
  individual: 5,
  professional: 20,
};

/** 1 for Starter, none and anything unknown. */
export function tierMultiplier(tier: string | null | undefined): number {
  return (tier && MULTIPLIER[tier]) || 1;
}

let lastSeen: number | null = null;
let raisedAt: number | null = null;

/** Called with every successful billing read's tier. Never throws. */
export function noteBillingTier(tier: string | null | undefined): void {
  const now = tierMultiplier(tier);
  const rose = lastSeen !== null && now > lastSeen;
  lastSeen = now;
  if (!rose) return;
  raisedAt = Date.now();
  try {
    // Lazy: auth-client pulls the whole Better Auth client into any importer.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { invalidateJwtCache } = require('@/lib/auth-client') as typeof import('@/lib/auth-client');
    invalidateJwtCache();
  } catch {
    // The 30s JWT cache expires on its own.
  }
  void setReadHold({ resetAt: null });
}

/** When the plan last rose in this process ("Your new plan applies now."). */
export function getPlanRaisedAt(): number | null {
  return raisedAt;
}

/** Test hook. */
export function resetPlanRiseForTests(): void {
  lastSeen = null;
  raisedAt = null;
}
