// cycle-state-machine — thin wrapper that drives the inferenceCycleState
// based on actions taken by the existing reconciler / submitter, and runs
// crash-recovery on every app open before any new work is started.
//
// Why a wrapper rather than a full FSM rewrite: the heavy lifting (placeholder
// CAS, idempotent unpack writes, gateway TTL of 24h, phase-2 chain) already
// lives in async-job-reconciler.ts and submitInferenceJob.ts. The state-
// machine layer just gives us:
//   1. A single persisted `inferenceCycleState` value the UI can render off.
//   2. A single `recoverCycle()` entry point the app-resume effect calls
//      before kicking off a new sync, so a half-finished cycle from a prior
//      run is always driven to completion before we start the next one.
//
// The user's example — "reason generation phase failed, on next app open
// finish the previous cycle before fetching new suggestions" — is the call
// order that AppLayout's effect already implements: recoverCycle() → if
// idle, syncFeed().

import logger from '@/lib/logger';
import {
  getCycleState,
  getPendingAsyncJob,
  setCycleState,
  type InferenceCycleState,
} from '@/lib/database/services/async-job-service';
import { useForYouStore } from '@/lib/stores/for-you-store';
import { reconcileAsyncJobResults } from './async-job-reconciler';

const TAG = '[cycle-state-machine]';

/**
 * Drive any in-flight cycle to a terminal state (idle) before the caller
 * starts new work. Idempotent — safe to call from rapid AppState→active
 * fires; the reconciler's in-process single-flight collapses re-entries.
 *
 * Returns the cycle state observed AFTER recovery — `idle` means the caller
 * is free to start a new cycle, anything else means the cycle is still in
 * flight (waiting on the gateway) and we should not stack work on top of it.
 */
export async function recoverCycle(): Promise<InferenceCycleState> {
  const state = await getCycleState();
  const pending = await getPendingAsyncJob();

  if (state === 'idle' && !pending) {
    return 'idle';
  }

  // Orphaned state: the cycle was interrupted (app kill, DB reset, migration)
  // and the pending job was cleared, but the cycle state key wasn't reset.
  // The reconciler returns 'completed' early when pending is null without
  // touching cycleState, so without this guard recoverCycle would re-read the
  // stale state and block new scoring runs indefinitely.
  if (!pending) {
    logger.warn(`${TAG} orphaned cycle state=${state} with no pending job — resetting to idle`);
    await setCycleState('idle');
    useForYouStore.getState().setAsyncJobPhase('idle');
    return 'idle';
  }

  // For every non-idle observed state the right answer is the same: ask the
  // reconciler to advance. It already knows how to:
  //   - detect a placeholder requestId (submit crash window) and resubmit,
  //   - poll /results when state is `waiting-for-*` (returns 'pending' if
  //     gateway hasn't completed yet — that's fine, push wake will retry),
  //   - re-run the unpack + write path for crash-window unpack states
  //     (saveScoringResult / saveReason are upserts; idempotencyKey gate
  //     stops the local notif from double-firing).
  // The reconciler updates cycleState as it transitions, so on return we
  // re-read it to decide what to tell the caller.
  try {
    // recoverCycle is only ever called from the foreground app-resume hook.
    await reconcileAsyncJobResults('foreground');
  } catch (err) {
    logger.captureException(err, {
      tags: { service: 'cycle-state-machine', method: 'recoverCycle' },
    });
  }

  const next = await getCycleState();
  if (next !== state) {
    logger.info(`${TAG} state ${state} → ${next}`);
  }
  return next;
}
