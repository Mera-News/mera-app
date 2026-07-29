// Persona-mutation sweep policy — the ONE place that answers "does this
// persona mutation need a retroactive feed sweep, and which one?" (D12), plus
// the D18 feed-dirty rule that rides along with the answer.
//
// WHY THIS MODULE EXISTS (the friction, named): the decision used to live
// inline in persona-action-executor.dispatch. `revertChange` is a SECOND
// mutation path that commits persona changes without going through that seam,
// so it silently ran no sweeps at all — block "cricket", watch the feed purge,
// then undo the filter from the Activity screen and the purged articles were
// gone forever, inside the very 48h window D12c exists to protect. Two call
// sites, one decision, no shared owner: that is the drift that produced the bug.
//
// THE TRICK that keeps them from drifting again: a revert needs the MIRROR of
// whatever the forward mutation needed. Undoing something that purged must
// un-exclude; undoing something that un-excluded must purge. So there is
// exactly ONE predicate (`sweepForMutation`) and the revert path calls
// `sweepForRevert`, which is that predicate composed with an inversion. A new
// action type can never be wired into one path and forgotten in the other.

import logger from '../../logger';

/** Which direction of the retroactive screen a mutation needs. */
export type SweepKind = 'purge' | 'unexclude';

/**
 * Everything the policy needs to know about a mutation, in FORWARD terms
 * (i.e. as the mutation was originally applied — the revert path passes the
 * same values and lets `sweepForRevert` do the mirroring).
 */
export interface SweepDecisionInput {
  actionType: string;
  /**
   * add_suppression / retire_suppression: was the row a HARD filter
   * (strength ≥ HARD_SUPPRESSION_STRENGTH)? Soft suppressions are a score
   * penalty — they never exclude anything, so they never need a sweep.
   */
  hardFilter?: boolean;
  /** set_publication_pref: the pref kind BEFORE the mutation ('none' | kind). */
  prefBefore?: string;
  /** set_publication_pref: the pref kind AFTER the mutation. */
  prefAfter?: string;
}

/** A publication pref at/below -0.9 is a mute, which IS a hard filter. */
const MUTE = 'mute';

/**
 * Which sweep does this FORWARD mutation need? `null` ⇒ none.
 *
 * Deliberately pure and total: unknown action types return `null` rather than
 * throwing, because a missing sweep must never fail a committed mutation.
 */
export function sweepForMutation(input: SweepDecisionInput): SweepKind | null {
  switch (input.actionType) {
    // Adding a hard filter must remove what is ALREADY stored and on screen.
    case 'add_suppression':
      return input.hardFilter ? 'purge' : null;

    // Removing a hard filter must give its casualties a second chance.
    case 'retire_suppression':
      return input.hardFilter ? 'unexclude' : null;

    // A mute is a synthesized hard `kind:'publication'` filter. Landing on mute
    // purges; leaving mute releases. Mute→mute and non-mute→non-mute are no-ops.
    case 'set_publication_pref': {
      const toMute = input.prefAfter === MUTE;
      const fromMute = input.prefBefore === MUTE;
      if (toMute && !fromMute) return 'purge';
      if (fromMute && !toMute) return 'unexclude';
      return null;
    }

    default:
      return null;
  }
}

/** purge ↔ unexclude. The whole reason the two paths cannot drift. */
function invert(sweep: SweepKind | null): SweepKind | null {
  if (sweep === 'purge') return 'unexclude';
  if (sweep === 'unexclude') return 'purge';
  return null;
}

/**
 * Which sweep does UNDOING this mutation need? Takes the mutation described in
 * FORWARD terms (exactly what the change-log row recorded) and returns the
 * mirror of what the forward mutation needed.
 *
 * Worked example: `set_publication_pref` before='none' after='mute' purged on
 * the way in; reverting restores 'none', so the mute is gone and the rows it
 * excluded must be released → 'unexclude'. Same answer as inverting.
 */
export function sweepForRevert(input: SweepDecisionInput): SweepKind | null {
  return invert(sweepForMutation(input));
}

/**
 * D12. Execute a sweep AFTER the mutation is committed (both sweeps read the
 * persona live, so an uncommitted change is invisible to them).
 *
 * A sweep failure must NEVER fail the action: by the time we get here the
 * mutation is written and audited, so reporting failure would be a lie and
 * would strand a change-log row the caller believes never happened. Catch, log,
 * continue — the next scoring pass applies the filter anyway.
 *
 * Lazy `require`, mirroring the scoring pipeline's own refreshUi. There is no
 * load-time cycle (verified); the reason is module-graph weight — a static
 * import would drag stage-scoring → llm/cloudComplete → the native DB singleton
 * into every consumer of the executor and the change-log service.
 */
async function runSweep(kind: SweepKind, actionType: string): Promise<boolean> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const sweep = require('@/lib/services/suppression-sweep') as typeof import('@/lib/services/suppression-sweep');
    if (kind === 'purge') await sweep.purgeHardFilteredSuggestions();
    else await sweep.unexcludeRetiredHardFilters();
    return true;
  } catch (error) {
    logger.captureException(error, {
      tags: { service: 'persona-mutation-sweeps', sweep: kind, action_type: actionType },
    });
    return false;
  }
}

/**
 * D18. A persona change means the feed is stale. Never throws: a missing store
 * must not turn a committed mutation into a failure.
 */
export function markFeedNeedsRefresh(): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const store = require('@/lib/stores/for-you-store') as typeof import('@/lib/stores/for-you-store');
    store.useForYouStore.getState().setFeedNeedsRefresh(true);
  } catch (error) {
    logger.captureException(error, {
      tags: { service: 'persona-mutation-sweeps', step: 'mark-feed-dirty' },
    });
  }
}

/**
 * Run the sweep a committed mutation needs.
 *
 * Returns `true` iff a PURGE ran AND succeeded — meaning the feed is already
 * reconciled (the purge ends in an immediate refreshUi) and must NOT also be
 * marked dirty. Every other outcome returns `false` and the caller dirties:
 *   - no sweep needed          → the change still needs a rescore
 *   - un-exclude               → released rows come back `unscored`
 *   - a purge that FAILED      → the feed was never reconciled
 */
export async function runSweepFor(
  sweep: SweepKind | null,
  actionType: string,
): Promise<boolean> {
  if (!sweep) return false;
  const ok = await runSweep(sweep, actionType);
  return sweep === 'purge' && ok;
}
