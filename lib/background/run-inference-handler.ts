// Shared `runBackgroundCycle()` — entry point for the pipelined cloud-scoring
// triggers. It is a thin router over the scoring-pipeline orchestrator; the
// single-slot submit/reconcile flow it used to drive has been retired in favour
// of many small in-flight batches managed by lib/services/scoring-pipeline.ts.
//
// Three trigger families:
//
//   1. Background silent-push wakes (`inference-done` / `phase1-done` /
//      `phase2-done` from the inference gateway, carrying the completed job's
//      `requestId`) — advance the batch the push names (or a general poll tick)
//      via `handlePush`. Runs in the background execution context.
//   2. `scoring-pass` (foreground, from FeedSyncMachine.stepScore /
//      runScoringPass) — enqueue all unscored eligible candidates plus any
//      orphaned-reason rows into the pipeline, then kick a poll tick. The
//      pipeline's own foreground poller then drives the batches to completion.
//   3. `app-resume` — drive any in-flight pipeline forward via `recover()`
//      (self-abandons runs older than 24h, reverts stuck submits, drains).
//
// On-device Mera Protocol uses its own foreground scoring loop via
// SuggestionSyncService.syncFeed() and does not funnel through this handler.

import logger from '@/lib/logger';
import { isTransientNetworkError } from '@/lib/utils/transient-error';
import { getUnscoredSuggestionsWithFacts } from '@/lib/database/services/article-suggestion-service';
import { buildRelevanceCalls } from '@/lib/mera-protocol/scoring-service';
import { contextForCycleReason } from '@/lib/llm/execution-context';

export type CycleReason =
  // Inference gateway completion pushes. The gateway now emits a single
  // `inference-done` per completed job (mapped to `silent-push`); the legacy
  // two-phase `phase1-done` / `phase2-done` markers are kept for wire-compat.
  | 'phase1-done'
  | 'phase2-done'
  | 'silent-push'
  // FeedSyncMachine.stepScore's foreground scoring pass. Enqueues fresh work
  // into the pipeline. Does NOT re-enter syncFeed.
  | 'scoring-pass'
  // AppState→active catch-up — recover/advance any in-flight pipeline.
  | 'app-resume';

/**
 * Outcome of a cycle. Collapsed to the pipeline's two observable states plus a
 * hard-failure marker:
 *   - `running`: the pipeline has non-terminal batches (work queued/in flight).
 *   - `idle`: nothing to do — the pipeline is empty or fully terminal.
 *   - `error`: the router threw (network / keychain / unexpected).
 */
export type RunHandlerResult = 'running' | 'idle' | 'error';

export async function runBackgroundCycle(
  reason: CycleReason,
  requestId?: string,
): Promise<RunHandlerResult> {
  // Auth context derives from the trigger reason — silent-push wakes are
  // background (capability-token only); everything else is foreground.
  const context = contextForCycleReason(reason);

  // Lazy require (NOT a static import) breaks the load-time cycle
  // scoring-pipeline → SuggestionSyncService → run-inference-handler →
  // scoring-pipeline. Same pattern as lib/database/hydrate-stores.ts.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const pipeline = require('@/lib/services/scoring-pipeline') as typeof import('@/lib/services/scoring-pipeline');

  try {
    // Background completion pushes: advance the named batch (or a general tick).
    if (
      reason === 'phase1-done' ||
      reason === 'phase2-done' ||
      reason === 'silent-push'
    ) {
      await pipeline.handlePush(requestId, context);
      return await pipeline.getPipelineStatus();
    }

    // App-resume catch-up: drive any in-flight pipeline to completion.
    if (reason === 'app-resume') {
      return await pipeline.recover();
    }

    // scoring-pass: enqueue all unscored eligible candidates + orphaned reasons,
    // then poll. The pipeline dedups ids already covered by a non-terminal
    // batch, so re-firing this every ~10s during a sync is safe.
    const candidates = await getUnscoredSuggestionsWithFacts();
    const bundle = await buildRelevanceCalls(candidates);
    const eligibleIds = bundle.eligibleCandidates.map((c) => c.id);
    if (eligibleIds.length > 0) {
      await pipeline.enqueueCandidates(eligibleIds);
    }
    await pipeline.enqueueOrphanedReasons();
    await pipeline.pollTick(context);
    return await pipeline.getPipelineStatus();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Keychain items written with WhenUnlocked are unreadable from a
    // background task while the device is locked. Tag distinctly so Sentry
    // can surface it; the pipeline state is preserved so the next foreground
    // retry succeeds.
    const isKeychain = /keychain|secitem|errsec|accessible/i.test(msg);
    // Both keychain-unavailable (background + device locked) and transient
    // network/abort failures are recoverable — the caller lets the sync
    // complete and the next foreground trigger retries. Report them as
    // `warning`, not `error`. Anything else stays `error`.
    const recoverable = isKeychain || isTransientNetworkError(err);
    logger.captureException(err, {
      level: recoverable ? 'warning' : 'error',
      tags: {
        service: 'run-background-cycle',
        reason,
        kind: isKeychain
          ? 'keychain-unavailable'
          : isTransientNetworkError(err)
            ? 'transient-network'
            : 'generic',
      },
    });
    return 'error';
  }
}
