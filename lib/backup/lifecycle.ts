// What a launch has to do when the previous restore did not finish.
//
// A restore cannot be atomic: tens of thousands of rows do not fit in one
// WatermelonDB `batch()`, so `import.ts` chunks its writes and a crash, a kill
// or a dead battery lands mid-restore. What survives is a genuine mixture —
// some tables from the blob, some from whatever was on the device — and booting
// that is worse than booting nothing, because a persona assembled from two
// sources produces a feed neither of them would have.
//
// **The recovery is data-only, and that is the whole design constraint.**
// `wipeAllLocalUserData()` is the wrong tool here: it clears the keychain
// cookie, which would sign the user out. Only the explicit logout button ever
// logs a user out (root invariant), and a failed restore is not a logout — the
// session is fine, the DATA is torn. So this clears the tables the restore was
// writing and nothing else, leaving the device signed in with an empty persona:
// a state the app already handles, because onboarding gates on local facts.
//
// **Why no identity re-stamp is needed here**, despite the plan calling for one:
// `cached_user_id` is in `FORBIDDEN_SETTING_KEYS`, so no blob can carry it, and
// `clearTables` never includes `settings`, so no restore can remove it. It is
// therefore still the live user's value throughout. That is an invariant to
// preserve, not a coincidence — adding `settings` to the cleared set would make
// identity-gate see an absent sentinel on the next launch.

import { RESTORE_REPLACED_TABLES } from './allowlist';
import { watermelonRowSink } from './adapters/watermelon-row-sink';

export { restoreWasInterrupted } from './adapters/watermelon-row-sink';

/**
 * Empties everything the interrupted restore was writing and clears the marker.
 *
 * The marker is cleared LAST. If the clear throws part way, the marker survives
 * and the next launch tries again — the same self-healing shape
 * `purgeOrphanedLocalData()` uses, where the state itself is the retry flag and
 * no separate bookkeeping can be lost.
 */
export async function resetAfterTornRestore(): Promise<void> {
  await watermelonRowSink.clearTables(RESTORE_REPLACED_TABLES);
  await watermelonRowSink.finishRestore();
}
