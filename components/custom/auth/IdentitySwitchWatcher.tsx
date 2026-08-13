import { authClient } from '@/lib/auth-client';
import { getSetting } from '@/lib/database/services/setting-service';
import { isIdentitySwitchBlocked } from '@/lib/security/identity-gate';
import logger from '@/lib/logger';
import { router } from 'expo-router';
import { useEffect } from 'react';

/**
 * The catch-all for an account switch that got past every gate.
 *
 * WHAT IT IS FOR. The gates run once, at the moment a route mounts, and the
 * better-auth session atom is allowed to resolve after that. If the process
 * dies between OTP success and the gate — or a doorway is added that nobody
 * instruments — the next cold start carries user B's cookie and user A's
 * `cached_user_id`, resolves 'coherent' because the atom has not settled, routes
 * into the shell, and unmounts the gate before the truth arrives. Nothing
 * re-checks. This does, because it lives in the logged-in LAYOUT and therefore
 * outlives every screen under it.
 *
 * FOUR RULES, all of them load-bearing:
 *
 *  1. `undefined` is IGNORED, unconditionally. That is the offline path and the
 *     not-yet-resolved path, and it is by far the common case. Only a resolved,
 *     non-null string id is evidence of anything.
 *  2. The owner is read from `cached_user_id` ON DISK, not from
 *     `useUserStore.userId`. On a failed stamp the store and the disk disagree,
 *     and the disk is what every gate keys off — catching that disagreement is
 *     the entire point.
 *  3. An ABSENT `cached_user_id` is not a mismatch. It means nothing is stamped
 *     yet, which the cold-start gate already handles.
 *  4. Latched once per process. It hands off to the gate, which either fixes
 *     the state or blocks; either way a second firing could only loop.
 *
 * It renders nothing and costs nothing on the happy path: one settings read,
 * once, only when a resolved session id is present.
 */

/** Once per process. See rule 4. */
let latched = false;

/** Test-only: reset the per-process latch. */
export function __resetIdentitySwitchWatcherForTests(): void {
  latched = false;
}

export default function IdentitySwitchWatcher() {
  const { data: session } = authClient.useSession();
  const sessionUserId = session?.user?.id;

  useEffect(() => {
    // Rule 1. Not `!== undefined`: null is the same non-answer.
    if (!sessionUserId) return;
    if (latched) return;
    // The failure screen is up and the ids genuinely disagree, which is exactly
    // what this watches for. Navigating there would yank a user out of the one
    // screen that is telling them what happened.
    if (isIdentitySwitchBlocked()) return;

    let cancelled = false;

    (async () => {
      let stampedOwner: string | null = null;
      try {
        stampedOwner = await getSetting('cached_user_id');
      } catch {
        // Unreadable settings tell us nothing. Staying quiet is right: the
        // cold-start gate will meet the same failure on the next launch.
        return;
      }

      if (cancelled) return;
      if (!stampedOwner) return; // Rule 3.
      if (stampedOwner === sessionUserId) return;
      // Re-checked after the await: the blocking screen may have mounted while
      // the settings read was in flight.
      if (latched || isIdentitySwitchBlocked()) return;

      latched = true;
      logger.captureMessage(
        'Identity switch detected after the gate had already run',
        {
          level: 'error',
          tags: { source: 'identity-switch-watcher' },
        },
      );

      // Hand back to the cold-start gate rather than wiping here. It owns the
      // verdict, the wipe, the stamp and the fail-closed screen; a second
      // implementation of any of that is a second thing to get wrong. With the
      // session now resolved it sees a plain mismatch and does the right thing.
      router.replace('/logged-in');
    })();

    return () => {
      cancelled = true;
    };
  }, [sessionUserId]);

  return null;
}
