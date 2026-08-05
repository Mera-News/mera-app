// What the app does when the server refuses a guarded AI query with a 402.
//
// The old behaviour was to yank the user to the paywall from wherever they
// were. That is wrong now: Mera News Free is a legitimate place to be, and
// everything already on the device stays usable — a hard redirect out of an
// article the user was reading would take away exactly what this wave promises
// not to take away.

import logger from '@/lib/logger';
import { useSubscriptionStore } from '@/lib/stores/subscription-store';
import { syncEntitlement } from './entitlement-sync';

/** Which guarded query hit the 402. Diagnostics only — the verdict is shared. */
export type AiLockSource = 'topics' | 'persona' | 'hydrate' | 'stories';

/**
 * Record that the AI layer is locked and go re-read the real entitlement.
 *
 * ONE shared flag, not one per source: all four guarded queries are refused by
 * the same `SubscriptionGuard` on the same `subscriptionTier`, so a 402 from
 * any of them is the same verdict about the same user. Per-source flags would
 * only let the four surfaces disagree with each other.
 *
 * The forced re-sync is what makes this self-correcting: the 402 sets the
 * pessimistic answer immediately (so the UI stops firing doomed queries), and
 * `userBilling` — which stays ungated server-side — confirms or overturns it a
 * moment later.
 */
export function recordAiLocked(source: AiLockSource): void {
    const already = useSubscriptionStore.getState().serverTier === 'none';

    useSubscriptionStore.getState().markServerLocked();

    // Breadcrumb, not an exception: a 402 on Mera News Free is the system
    // working. Only the first one per transition is worth recording — a locked
    // device can produce several before the surfaces settle.
    if (!already) {
        logger.addBreadcrumb(
            '[ai-lock] AI layer locked by a 402',
            'subscription',
            { source },
        );
    }

    void syncEntitlement({ force: true });
}
