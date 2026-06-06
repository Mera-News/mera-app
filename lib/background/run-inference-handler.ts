// Shared `runBackgroundCycle()` — entry point for cloud-inference reconcile
// and submit triggers. Two trigger families:
//
//   1. Background silent-push wakes (phase-done from the inference gateway) —
//      reconcile-only. Never submits new work; iOS throttling makes silent
//      pushes unreliable for kicking off fresh cycles.
//   2. Foreground triggers (app-resume, pull-to-refresh, scoring-pass) —
//      reconcile a pending job if any, else submit.
//
// On-device Mera Protocol uses its own foreground scoring loop via
// SuggestionSyncService.syncFeed() and does not funnel through this handler.

import logger from '@/lib/logger';
import { getPendingAsyncJob } from '@/lib/database/services/async-job-service';
import { submitInferenceJob } from '@/lib/llm/submitInferenceJob';
import {
  reconcileAsyncJobResults,
  submitOrphanedReasonJob,
} from '@/lib/services/async-job-reconciler';
import { contextForCycleReason } from '@/lib/llm/execution-context';

export type CycleReason =
  // Inference gateway callbacks for the two-phase flow.
  | 'phase1-done'
  | 'phase2-done'
  // Generic silent push (legacy `inference-done` / `process-clusters`) —
  // reconcile if pending, else no-op (we no longer auto-submit from background).
  | 'silent-push'
  // Inner primitive used by syncFeed's scoring pass: submit-or-reconcile only,
  // does NOT re-enter syncFeed. Foreground-only.
  | 'scoring-pass'
  // AppState→active catch-up — reconcile-only here. The fresh syncFeed call
  // runs from the AppLayout effect alongside this trigger.
  | 'app-resume';

export type RunHandlerResult =
  | 'reconciled-new-data'
  | 'reconciled-pending'
  | 'reconciled-stale'
  | 'submitted'
  | 'no-work'
  | 'skipped-no-token'
  | 'skipped-pending'
  | 'error';

export async function runBackgroundCycle(
  reason: CycleReason,
): Promise<RunHandlerResult> {
  // Auth context derives from the trigger reason — silent-push wakes are
  // background (capability-token only); everything else is foreground (JWT
  // with capability-token fallback if keychain is transiently down).
  const context = contextForCycleReason(reason);
  try {
    const pending = await getPendingAsyncJob();

    // Phase callbacks: always reconcile the pending job (phase is stored on
    // the pending row so the reconciler dispatches to the right phase).
    if (reason === 'phase1-done' || reason === 'phase2-done') {
      if (!pending) {
        return 'no-work';
      }
      return mapReconcile(
        await reconcileAsyncJobResults(context, pending.requestId),
      );
    }

    // AppState→active and silent-push wakes: reconcile-only. The fresh
    // syncFeed for app-resume runs from the AppLayout effect; silent-push
    // wakes never submit new work (background path is unpacking-only).
    if (reason === 'app-resume' || reason === 'silent-push') {
      if (!pending) return 'no-work';
      return mapReconcile(
        await reconcileAsyncJobResults(context, pending.requestId),
      );
    }

    // scoring-pass: pure submit-or-reconcile primitive, used by syncFeed's
    // internal scoring pass. Does NOT re-enter syncFeed (cycle guard).
    if (pending) {
      return mapReconcile(
        await reconcileAsyncJobResults(context, pending.requestId),
      );
    }
    const submitResult = await submitInferenceJob();
    // No new unscored candidates — check for orphaned scored-without-reason rows
    // (relevance set but reason generation lost due to crash/expiry).
    if (submitResult === 'skipped-empty') {
      return mapSubmit(await submitOrphanedReasonJob(context));
    }
    return mapSubmit(submitResult);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Keychain items written with WhenUnlocked are unreadable from a
    // background task while the device is locked. Tag distinctly so Sentry
    // can surface it; the pending lock is preserved so the next foreground
    // retry succeeds.
    const isKeychain = /keychain|secitem|errsec|accessible/i.test(msg);
    logger.captureException(err, {
      tags: {
        service: 'run-background-cycle',
        reason,
        kind: isKeychain ? 'keychain-unavailable' : 'generic',
      },
    });
    return 'error';
  }
}

function mapReconcile(
  status: 'completed' | 'pending' | 'stale' | 'error',
): RunHandlerResult {
  if (status === 'completed') return 'reconciled-new-data';
  if (status === 'pending') return 'reconciled-pending';
  if (status === 'stale') return 'reconciled-stale';
  return 'error';
}

function mapSubmit(
  status:
    | 'submitted'
    | 'skipped-pending'
    | 'skipped-empty'
    | 'skipped-no-token'
    | 'skipped-stale-pending'
    | 'error',
): RunHandlerResult {
  switch (status) {
    case 'submitted':
      return 'submitted';
    case 'skipped-empty':
      return 'no-work';
    case 'skipped-no-token':
      return 'skipped-no-token';
    case 'skipped-pending':
    case 'skipped-stale-pending':
      return 'skipped-pending';
    case 'error':
    default:
      return 'error';
  }
}
