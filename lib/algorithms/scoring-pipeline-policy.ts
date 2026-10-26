// scoring-pipeline policy: the pure half of the pipeline. Slot-scheduling constants, phase
// predicates, the header / strip / reasons projections and the stale-run verdict. Nothing here reads
// module state, the store or the clock; the orchestrator (lib/services/scoring-pipeline) owns those.
import type { BatchPhase, PipelineBatch, PipelineRun } from '@/lib/database/services/scoring-pipeline-store';

/** Relevance jobs outstanding at once. A batch writing its NOTES does not hold
 *  one of these: before, it did, so batch 4's relevance waited out batch 1's
 *  notes. */
export const MAX_IN_FLIGHT = 3;
/** Any job outstanding at once (relevance + notes). Every waiting job needs
 *  polls from the one 3s limiter lane, so this bounds how thin they spread. */
export const MAX_IN_FLIGHT_TOTAL = 6;
/** LLM calls per batch by its position in the run; the last entry repeats. */
export const RAMP_CALLS: readonly number[] = [1, 2, 5, 10];

/** Article ceiling for the batch at 0-based position `rank` in its run. */
export function rampedBatchCap(rank: number, chunkSize: number, maxArticles: number): number {
  return Math.min(maxArticles, RAMP_CALLS[Math.min(rank, RAMP_CALLS.length - 1)] * chunkSize);
}
const BATCH_STALE_MS = 15 * 60_000;
/** A run whose `startedAt` is older than this is treated as wedged: the
 *  FeedSyncMachine stale-guard aborts it (force-fail + finalize) and proceeds
 *  with the sync rather than skipping every cycle forever. Derived from
 *  BATCH_STALE_MS — a healthy run's batches all clear well within one window,
 *  so there is no independent magic number to keep in sync. Was 2x this; halved
 *  because a wedged run blocks EVERY feed-sync cycle for its whole duration, and
 *  30 minutes of a dead feed is far worse than abandoning a run that might have
 *  recovered (its rows stay Unscored and re-enter the next run). */
export const STALE_RUN_GUARD_MS = BATCH_STALE_MS;
const RUN_ABANDON_MS = 24 * 3600_000;
/** A quiet run whose batch was submitted within this window still has results
 *  waiting on the gateway (job + results TTL 24h; one hour of margin), so the
 *  stale guard must collect it rather than abort it. See staleRunVerdict. */
export const COLLECT_WINDOW_MS = 23 * 3600_000;
// ---------------------------------------------------------------------------
// Phase predicates
// ---------------------------------------------------------------------------

function isTerminal(phase: BatchPhase): boolean {
  return phase === 'done' || phase === 'failed';
}

/** Batches holding an outstanding RELEVANCE job (count against MAX_IN_FLIGHT). */
function holdsRelevanceSlot(phase: BatchPhase): boolean {
  return phase === 'submitting-relevance' || phase === 'waiting-relevance';
}

/** Batches that currently hold any outstanding gateway job (count against
 *  MAX_IN_FLIGHT_TOTAL). `needs-reasons-submit` and `queued` are between/before
 *  jobs and do NOT count. */
function isInFlight(phase: BatchPhase): boolean {
  return (
    phase === 'submitting-relevance' ||
    phase === 'submitting-reasons' ||
    phase === 'waiting-relevance' ||
    phase === 'waiting-reasons'
  );
}

function isWaiting(phase: BatchPhase): boolean {
  return phase === 'waiting-relevance' || phase === 'waiting-reasons';
}

/** One key per JOB, so a batch's notes job starts with no backoff. */
export function pendingPollKey(b: Pick<PipelineBatch, 'batchId' | 'requestId'>): string {
  return `${b.batchId}:${b.requestId ?? ''}`;
}

export function nonTerminalCandidateIds(run: PipelineRun): Set<string> {
  const s = new Set<string>();
  for (const b of run.batches) {
    if (isTerminal(b.phase)) continue;
    for (const id of b.candidateIds) s.add(id);
  }
  return s;
}

/**
 * Every article a live batch answers for: its candidates plus the siblings it
 * stands in for (`coveredIds`, written at enqueue). The GATE excludes these, so a
 * sibling held back behind an in-flight representative is not elected and scored
 * again before the representative's score lands. Post-results propagation keeps
 * {@link nonTerminalCandidateIds}: its own batch is still live then, and this set
 * would hide exactly the siblings it exists to fill. A batch that fails or is
 * abandoned goes terminal and releases its siblings to the next gate.
 */
export function nonTerminalCoveredIds(run: PipelineRun): Set<string> {
  const s = nonTerminalCandidateIds(run);
  for (const b of run.batches) {
    if (isTerminal(b.phase)) continue;
    for (const id of b.coveredIds ?? []) s.add(id);
  }
  return s;
}

// ---------------------------------------------------------------------------
// For-You header progress — collapse the per-batch pipeline into the existing
// two-phase ('relevance' | 'reasons') header model the store already renders.
// ---------------------------------------------------------------------------

export interface PipelineUiState {
  /** 'relevance' while any batch still owes a relevance round; 'reasons' once
   *  every remaining non-terminal batch is past relevance; 'idle' when the run
   *  is gone or every batch is terminal. */
  phase: 'idle' | 'relevance' | 'reasons';
  /** Candidates in terminal (done/failed) batches — the progress numerator. */
  processedCount: number;
  /** Total candidates across every batch — the progress denominator. */
  totalCount: number;
}

/**
 * Pure projection of a run onto the header's phase + progress.
 *
 * `processed` counts a batch's candidates as soon as relevance is *known* for
 * them, not only once the batch is fully terminal — reasonsOnly batches count
 * immediately (they only ever exist post-relevance), and any other batch
 * counts once its phase is out of the pre-relevance set ({'queued',
 * 'submitting-relevance', 'waiting-relevance'}); that includes
 * 'needs-reasons-submit', 'submitting-reasons', 'waiting-reasons', and every
 * terminal phase (including 'failed', so a stuck/failed batch can't stall the
 * numerator below the total). Without this, the header stayed at 0/N for the
 * whole relevance round because only fully-terminal (relevance AND reasons
 * done) batches counted.
 */
export function derivePipelineUiState(run: PipelineRun): PipelineUiState {
  let total = 0;
  let processed = 0;
  let anyNonTerminal = false;
  let relevancePending = false;
  for (const b of run.batches) {
    const n = b.candidateIds.length;
    total += n;
    if (isRelevanceKnown(b)) processed += n;
    if (isTerminal(b.phase)) continue;
    anyNonTerminal = true;
    // A non-reasonsOnly batch that hasn't reached needs-reasons-submit still
    // owes a relevance round — keep the header on 'relevance' until they clear.
    if (
      !b.reasonsOnly &&
      (b.phase === 'queued' ||
        b.phase === 'submitting-relevance' ||
        b.phase === 'waiting-relevance')
    ) {
      relevancePending = true;
    }
  }
  if (!anyNonTerminal) {
    return { phase: 'idle', processedCount: 0, totalCount: 0 };
  }
  return {
    phase: relevancePending ? 'relevance' : 'reasons',
    processedCount: processed,
    totalCount: total,
  };
}

// ---------------------------------------------------------------------------
// Batch progress projection (Round-4 B) — the honest "Analysing X of Y
// articles" line in the shimmer + the status accordion read this.
// ---------------------------------------------------------------------------

/** How much of the current run has finished, in ARTICLE counts. `done` counts
 *  the articles whose relevance is known (relevance-known batches: past the
 *  pre-relevance phases; reasonsOnly + terminal batches count too — same
 *  numerator rule as {@link derivePipelineUiState}); `total` counts every article
 *  the run covers. `null` when no run is active. */
export interface PipelineBatchProgress {
  done: number;
  total: number;
}

/** True when a batch's articles have a relevance verdict — see the numerator
 *  rationale on {@link derivePipelineUiState}. Shared so the two projections
 *  can never drift on what "processed" means. */
function isRelevanceKnown(b: PipelineBatch): boolean {
  return (
    b.reasonsOnly === true ||
    (b.phase !== 'queued' &&
      b.phase !== 'submitting-relevance' &&
      b.phase !== 'waiting-relevance')
  );
}

/**
 * Project a run onto {done, total} ARTICLE counts — the "Analysing X of Y
 * articles" line.
 *
 * Deliberately NOT `derivePipelineUiState`'s numbers, which count only the
 * candidates the cloud carries. The scoring gate elects ONE representative per
 * duplicate story group and holds the siblings back to inherit its score, so
 * those candidates are a small fraction of the articles being analysed — a feed
 * of 500 would read "5 of 15". `coveredIds` (written at enqueue) restores the
 * siblings; the accordion's `feedStatus.cloudProgress` row keeps the
 * representative-only numbers, which is what its label promises.
 *
 * UNION, not sum: a held-back sibling is not in-flight, so the next gate pass
 * re-elects it into a batch of its own and its id legitimately appears in two
 * batches' sets. Summing would inflate the denominator by the duplicate factor —
 * an overcount replacing the undercount. `done ⊆ total` by construction, so the
 * ratio can never invert.
 *
 * Batches persisted before `coveredIds` shipped fall back to `candidateIds`,
 * i.e. exactly the old numbers — including the old denominator shrink when
 * submit replaces that array. Bounded to one run (RUN_ABANDON_MS caps it at
 * 24h); every batch enqueued after this carries its own covered set.
 */
export function derivePipelineBatchProgress(run: PipelineRun): PipelineBatchProgress {
  // Idle (every batch terminal) reports zero, matching derivePipelineUiState —
  // a finished run must not leave a stale ratio on screen.
  if (run.batches.every((b) => isTerminal(b.phase))) return { done: 0, total: 0 };
  const total = new Set<string>();
  const done = new Set<string>();
  for (const b of run.batches) {
    const covered = b.coveredIds ?? b.candidateIds;
    const known = isRelevanceKnown(b);
    for (const id of covered) {
      total.add(id);
      // A sibling covered by a relevance-known rep counts as done even if it
      // also sits in a queued batch of its own (propagateToUnscoredSiblings
      // skips in-flight ids, so it may still earn its own score). Bounded by
      // `total`, and it can only ever run slightly ahead — never inflate it.
      if (known) done.add(id);
    }
  }
  return { done: done.size, total: total.size };
}

// ---------------------------------------------------------------------------
// Chunk-state projection — the processing area's chunk strip reads this.
// ---------------------------------------------------------------------------

/** What one batch looks like to a reader watching it. */
export type ChunkState = 'queued' | 'in-flight' | 'ready' | 'failed';

export interface PipelineChunkStates {
  /** One entry per batch, in `run.batches` order. */
  readonly chunks: readonly ChunkState[];
  readonly ready: number;
  readonly total: number;
}

/**
 * Project a run onto per-batch state.
 *
 * NOTHING NEW IS RECORDED. `PipelineBatch.phase` has been persisted since the
 * multi-batch pipeline shipped and has simply never been projected; this is a
 * pure read beside the two projections that already do exactly this shape of
 * work, not instrumentation.
 *
 * It counts BATCHES, which is a different quantity from
 * {@link derivePipelineBatchProgress}'s ARTICLE counts, and the two must never
 * be reconciled on screen. A batch is up to 25 articles and the gate holds
 * duplicate siblings back, so "3 of 8 batches" and "40 of 220 articles" are
 * both true at the same instant and neither is the other's percentage.
 *
 * Chunk count can GROW mid-run: the gate re-elects held-back siblings into new
 * batches, so `total` is not fixed when the strip first renders. That is a
 * constraint on the strip (it must get narrower, never taller), not a defect
 * here.
 *
 * Same idle rule as {@link derivePipelineBatchProgress}: every batch terminal
 * means an empty array, so a finished run leaves no stale strip on screen. One
 * definition of idle across all three projections, not three that have to be
 * kept in lockstep.
 */
export function derivePipelineChunkStates(run: PipelineRun): PipelineChunkStates {
  if (run.batches.every((b) => isTerminal(b.phase))) {
    return { chunks: [], ready: 0, total: 0 };
  }
  const chunks = run.batches.map<ChunkState>((b) => {
    if (b.phase === 'done') return 'ready';
    if (b.phase === 'failed') return 'failed';
    if (b.phase === 'queued') return 'queued';
    // Everything between: submitting/waiting relevance, the crash-resumable
    // `needs-reasons-submit` gap, submitting/waiting reasons. A reader does not
    // need six words for "it is being worked on".
    return 'in-flight';
  });
  return {
    chunks,
    ready: chunks.filter((c) => c === 'ready').length,
    total: chunks.length,
  };
}

/**
 * article_suggestions ids whose reason note is still owed by a live batch: the
 * reason candidates of a relevance batch between its relevance apply and its
 * terminal state, and the candidates of a non-terminal reasons-only batch.
 * Covered same-story siblings of a reason candidate are included: the batch
 * copies the candidate's note onto them when it applies. A `reason_pending` row
 * NOT in this set is not being worked on (a failed or abandoned batch, a note
 * that failed the grounding check, or one the orphaned-reasons sweep has not
 * picked up yet).
 */
export function deriveReasonsInFlightIds(run: PipelineRun): Set<string> {
  const ids = new Set<string>();
  for (const b of run.batches) {
    if (isTerminal(b.phase)) continue;
    if (b.reasonsOnly) {
      for (const id of b.reasonCandidateIds ?? b.candidateIds) ids.add(id);
      continue;
    }
    if (
      b.phase === 'needs-reasons-submit' ||
      b.phase === 'submitting-reasons' ||
      b.phase === 'waiting-reasons'
    ) {
      for (const id of b.reasonCandidateIds ?? []) {
        ids.add(id);
        // Siblings get this rep's note when the batch applies
        // (propagateNotesToCoveredSiblings), so theirs is in flight too.
        for (const sibling of b.coveredByRep?.[id] ?? []) ids.add(sibling);
      }
    }
  }
  return ids;
}

/** 'none': no run. 'fresh': the run moved recently. 'collectable': it is
 *  quiet but a batch submitted within COLLECT_WINDOW_MS is still waiting on the
 *  gateway, so it must be collected, never aborted. 'wedged': abort it. */
export type StaleRunVerdict = 'none' | 'fresh' | 'collectable' | 'wedged';

/** The run's last activity: its start or its latest submit, whichever is
 *  later. */
export function latestActivityAt(run: PipelineRun): number {
  let latest = run.startedAt;
  for (const b of run.batches) {
    if (b.submittedAt !== undefined && b.submittedAt > latest) latest = b.submittedAt;
  }
  return latest;
}

/**
 * Pure verdict for the FeedSyncMachine stale guard.
 * - fresh: the run moved within STALE_RUN_GUARD_MS.
 * - collectable: quiet, but a batch submitted within COLLECT_WINDOW_MS still
 *   has results (or a reasons submit) owed to it. Collect it; aborting would
 *   discard paid results AND wipe the run key that decrypts them.
 * - wedged: nothing collectable left; abort it.
 */
export function deriveStaleRunVerdict(
  run: PipelineRun,
  now: number,
): 'fresh' | 'collectable' | 'wedged' {
  if (now - latestActivityAt(run) <= STALE_RUN_GUARD_MS) return 'fresh';
  const collectable = run.batches.some(
    (b) =>
      (isWaiting(b.phase) || b.phase === 'needs-reasons-submit') &&
      b.submittedAt !== undefined &&
      now - b.submittedAt <= COLLECT_WINDOW_MS,
  );
  return collectable ? 'collectable' : 'wedged';
}

export { BATCH_STALE_MS, RUN_ABANDON_MS, holdsRelevanceSlot, isInFlight, isTerminal, isWaiting };
