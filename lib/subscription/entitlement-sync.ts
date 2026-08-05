// Pulls the server's `userBilling` snapshot into the subscription store.
//
// The server is the source of truth for tier; RevenueCat is only an optimistic
// mirror. Everything that could plausibly have changed a user's entitlement
// calls this: app foreground, login, a completed purchase, and a 402 from a
// guarded query.

import { fetchUserBilling, fetchUserBillingLapseState } from '@/lib/billing-service';
import { useSubscriptionStore } from '@/lib/stores/subscription-store';

/**
 * Foreground fires on every app-switch, and several surfaces may ask at once.
 * One fetch a minute is plenty for a value that only changes on a purchase or a
 * webhook — `force` exists for the moments where the value is expected to have
 * just changed and waiting out the window would show the user stale state.
 */
const MIN_INTERVAL_MS = 60_000;

// Unset, NOT `Date.now()`. Seeding this at module load would make the very
// first call — the foreground task firing at cold start — debounce itself out,
// leaving `aiAccess` at 'unknown' for the first minute of every launch.
let lastSyncAt: number | null = null;
let inFlight: Promise<void> | null = null;

export interface SyncEntitlementOptions {
    /** Bypass the 60s debounce. Use after login, purchase, or a 402. */
    force?: boolean;
}

/**
 * Fetch billing and push it into the store. Never throws and never rejects —
 * `fetchUserBilling` already swallows and reports its own errors, and every
 * caller fires this without awaiting.
 */
export async function syncEntitlement(
    opts: SyncEntitlementOptions = {},
): Promise<void> {
    if (!opts.force) {
        if (inFlight) return inFlight;
        if (lastSyncAt !== null && Date.now() - lastSyncAt < MIN_INTERVAL_MS) return;
    }

    const run = (async () => {
        try {
            // Two queries, on purpose — see fetchUserBillingLapseState. The
            // second is allowed to fail on a server that predates the lapse
            // fields without taking the tier down with it.
            const [billing, lapseState] = await Promise.all([
                fetchUserBilling(),
                fetchUserBillingLapseState(),
            ]);
            if (billing) {
                useSubscriptionStore.getState().setServerBilling(billing);
                // Only a successful read counts towards the debounce. A failed
                // fetch that started the clock would leave a device that was
                // briefly offline stuck on stale entitlement for a full minute
                // after connectivity returned.
                lastSyncAt = Date.now();
            }
            // Null when the server has no such fields yet, which leaves
            // hasEverSubscribed/showLapseInterstitial at their `null`
            // "unknown" — every consumer already treats that as "do nothing".
            if (lapseState) {
                useSubscriptionStore.getState().setServerBilling(lapseState);
            }
        } finally {
            inFlight = null;
        }
    })();

    inFlight = run;
    return run;
}

/** Test/logout hook: forget the debounce window. */
export function resetEntitlementSyncState(): void {
    lastSyncAt = null;
    inFlight = null;
}
