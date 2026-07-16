// cycle-state-machine — the single `recoverCycle()` entry point the app-resume
// task calls before starting new work, so a half-finished scoring run from a
// prior process is driven to completion before the next sync begins.
//
// Since the pipelined-batch rewrite, the heavy lifting lives entirely in
// lib/services/scoring-pipeline.ts. `recover()` self-abandons runs older than
// 24h, reverts stuck submitters, starts the AppState-gated foreground poller,
// and drains queued batches. This wrapper is retained only so the existing
// `inference-recover` app-foreground task keeps a stable import; it no longer
// touches the retired 7-state `inferenceCycleState`.
//
// The call order AppLayout's effect implements is unchanged: recoverCycle() →
// if idle, syncFeed().

import logger from '@/lib/logger';
import * as scoringPipeline from './scoring-pipeline';

/**
 * Drive any in-flight scoring run to completion (or resume it) before the
 * caller starts new work. Idempotent — safe to call from rapid AppState→active
 * fires; the pipeline's single-flight guards collapse re-entries.
 *
 * Returns `'idle'` when the pipeline has no non-terminal batches (the caller is
 * free to start a fresh sync) and `'running'` when a run is still in flight.
 */
export async function recoverCycle(): Promise<'idle' | 'running'> {
  try {
    return await scoringPipeline.recover();
  } catch (err) {
    logger.captureException(err, {
      tags: { service: 'cycle-state-machine', method: 'recoverCycle' },
    });
    // Treat an unexpected recovery failure as `idle` so the caller is not
    // permanently blocked from starting a new sync; the pipeline record (if
    // any) survives and the next tick retries.
    return 'idle';
  }
}
