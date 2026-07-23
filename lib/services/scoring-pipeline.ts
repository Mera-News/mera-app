// scoring-pipeline — orchestrator for the pipelined multi-batch cloud scoring
// flow. Replaces the single giant async job (all unscored articles → one
// relevance job → one reasons job) with ~19 independent 25-article batches.
//
// Each batch flows: submit relevance → poll → decode+save scores+refresh UI →
// submit reasons (impactful subset) → poll → save reasons+refresh UI → done.
// At most MAX_IN_FLIGHT batches hold an outstanding gateway job at once.
//
// Persistence lives in scoring-pipeline-store (settings row + keychain privkey,
// CAS-guarded via mutatePipeline). E2EE uses ONE keypair per run, minted at run
// creation and replayed on every submit via rebuildE2EEContext. Reusable
// decode/fetch/persist helpers are shared with lib/services/inference-results.
//
// Every scoring trigger (run-inference-handler / inference-recover-task /
// feed-sync) now routes through this pipeline; the legacy single-slot async-job
// flow has been removed.

import { AppState } from 'react-native';
import logger from '@/lib/logger';
import { SMALL_MODEL } from '@/lib/llm/constants';
import type { ExecutionContext } from '@/lib/llm/execution-context';
import * as gatewayRateLimiter from '@/lib/llm/gateway-rate-limiter';
import {
  bytesToHex,
  sendInferenceRequest,
} from '@/lib/llm/submitInferenceJob';
import {
  ModelKeyValidationError,
  prepareE2EEContext,
  rebuildE2EEContext,
} from '@/lib/e2ee/e2ee-service';
import {
  getOldestUnscoredCreatedAt,
  getScoredDonorRows,
  getScoredSuggestionsWithoutReasons,
  getUnscoredSuggestionsWithFacts,
  saveReason,
  saveScoringResult,
  batchSaveMathScores,
  getComputedComponentsByIds,
  batchMarkReasonSkipped,
  type ScoringCandidate,
} from '@/lib/database/services/article-suggestion-service';
import {
  bucketScores,
  buildReasonCallsForSubset,
  buildRelevanceCalls,
  decodeResults,
  CLOUD_SCORE_CHUNK_SIZE,
  REASON_MIN_RAW_SCORE,
  type CloudCallBundle,
} from '@/lib/mera-protocol/scoring-service';
import { computeMathStage, effectiveHarnessConfig } from '@/lib/mera-protocol/stage-scoring';
import {
  buildCalibrationCase,
  buildJudgeCalls,
  decodeJudgeResults,
} from '@/lib/news-harness/scoring-engine';
import { DEFAULT_HARNESS_CONFIG, type HarnessConfig } from '@/lib/news-harness/core/config';
import { useUserStore } from '@/lib/stores/user-store';
import {
  discardLowRelevance,
  fetchResults,
  hexToBytes,
  isRecordNotFoundError,
  reconstructLookups,
  toBatchResult,
  REASON_RELEVANCE_THRESHOLD,
  type ServerResults,
} from './inference-results';
import {
  clearPipeline,
  createPipeline,
  getPipeline,
  mutatePipeline,
  type BatchPhase,
  type PipelineBatch,
  type PipelineRun,
} from '@/lib/database/services/scoring-pipeline-store';
import type { BatchCompletionResult } from '@/lib/llm/cloudComplete';
// Static import is safe: score-propagation imports only the DB service + the
// pure story-grouping utility + the logger — it never imports scoring-pipeline,
// so there is no cycle (this module already statically imports the same DB
// service). In-flight ids are passed IN, so it never reaches back here.
import { propagateToUnscoredSiblings } from '@/lib/feed-grouping/score-propagation';
// The cold-start predicate reuses the SAME 48h donor lookback the score
// propagation uses — a table with zero scored donors in that window is exactly
// a "cold" feed (no scores to render, no siblings to propagate from).
import { SCORE_PROPAGATION_LOOKBACK_MS } from '@/lib/feed-grouping/story-grouping';

const TAG = '[scoring-pipeline]';

// Round-4 B: cloud scoring dispatches in STRICT 25-article quanta. The former
// per-fact batch grouping (factId/factStatement) is gone — batches are FIFO
// quanta of BATCH_SIZE eligible candidates in delivery order. factId/
// factStatement remain OPTIONAL persisted fields (always null for new batches)
// only so a run persisted by an older build still parses.

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const BATCH_SIZE = 25;
export const MAX_IN_FLIGHT = 3;
/** Legacy alias for BATCH_SIZE, kept exported for back-compat. The quantum rule
 *  (dispatch every full BATCH_SIZE, defer the remainder) uses BATCH_SIZE. */
export const MIN_RUN_CANDIDATES = BATCH_SIZE;
/** Escape hatch: if the oldest unscored row has been waiting this long, also
 *  dispatch the trailing partial (<BATCH_SIZE) quantum — unscored articles
 *  don't render, so a strict quantum gate could hide news for hours on slow
 *  days. */
export const MAX_UNSCORED_WAIT_MS = 30 * 60_000;
/** P7d cold-start floor: on a COLD feed (no scored donor in the 48h window) the
 *  first paint is gated on the trailing partial quantum, so we dispatch it
 *  immediately once it holds at least this many rows rather than waiting for a
 *  full BATCH_SIZE or the 30-min staleness escape. Derived as two cloud-scoring
 *  chunks (2 × CLOUD_SCORE_CHUNK_SIZE) — one chunk is too little to be worth a
 *  run, two guarantees a multi-chunk prompt shaped like a steady-state batch, so
 *  the per-prompt content stays byte-identical to the warm path. */
export const COLD_START_MIN_BATCH = 2 * CLOUD_SCORE_CHUNK_SIZE;
const SUBMIT_STUCK_MS = 60_000;
const BATCH_STALE_MS = 15 * 60_000;
/** A run whose `startedAt` is older than this is treated as wedged: the
 *  FeedSyncMachine stale-guard aborts it (force-fail + finalize) and proceeds
 *  with the sync rather than skipping every cycle forever. Derived from
 *  BATCH_STALE_MS (two full stale windows — a healthy run's batches all clear
 *  well within one), so there is no independent magic number to keep in sync. */
export const STALE_RUN_GUARD_MS = 2 * BATCH_STALE_MS;
const MAX_BATCH_ATTEMPTS = 2;
const RUN_ABANDON_MS = 24 * 3600_000;
const POLL_INTERVAL_MS = 7_000;
const MIN_POLL_AGE_MS = 15_000;
const PER_BATCH_POLL_SPACING_MS = 20_000;

// ---------------------------------------------------------------------------
// Phase predicates
// ---------------------------------------------------------------------------

function isTerminal(phase: BatchPhase): boolean {
  return phase === 'done' || phase === 'failed';
}

/** Batches that currently hold an outstanding gateway job (count against
 *  MAX_IN_FLIGHT). `needs-reasons-submit` and `queued` are between/before jobs
 *  and do NOT count. */
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

// ---------------------------------------------------------------------------
// Module state (in-memory; not persisted)
// ---------------------------------------------------------------------------

let drainInFlight: Promise<void> | null = null;
let finalizeInFlight: Promise<void> | null = null;
// Post-finalize kick: after a run finalizes, if a full quantum of unscored rows
// still remains we want the NEXT run to start immediately rather than waiting
// for the next discovery tick. Scheduled as a macrotask so it runs AFTER the
// finalize/drain single-flights have fully settled (calling drain/finalize from
// inside their own in-flight promise would be swallowed / deadlock).
let postFinalizeKickTimer: ReturnType<typeof setTimeout> | null = null;
// Last poll timestamp per batchId — enforces PER_BATCH_POLL_SPACING_MS. Kept in
// memory (not persisted) so a fresh process simply re-polls.
const lastPolledAt = new Map<number, number>();

let pollerTimer: ReturnType<typeof setInterval> | null = null;
let appStateSub: { remove: () => void } | null = null;
let pollTickRunning = false;

// P7d cold-start cache: once the feed has ANY scored donor in the 48h window it
// is WARM for the rest of the process. The cold→warm transition only ever
// happens once per launch (the first batch's scores land) and never reverses
// without a restart (scored rows only leave the window by ageing past 48h, far
// longer than a session), so caching the warm verdict permanently avoids a DB
// read on every enqueue/poll tick. Reset by _resetForTests.
let feedWarmCached = false;

// ---------------------------------------------------------------------------
// Cold-start predicate (P7d)
// ---------------------------------------------------------------------------

/**
 * True when the feed is COLD — zero scored donor rows within the 48h score
 * propagation lookback (the same window {@link propagateToUnscoredSiblings}
 * uses). A cold table has nothing rendered yet, so the first scored paint is on
 * the critical path; the enqueue partial-quantum knob and the poll-latency knob
 * both relax only while this holds. Warm is cached (see `feedWarmCached`) so a
 * warm feed pays no per-tick DB cost. Fails WARM on a read error — the
 * aggressive cold knobs must never fire off a failed read.
 */
export async function isFeedCold(): Promise<boolean> {
  if (feedWarmCached) return false;
  try {
    const donors = await getScoredDonorRows(
      Date.now() - SCORE_PROPAGATION_LOOKBACK_MS,
    );
    if (donors.length > 0) {
      feedWarmCached = true;
      return false;
    }
    return true;
  } catch (err) {
    logger.captureException(err, {
      tags: { service: 'scoring-pipeline', step: 'is-feed-cold' },
    });
    return false;
  }
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function chunkIds(ids: string[], size: number): string[][] {
  const out: string[][] = [];
  for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size));
  return out;
}

function makeQueuedBatch(
  batchId: number,
  candidateIds: string[],
  reasonsOnly = false,
): PipelineBatch {
  return {
    batchId,
    phase: 'queued',
    candidateIds,
    attempt: 0,
    ...(reasonsOnly ? { reasonsOnly: true } : {}),
  };
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
 * Async convenience for callers OUTSIDE this module (feed-sync, the sibling
 * propagation hook below): read the current run and return the ids sitting in a
 * non-terminal batch. Empty set when no run exists. Behaviour is identical to
 * `nonTerminalCandidateIds(run)` — this just does the `getPipeline()` for you so
 * the pipeline's run shape stays private.
 */
export async function getNonTerminalCandidateIds(): Promise<Set<string>> {
  const snap = await getPipeline();
  return snap ? nonTerminalCandidateIds(snap.run) : new Set<string>();
}

async function refreshUi(): Promise<void> {
  // Lazy require (not a static import) breaks the load-time cycle
  // scoring-pipeline → SuggestionSyncService → run-inference-handler →
  // (wave 3) scoring-pipeline. Same pattern as lib/database/hydrate-stores.ts.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require('./SuggestionSyncService') as typeof import('./SuggestionSyncService');
  await mod.refreshSuggestionsInStoreUnsafe();
  // Every suggestions refresh is also a header-progress checkpoint (scores/notes
  // just landed or a batch went terminal) — keep the "Sifting through X/Y"
  // header in lockstep with the pipeline.
  await pushUiProgress();
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
    const relevanceKnown =
      b.reasonsOnly === true ||
      (b.phase !== 'queued' &&
        b.phase !== 'submitting-relevance' &&
        b.phase !== 'waiting-relevance');
    if (relevanceKnown) processed += n;
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

/** Read the persisted run and project it. 'idle' when no run exists. Consumed
 *  by both the live progress hook below and the store's boot hydration. */
export async function getPipelineUiState(): Promise<PipelineUiState> {
  const snap = await getPipeline();
  if (!snap) return { phase: 'idle', processedCount: 0, totalCount: 0 };
  return derivePipelineUiState(snap.run);
}

// ---------------------------------------------------------------------------
// Batch progress projection (Round-4 B) — the honest "Analysing X of Y
// articles" line in the shimmer + the status accordion read this.
// ---------------------------------------------------------------------------

/** How much of the current run has finished, in ARTICLE counts. `done` counts
 *  the articles whose relevance is known (relevance-known batches: past the
 *  pre-relevance phases; reasonsOnly + terminal batches count too — same
 *  numerator as {@link derivePipelineUiState}); `total` counts every candidate
 *  article across all batches. `null` when no run is active. */
export interface PipelineBatchProgress {
  done: number;
  total: number;
}

/** Project a run onto {done, total} article counts. Reuses the header UI
 *  projection so the shimmer's "Analysing done/total" is in lockstep with the
 *  cloud-progress row. A legacy per-fact run projects identically (batches are
 *  just counted). */
export function derivePipelineBatchProgress(run: PipelineRun): PipelineBatchProgress {
  const ui = derivePipelineUiState(run);
  return { done: ui.processedCount, total: ui.totalCount };
}

/** Read the persisted run and project its batch progress. `null` when no run
 *  exists / every batch is terminal. Consumed by the store's boot hydration. */
export async function getPipelineBatchProgress(): Promise<PipelineBatchProgress | null> {
  const snap = await getPipeline();
  if (!snap) return null;
  const ui = derivePipelineUiState(snap.run);
  if (ui.phase === 'idle') return null;
  return { done: ui.processedCount, total: ui.totalCount };
}

/** Best-effort push of the derived phase + progress into the For-You header
 *  store. Lazily-required (like refreshUi) to avoid a load-time import cycle. */
async function pushUiProgress(): Promise<void> {
  try {
    const snap = await getPipeline();
    const ui = snap
      ? derivePipelineUiState(snap.run)
      : { phase: 'idle' as const, processedCount: 0, totalCount: 0 };
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { useForYouStore } = require('@/lib/stores/for-you-store') as typeof import('@/lib/stores/for-you-store');
    const store = useForYouStore.getState();
    if (ui.phase === 'idle') {
      store.setAsyncJobPhase('idle');
      store.setBatchProgress(null);
    } else {
      store.setAsyncJobPhase(ui.phase, ui.processedCount, ui.totalCount);
      store.setBatchProgress({ done: ui.processedCount, total: ui.totalCount });
    }
  } catch (err) {
    logger.captureException(err, {
      tags: { service: 'scoring-pipeline', step: 'push-ui-progress' },
    });
  }
}

function getExpoPushToken(): string | null {
  return useUserStore.getState().userPersona?.expoPushToken ?? null;
}

function makeRunId(): string {
  return `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

// ---------------------------------------------------------------------------
// Public API — enqueue
// ---------------------------------------------------------------------------

/**
 * Add fresh unscored candidate ids into the pipeline in STRICT 25-article
 * quanta (Round-4 B). ids already in a non-terminal batch are deduped out; the
 * remaining fresh ids (delivery order preserved) are chunked into BATCH_SIZE
 * quanta. Every FULL quantum is dispatched immediately — creating the run
 * (minting the E2EE keypair) if none exists, else appending to it. The trailing
 * partial (<BATCH_SIZE) stays unscored/deferred and re-enters the next cycle
 * (greedy accumulation), UNLESS the oldest unscored row has aged past
 * MAX_UNSCORED_WAIT_MS, in which case the partial is dispatched too so a slow
 * trickle can't hide news for hours. The rule is uniform for run creation AND
 * appends — no foreground special-case.
 */
export async function enqueueCandidates(
  ids: string[],
  flushPartial = false,
): Promise<{ deferred: string[] }> {
  if (ids.length === 0) return { deferred: [] };
  const snap = await getPipeline();

  const existing = snap ? nonTerminalCandidateIds(snap.run) : new Set<string>();
  const fresh = ids.filter((id) => !existing.has(id));
  if (fresh.length === 0) {
    if (snap) {
      await drain('foreground');
      ensurePoller();
    }
    return { deferred: [] };
  }

  // FIFO 25-article quanta. chunkIds yields at most one trailing partial (the
  // last chunk); dispatch every full quantum, defer the partial unless the
  // staleness escape fires.
  const chunks = chunkIds(fresh, BATCH_SIZE);
  const dispatch: string[][] = [];
  let deferred = 0;
  // The trailing partial's ids when it's held back — returned to the caller so
  // feed-sync can flush it once the whole lot is hydrated (flushPartial pass).
  let deferredIds: string[] = [];
  for (const chunk of chunks) {
    if (chunk.length === BATCH_SIZE) {
      dispatch.push(chunk);
      continue;
    }
    // Trailing partial (<BATCH_SIZE). chunkIds only ever yields one, as the last
    // chunk, so the cold read below runs at most once per enqueue.
    //
    // Flush: the caller (feed-sync, after a fully-hydrated lot) asked to score
    // everything now. We don't refetch until the whole lot is scored, so a
    // deferred trailing partial would sit idle for up to MAX_UNSCORED_WAIT_MS
    // with no next fetch coming to fill the quantum — dispatch it immediately.
    if (flushPartial) {
      logger.info(
        `${TAG} enqueueCandidates: flush — dispatching trailing partial of ${chunk.length} (lot fully hydrated)`,
      );
      dispatch.push(chunk);
      continue;
    }
    //
    // Knob 1 (P7d): on a COLD feed the first scored paint is gated entirely on
    // this partial — the warm "accumulate to 25 / 30-min staleness escape" rule
    // would leave the feed empty until a full quantum arrives. Dispatch it
    // straight away once it holds at least COLD_START_MIN_BATCH rows so the very
    // first hydration chunk starts scoring. Warm feeds keep the exact prior
    // behavior (isFeedCold returns false → falls through to the escape below).
    if ((await isFeedCold()) && chunk.length >= COLD_START_MIN_BATCH) {
      logger.info(
        `${TAG} enqueueCandidates: cold-start — dispatching partial batch of ${chunk.length} (>=${COLD_START_MIN_BATCH}, no scored donors in 48h)`,
      );
      dispatch.push(chunk);
      continue;
    }
    const oldestCreatedAt = await getOldestUnscoredCreatedAt();
    const oldestAgeMs =
      oldestCreatedAt !== null ? Date.now() - oldestCreatedAt : 0;
    if (oldestCreatedAt !== null && oldestAgeMs >= MAX_UNSCORED_WAIT_MS) {
      logger.info(
        `${TAG} enqueueCandidates: staleness escape — dispatching partial batch of ${chunk.length} (oldest unscored waited ${Math.round(oldestAgeMs / 60_000)}min)`,
      );
      dispatch.push(chunk);
    } else {
      deferred = chunk.length;
      deferredIds = chunk;
      logger.info(
        `${TAG} enqueueCandidates: deferred ${chunk.length} unscored (<${BATCH_SIZE} quantum, oldest ${Math.round(oldestAgeMs / 60_000)}min)`,
      );
    }
  }

  if (dispatch.length === 0) {
    if (snap) {
      await drain('foreground');
      ensurePoller();
    }
    return { deferred: deferredIds };
  }

  logger.info(
    `${TAG} enqueueCandidates: ${fresh.length} fresh ids → ${dispatch.length} batch(es) dispatched, ${deferred} deferred (run ${snap ? 'exists' : 'new'})`,
  );

  const build = (base: number): PipelineBatch[] =>
    dispatch.map((c, i) => makeQueuedBatch(base + i, c, false));

  if (!snap) {
    await createRunWithBatches(build);
  } else {
    await appendBatches(build);
  }

  await drain('foreground');
  ensurePoller();
  return { deferred: deferredIds };
}

/**
 * Append reasons-only batches for rows that are scored (relevance saved) but
 * whose reason generation never completed and that aren't already covered by a
 * non-terminal batch — the recovery path for reasons lost mid-flight, enqueued
 * as independent 25-row reasons-only batches.
 */
export async function enqueueOrphanedReasons(): Promise<void> {
  const scored = await getScoredSuggestionsWithoutReasons();
  const snap = await getPipeline();

  const covered = snap
    ? nonTerminalCandidateIds(snap.run)
    : new Set<string>();
  const qualified = scored.filter(
    (c) =>
      typeof c.relevance === 'number' &&
      c.relevance > REASON_RELEVANCE_THRESHOLD &&
      !covered.has(c.id),
  );
  if (qualified.length === 0) {
    if (snap) {
      await drain('foreground');
      ensurePoller();
    }
    return;
  }

  const chunks = chunkIds(
    qualified.map((c) => c.id),
    BATCH_SIZE,
  );
  logger.info(
    `${TAG} enqueueOrphanedReasons: ${qualified.length} rows → ${chunks.length} reasonsOnly batch(es)`,
  );

  if (!snap) {
    await createRunWithBatches((base) =>
      chunks.map((c, i) => makeQueuedBatch(base + i, c, true)),
    );
  } else {
    await appendBatches((base) =>
      chunks.map((c, i) => makeQueuedBatch(base + i, c, true)),
    );
  }

  await drain('foreground');
  ensurePoller();
}

/** Mint the run keypair and create the run with the batches from `build`. */
async function createRunWithBatches(
  build: (base: number) => PipelineBatch[],
): Promise<void> {
  const ctx = await prepareE2EEContext(SMALL_MODEL);
  const run: Omit<PipelineRun, 'version' | 'schema'> = {
    runId: makeRunId(),
    startedAt: Date.now(),
    algo: ctx.algo,
    expoPushToken: getExpoPushToken(),
    batches: build(0),
  };
  try {
    await createPipeline(run, bytesToHex(ctx.privateKey));
    logger.info(
      `${TAG} created run ${run.runId} with ${run.batches.length} batch(es)`,
    );
  } catch (err) {
    // Another context created a run between our getPipeline() and here — append
    // to it instead of clobbering (its keypair wins).
    logger.warn(
      `${TAG} createPipeline lost the race (${String(err)}) — appending instead`,
    );
    await appendBatches(build);
  }
}

async function appendBatches(
  build: (base: number) => PipelineBatch[],
): Promise<void> {
  await mutatePipeline((run) => {
    const base =
      run.batches.reduce((m, b) => Math.max(m, b.batchId), -1) + 1;
    for (const b of build(base)) run.batches.push(b);
    return true;
  });
}

// ---------------------------------------------------------------------------
// Drain — admit queued batches up to MAX_IN_FLIGHT
// ---------------------------------------------------------------------------

async function drain(context: ExecutionContext): Promise<void> {
  if (drainInFlight) return drainInFlight;
  drainInFlight = doDrain(context).finally(() => {
    drainInFlight = null;
  });
  return drainInFlight;
}

async function doDrain(context: ExecutionContext): Promise<void> {
  for (;;) {
    const snap = await getPipeline();
    if (!snap) break;
    const { run } = snap;

    const inFlightCount = run.batches.filter((b) => isInFlight(b.phase)).length;
    if (inFlightCount >= MAX_IN_FLIGHT) break;

    const queued = run.batches.find((b) => b.phase === 'queued');
    if (!queued) break;

    // Background wakes never admit fresh 'queued' batches: a fresh
    // relevance/reasonsOnly job has no prior capability token, and background
    // submits authenticate ONLY with the token of a completed job (the
    // keychain JWT is off-limits while the device may be locked). Queued
    // batches wait for the next foreground recover/poller tick — a background
    // wake stays within its "≤1 GET + ≤1 POST per batch" budget via the
    // needs-reasons-submit path, which does carry a token.
    if (context === 'background') {
      logger.info(
        `${TAG} drain(background): ${run.batches.filter((b) => b.phase === 'queued').length} queued batch(es) deferred to foreground (no capability token for fresh submits)`,
      );
      break;
    }

    // Rate-limiter admission budget. If none is available right now, stop —
    // the poller/next enqueue will retry.
    if (!gatewayRateLimiter.tryTakeImmediate()) break;

    // Claim the batch (CAS queued → submitting-*). Result carries reasonsOnly.
    const claim = await mutatePipeline((r) => {
      const b = r.batches.find((x) => x.batchId === queued.batchId);
      if (!b || b.phase !== 'queued') return null;
      b.phase = b.reasonsOnly ? 'submitting-reasons' : 'submitting-relevance';
      b.submittedAt = Date.now();
      return true;
    });
    if (claim === 'aborted' || claim === 'no-run') {
      // Someone else took it — try the next queued batch.
      continue;
    }

    await doSubmit(queued.batchId, context);
  }

  // Submits this drain may have moved idle→relevance or admitted fresh batches
  // (changing the denominator) without any refreshUi firing — checkpoint the
  // header once the admission loop settles.
  await pushUiProgress();

  // A submit inside the loop may have flipped the last batch terminal (empty
  // bundle / submit failure). Never calls drain, so no re-entrancy.
  await maybeFinalize();
}

/**
 * Finalize the run if every batch is terminal. Called at the end of a drain
 * (drain is where a submit can flip the LAST batch terminal via an empty
 * bundle or a submit failure) and — via afterTerminal → drain — after every
 * other terminal transition. Never calls drain, so it is safe to invoke from
 * inside doDrain without re-entering the single-flight guard.
 */
async function maybeFinalize(): Promise<void> {
  const snap = await getPipeline();
  if (!snap) return;
  if (snap.run.batches.every((b) => isTerminal(b.phase))) {
    await finalize(snap.run);
  }
}

// ---------------------------------------------------------------------------
// Submit — build bundle + POST + transition
// ---------------------------------------------------------------------------

async function doSubmit(
  batchId: number,
  context: ExecutionContext,
): Promise<void> {
  const snap = await getPipeline();
  if (!snap) return;
  const { run, privKeyHex } = snap;
  const batch = run.batches.find((b) => b.batchId === batchId);
  if (!batch) return;
  if (
    batch.phase !== 'submitting-relevance' &&
    batch.phase !== 'submitting-reasons'
  ) {
    return;
  }
  const fromPhase = batch.phase;

  try {
    if (batch.reasonsOnly) {
      await doSubmitReasonsOnly(run, batch, privKeyHex, context);
      return;
    }
    await doSubmitRelevance(run, batch, privKeyHex, context);
  } catch (err) {
    // The E2EE context (re)build validates the model attestation key up front;
    // an off-curve ecdsa key throws ModelKeyValidationError here BEFORE any POST
    // (MERA-APP-39). It is non-retryable within this run — fail the batch
    // terminally so revertStuckSubmitters + the poller stop re-driving it. All
    // other throws propagate unchanged.
    if (err instanceof ModelKeyValidationError) {
      logger.warn(
        `${TAG} batch ${batchId} submit aborted — model key invalid (${err.message}); failing batch (non-retryable this run)`,
      );
      await failSubmitModelKeyInvalid(batchId, fromPhase);
      return;
    }
    throw err;
  }
}

/**
 * Wave 14: the calibration-overrides-aware config for judge call build/decode —
 * the SAME effective config computeMathStage scores with, so the judge sees
 * post-override computed scores against post-override constants. One lookup per
 * batch. Fail-opens to DEFAULT_HARNESS_CONFIG (also covers tests that mock
 * stage-scoring without this export).
 */
async function judgeHarnessConfig(): Promise<HarnessConfig> {
  try {
    return (await effectiveHarnessConfig()) ?? DEFAULT_HARNESS_CONFIG;
  } catch {
    return DEFAULT_HARNESS_CONFIG;
  }
}

async function doSubmitRelevance(
  run: PipelineRun,
  batch: PipelineBatch,
  privKeyHex: string,
  context: ExecutionContext,
): Promise<void> {
  const all = await getUnscoredSuggestionsWithFacts();
  const idSet = new Set(batch.candidateIds);
  const subset = all.filter((c) => idSet.has(c.id));

  // Run the deterministic math on-device NOW (no LLM). This partitions the
  // batch into math-mode (tagged metadata → judge job) vs backstop (untagged →
  // legacy tiered LLM relevance), and — for the judge path — gives us the
  // computed scores we persist so a judge failure fail-opens to the math.
  const math = await computeMathStage(subset);
  const backstop = math.stage.filter(
    (c) => math.modeMap.get(c.input.id) === 'backstop',
  );

  // Push-token policy (a): attach the run's token only when this is the LAST
  // relevance-needing batch — no other relevance batch is queued or submitting.
  const otherRelevancePending = run.batches.some(
    (b) =>
      b.batchId !== batch.batchId &&
      !b.reasonsOnly &&
      (b.phase === 'queued' || b.phase === 'submitting-relevance'),
  );
  const token = otherRelevancePending ? null : run.expoPushToken;

  // --- BACKSTOP PATH (any untagged candidate) — unchanged legacy flow. ------
  // Mixed/untagged batches keep the two-phase tiered LLM scoring exactly as
  // before (the plan's backstop path). No math audit is persisted here.
  if (backstop.length > 0) {
    const bundle = await buildRelevanceCalls(subset);
    if (bundle.calls.length === 0 || bundle.eligibleCandidates.length === 0) {
      logger.info(
        `${TAG} batch ${batch.batchId} relevance bundle empty — marking done`,
      );
      // Terminal transition inside the drain loop; doDrain's maybeFinalize
      // handles the run finalize (calling afterTerminal here would re-enter
      // drain).
      await markBatchDone(batch.batchId);
      return;
    }
    const eligibleIds = bundle.eligibleCandidates.map((c) => c.id);

    const ctx = await rebuildE2EEContext(SMALL_MODEL, privKeyHex, run.algo);
    logger.info(
      `${TAG} batch ${batch.batchId} submit relevance (backstop): ${eligibleIds.length} ids in ${bundle.calls.length} calls (token=${token ? 'yes' : 'no'})`,
    );
    const outcome = await sendInferenceRequest({
      bundle,
      ctx,
      token,
      model: SMALL_MODEL,
      context,
    });

    if (outcome.status === 'ok') {
      // judgeMode stays false (default) — decode routes to the legacy path.
      await transitionToWaitingRelevance(batch.batchId, outcome, eligibleIds);
      logger.info(
        `${TAG} batch ${batch.batchId} → waiting-relevance requestId=${outcome.requestId}`,
      );
    } else if (outcome.status === 'throttled') {
      await requeueThrottled(batch.batchId, 'submitting-relevance');
    } else {
      // Inside the drain loop — doDrain's maybeFinalize covers the terminal case.
      await failOrRetrySubmit(batch.batchId, 'submitting-relevance');
    }
    return;
  }

  // --- JUDGE MODE (all candidates are math-mode) ---------------------------
  // Round-3 B1: PERSIST THE MATH IMMEDIATELY (bucketed relevance, reason:'',
  // reasonSkipped for sub-threshold rows, scored_at, audit columns) so cards are
  // renderable now — the judge no longer decides the score (Part A: advisory),
  // it only writes the note. Bucket a copy; keep the raw computed as rawScore.
  const bucketed = new Map(math.computedScoreMap);
  bucketScores(bucketed);
  const bucketedRecord: Record<string, number> = {};
  for (const c of math.stage) {
    const id = c.input.id;
    bucketedRecord[id] = bucketed.get(id) ?? 0;
  }
  await batchSaveMathScores(
    math.stage.map((c) => {
      const id = c.input.id;
      const bucket = bucketed.get(id) ?? 0;
      return {
        id,
        relevance: bucket,
        reasonSkipped: bucket <= REASON_RELEVANCE_THRESHOLD,
        computedScore: math.computedScoreMap.get(id)!,
        rawScore: math.computedScoreMap.get(id)!,
        scoreComponentsJson: JSON.stringify(math.componentsMap.get(id)!),
      };
    }),
  );
  await refreshUi();

  // Fresh donors — copy scores onto held-back unscored siblings (same as the
  // legacy relevance path, moved to submit since the score is final here).
  try {
    const inFlight = await getNonTerminalCandidateIds();
    const propagated = await propagateToUnscoredSiblings(inFlight);
    if (propagated > 0) await refreshUi();
  } catch (err) {
    logger.captureException(err, {
      tags: { service: 'scoring-pipeline', step: 'propagate-siblings' },
    });
  }

  // The judge+notes job only needs the ABOVE-THRESHOLD survivors (the rows that
  // will render + earn a note). Sub-threshold rows are already terminal
  // (reasonSkipped). buildJudgeCalls chunks this subset in order → the `judge:N`
  // decode join key stored as judgedIds.
  const judgedStage = math.stage.filter(
    (c) => (bucketed.get(c.input.id) ?? 0) > REASON_RELEVANCE_THRESHOLD,
  );
  const judgedIds = judgedStage.map((c) => c.input.id);

  if (judgedStage.length === 0) {
    logger.info(
      `${TAG} batch ${batch.batchId} judge: no above-threshold rows — marking done`,
    );
    const discarded = await discardLowRelevance(batch.candidateIds, bucketedRecord);
    if (discarded > 0) await refreshUi();
    await markBatchDone(batch.batchId);
    return;
  }

  const { calls } = buildJudgeCalls(
    judgedStage,
    math.computedScoreMap,
    math.componentsMap,
    math.persona,
    await judgeHarnessConfig(),
  );
  if (calls.length === 0) {
    logger.info(
      `${TAG} batch ${batch.batchId} judge bundle empty — marking done`,
    );
    const discarded = await discardLowRelevance(batch.candidateIds, bucketedRecord);
    if (discarded > 0) await refreshUi();
    await markBatchDone(batch.batchId);
    return;
  }

  const bundle: CloudCallBundle = {
    calls,
    promptsById: new Map(),
    chunkIdToCandidates: new Map(),
    eligibleCandidates: subset,
  };

  const ctx = await rebuildE2EEContext(SMALL_MODEL, privKeyHex, run.algo);
  logger.info(
    `${TAG} batch ${batch.batchId} submit judge notes: ${judgedIds.length}/${math.stage.length} ids in ${calls.length} calls (token=${token ? 'yes' : 'no'})`,
  );
  const outcome = await sendInferenceRequest({
    bundle,
    ctx,
    token,
    model: SMALL_MODEL,
    context,
  });

  if (outcome.status === 'ok') {
    // Carry the computed scores of the JUDGED subset forward via rawRelevanceMap
    // (decode fail-open + the reason-threshold filter), the bucketed relevance
    // map (for the decode-time discard), and the judged id order (decode join).
    const computedRecord: Record<string, number> = {};
    for (const id of judgedIds) {
      computedRecord[id] = math.computedScoreMap.get(id)!;
    }
    // candidateIds stays the FULL batch (discard at decode covers every row);
    // judgedIds is the judge subset.
    await transitionToWaitingRelevance(
      batch.batchId,
      outcome,
      batch.candidateIds,
      {
        judgeMode: true,
        computedScoreMap: computedRecord,
        relevanceMap: bucketedRecord,
        judgedIds,
      },
    );
    logger.info(
      `${TAG} batch ${batch.batchId} → waiting-relevance (judge notes) requestId=${outcome.requestId}`,
    );
  } else if (outcome.status === 'throttled') {
    await requeueThrottled(batch.batchId, 'submitting-relevance');
  } else {
    // Inside the drain loop — doDrain's maybeFinalize covers the terminal case.
    await failOrRetrySubmit(batch.batchId, 'submitting-relevance');
  }
}

async function doSubmitReasonsOnly(
  run: PipelineRun,
  batch: PipelineBatch,
  privKeyHex: string,
  context: ExecutionContext,
): Promise<void> {
  const scored = await getScoredSuggestionsWithoutReasons();
  const idSet = new Set(batch.candidateIds);
  const subset = scored.filter((c) => idSet.has(c.id));
  const rawMap: Record<string, number> = {};
  for (const c of subset) {
    if (typeof c.relevance === 'number') rawMap[c.id] = c.relevance;
  }
  const bundle = await buildReasonCallsForSubset(
    subset,
    rawMap,
    REASON_RELEVANCE_THRESHOLD,
  );
  if (bundle.calls.length === 0) {
    logger.info(
      `${TAG} batch ${batch.batchId} reasonsOnly bundle empty — marking done`,
    );
    // Terminal inside the drain loop; doDrain's maybeFinalize handles finalize.
    await markBatchDone(batch.batchId);
    return;
  }

  const token =
    AppState.currentState !== 'active' ? run.expoPushToken : null;
  const ctx = await rebuildE2EEContext(SMALL_MODEL, privKeyHex, run.algo);
  const reasonIds = bundle.eligibleCandidates.map((c) => c.id);
  logger.info(
    `${TAG} batch ${batch.batchId} submit reasonsOnly: ${reasonIds.length} ids in ${bundle.calls.length} calls`,
  );
  const outcome = await sendInferenceRequest({
    bundle,
    ctx,
    token,
    model: SMALL_MODEL,
    context,
  });

  if (outcome.status === 'ok') {
    await transitionToWaitingReasons(batch.batchId, outcome, reasonIds, rawMap);
    logger.info(
      `${TAG} batch ${batch.batchId} → waiting-reasons requestId=${outcome.requestId}`,
    );
  } else if (outcome.status === 'throttled') {
    await requeueThrottled(batch.batchId, 'submitting-reasons');
  } else {
    // Inside the drain loop — doDrain's maybeFinalize covers the terminal case.
    await failOrRetrySubmit(batch.batchId, 'submitting-reasons');
  }
}

// ---------------------------------------------------------------------------
// State transitions (all CAS via mutatePipeline, guarded on source phase)
// ---------------------------------------------------------------------------

async function transitionToWaitingRelevance(
  batchId: number,
  outcome: { requestId: string; capabilityToken: string },
  eligibleIds: string[],
  judge?: {
    judgeMode: boolean;
    computedScoreMap: Record<string, number>;
    relevanceMap: Record<string, number>;
    judgedIds: string[];
  },
): Promise<void> {
  await mutatePipeline((run) => {
    const b = run.batches.find((x) => x.batchId === batchId);
    if (!b || b.phase !== 'submitting-relevance') return null;
    b.phase = 'waiting-relevance';
    b.requestId = outcome.requestId;
    b.capabilityToken = outcome.capabilityToken || undefined;
    b.candidateIds = eligibleIds; // eligible/submit order = decode join key
    b.submittedAt = Date.now();
    if (judge) {
      // Judge-mode batch: flag it so decode routes to handleJudgeResults, stash
      // the computed (math) scores on rawRelevanceMap (decode fail-open + reason
      // threshold), the bucketed relevance persisted at submit, and the
      // above-threshold subset the judge job was built over (the `judge:N`
      // decode join key).
      b.judgeMode = judge.judgeMode;
      b.rawRelevanceMap = judge.computedScoreMap;
      b.relevanceMap = judge.relevanceMap;
      b.judgedIds = judge.judgedIds;
    }
    return true;
  });
}

async function transitionToWaitingReasons(
  batchId: number,
  outcome: { requestId: string; capabilityToken: string },
  reasonIds: string[],
  relevanceMap?: Record<string, number>,
): Promise<void> {
  await mutatePipeline((run) => {
    const b = run.batches.find((x) => x.batchId === batchId);
    if (
      !b ||
      (b.phase !== 'submitting-reasons' && b.phase !== 'needs-reasons-submit')
    ) {
      return null;
    }
    b.phase = 'waiting-reasons';
    b.requestId = outcome.requestId;
    b.capabilityToken = outcome.capabilityToken || undefined;
    b.reasonCandidateIds = reasonIds;
    b.submittedAt = Date.now();
    // reasonsOnly batches carry no prior relevanceMap — seed it (used only by
    // the batch-scoped discard, which removes nothing here since all rows are
    // above threshold). needs-reasons-submit batches already have theirs.
    if (relevanceMap) {
      b.relevanceMap = relevanceMap;
      b.rawRelevanceMap = relevanceMap;
    }
    return true;
  });
}

/** Throttled submit — return to queued, attempt unchanged. */
async function requeueThrottled(
  batchId: number,
  fromPhase: 'submitting-relevance' | 'submitting-reasons',
): Promise<void> {
  await mutatePipeline((run) => {
    const b = run.batches.find((x) => x.batchId === batchId);
    if (!b || b.phase !== fromPhase) return null;
    b.phase = 'queued';
    return true;
  });
  logger.info(`${TAG} batch ${batchId} throttled — requeued (attempt unchanged)`);
}

/** Submit POST failed — attempt+1; fail at cap, else requeue. */
async function failOrRetrySubmit(
  batchId: number,
  fromPhase: 'submitting-relevance' | 'submitting-reasons',
): Promise<void> {
  await mutatePipeline((run) => {
    const b = run.batches.find((x) => x.batchId === batchId);
    if (!b || b.phase !== fromPhase) return null;
    b.attempt = b.attempt + 1;
    if (b.attempt >= MAX_BATCH_ATTEMPTS) {
      b.phase = 'failed';
      b.failureReason = 'submit-failed';
    } else {
      b.phase = 'queued';
    }
    return true;
  });
}

/**
 * Non-retryable submit failure: the model's TEE attestation key can't be used
 * for E2EE (ModelKeyValidationError — an off-curve secp256k1 key, MERA-APP-39).
 * Unlike failOrRetrySubmit, this fails the batch IMMEDIATELY (no attempt cap /
 * requeue) — resubmitting within THIS run reuses the run's bound algo/keypair
 * and refetches the same bad key, so retrying only re-drives the poller every
 * ~7s. A later run's fresh prepareE2EEContext (fleet load-balances curves, bad
 * keys are never cached) retries naturally. Reuses the existing 'submit-failed'
 * reason (the failureReason enum lives in the DB store, which this track must not
 * touch); the specific cause is logged + captured once in fetchModelPublicKey.
 * In-loop safe (mirrors failOrRetrySubmit): sets terminal phase only, letting
 * doDrain's tail maybeFinalize finalize — never calls drain/afterTerminal.
 */
async function failSubmitModelKeyInvalid(
  batchId: number,
  fromPhase: 'submitting-relevance' | 'submitting-reasons',
): Promise<void> {
  await mutatePipeline((run) => {
    const b = run.batches.find((x) => x.batchId === batchId);
    if (!b || b.phase !== fromPhase) return null;
    b.phase = 'failed';
    b.failureReason = 'submit-failed';
    return true;
  });
}

async function markBatchDone(batchId: number): Promise<void> {
  await mutatePipeline((run) => {
    const b = run.batches.find((x) => x.batchId === batchId);
    if (!b || isTerminal(b.phase)) return null;
    b.phase = 'done';
    return true;
  });
}

// ---------------------------------------------------------------------------
// Poll a single batch's job + apply results
// ---------------------------------------------------------------------------

async function checkBatch(
  batch: PipelineBatch,
  context: ExecutionContext,
): Promise<void> {
  if (!batch.requestId) return;
  let res: ServerResults | 'pending' | 'not-found' | 'unauthorized';
  try {
    res = await fetchResults(
      batch.requestId,
      context,
      batch.capabilityToken || undefined,
    );
  } catch (err) {
    logger.captureException(err, {
      tags: { service: 'scoring-pipeline', step: 'fetch', batchId: String(batch.batchId) },
    });
    // A THROWING /results fetch (5xx / network) used to leave the batch in
    // waiting-* with no phase change and no attempt++, so it could hang forever
    // past BATCH_STALE_MS and MAX_BATCH_ATTEMPTS — only recover()'s 24h
    // RUN_ABANDON ever freed it (this wedged a production device). Apply the
    // SAME staleness bound the pending case uses: once the batch has been
    // waiting past BATCH_STALE_MS, requeue-or-fail it so the run can progress.
    const age = Date.now() - (batch.submittedAt ?? 0);
    if (age > BATCH_STALE_MS) {
      logger.warn(
        `${TAG} batch ${batch.batchId} fetch threw + waiting ${Math.round(age / 1000)}s — stale, requeue/fail`,
      );
      await requeueWaitingOrFail(batch, 'stale', context);
    }
    return;
  }

  if (res === 'pending') {
    const age = Date.now() - (batch.submittedAt ?? 0);
    if (age > BATCH_STALE_MS) {
      logger.warn(
        `${TAG} batch ${batch.batchId} pending ${Math.round(age / 1000)}s — stale, requeue/fail`,
      );
      await requeueWaitingOrFail(batch, 'stale', context);
    }
    return;
  }
  if (res === 'not-found' || res === 'unauthorized') {
    logger.warn(`${TAG} batch ${batch.batchId} fetch → ${res}`);
    await requeueWaitingOrFail(batch, res, context);
    return;
  }

  try {
    if (batch.phase === 'waiting-relevance') {
      await handleRelevanceResults(batch, res, context);
    } else if (batch.phase === 'waiting-reasons') {
      await handleReasonResults(batch, res, context);
    }
  } catch (err) {
    logger.captureException(err, {
      tags: { service: 'scoring-pipeline', step: 'apply', batchId: String(batch.batchId) },
    });
    // A throw in the apply step (e.g. a decode/save racing a row deleted
    // underneath the batch) used to leave the batch in waiting-* with no
    // attempt++ and no terminal transition, so the 7s poller re-fetched the SAME
    // server-cached results and re-threw on the same id every tick for up to
    // RUN_ABANDON_MS (24h) — a production wedge (MERA-APP-53/55, one device
    // looping). Attempt-cap it through the shared requeue/fail path: the batch
    // requeues (relevance→queued, reasons→needs-reasons-submit) until it exhausts
    // MAX_BATCH_ATTEMPTS, then goes terminal — so captureException fires at most
    // MAX_BATCH_ATTEMPTS times per batch instead of forever. If the handler had
    // already advanced the batch past `batch.phase` before throwing (progress was
    // made), requeueWaitingOrFail's guarded CAS no-ops and nothing is double-failed.
    await requeueWaitingOrFail(batch, 'attempts-exhausted', context);
  }
}

async function decodeBatch(
  batch: PipelineBatch,
  server: ServerResults,
): Promise<{ batchResults: BatchCompletionResult[] }> {
  const snap = await getPipeline();
  const privKeyHex = snap?.privKeyHex ?? '';
  const algo = snap?.run.algo ?? 'ed25519';
  const privKey = hexToBytes(privKeyHex);
  const batchResults = server.results.map((r) =>
    toBatchResult(r, privKey, algo),
  );
  return { batchResults };
}

/**
 * Decode a JUDGE-MODE batch (Round-3 B1 — the ADVISORY judge+notes job).
 *
 * The relevance was already persisted at SUBMIT (the math is the authority —
 * Part A). The judge is advisory: this pass ONLY writes the notes it returned
 * (reason_pending → complete) and captures math-vs-judge disagreements as
 * CalibrationCases so the calibration loop keeps learning (the cloud path
 * previously did NOT feed it — the gap Part A flagged). It then terminates the
 * batch and runs the low-relevance discard. No relevance re-persist, no sibling
 * propagation (both happened at submit).
 */
async function handleJudgeResults(
  batch: PipelineBatch,
  server: ServerResults,
  context: ExecutionContext,
): Promise<void> {
  const { batchResults } = await decodeBatch(batch, server);

  // Decode against the same calibration-overrides-aware config the submit path
  // built with. judgeChunkSize must equal the submit-time value for the chunk
  // rebuild — articlePipeline is never override-tunable, so this holds.
  const judgeConfig = await judgeHarnessConfig();

  // Rebuild chunkIds from judgedIds — the ABOVE-THRESHOLD subset buildJudgeCalls
  // chunked at submit (NOT candidateIds, which also covers the sub-threshold
  // rows that were never sent to the judge).
  const judgedIds = batch.judgedIds ?? [];
  const size = judgeConfig.articlePipeline.judgeChunkSize;
  const judgeChunkIds = new Map<string, string[]>();
  chunkIds(judgedIds, size).forEach((ids, i) => {
    judgeChunkIds.set(`judge:${i}`, ids);
  });

  // Computed (math) scores of the judged subset carried at submit. rawScoreMap
  // (== computed, Part A) is IGNORED for scoring; judgeScoreMap + overrideMap
  // feed calibration; reasonMap carries the notes.
  const computedScoreMap = new Map<string, number>(
    Object.entries(batch.rawRelevanceMap ?? {}),
  );

  const { reasonMap, judgeScoreMap, overrideMap } = decodeJudgeResults(
    batchResults,
    judgeChunkIds,
    computedScoreMap,
    judgeConfig,
    undefined,
  );

  // Apply the notes: reason present → the row completes; absent rows stay
  // reason_pending (the orphan-reasons sweep re-attempts them).
  for (const [id, reason] of reasonMap) {
    if (!reason) continue;
    try {
      await saveReason(id, reason);
    } catch (err) {
      if (isRecordNotFoundError(err)) continue;
      logger.captureException(err, {
        tags: { service: 'scoring-pipeline', step: 'save-judge-note' },
        extra: { candidateId: id },
      });
    }
  }
  await refreshUi();

  // Calibration capture (Part A): for every id the judge overrode
  // (|judge − computed| > OVERRIDE_DELTA), build a CalibrationCase from the
  // persisted components + the advisory judge score and feed the loop. Off the
  // critical path (fire-and-forget); read only the overridden rows' components.
  const overriddenIds = [...overrideMap.keys()];
  if (overriddenIds.length > 0) {
    try {
      const compsById = await getComputedComponentsByIds(overriddenIds);
      const cases = [];
      for (const id of overriddenIds) {
        const computed = computedScoreMap.get(id);
        const judge = judgeScoreMap.get(id);
        const entry = compsById.get(id);
        if (computed === undefined || judge === undefined || !entry) continue;
        cases.push(buildCalibrationCase(id, computed, judge, entry.components));
      }
      if (cases.length > 0) {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { recordOverrides } = require('@/lib/database/services/calibration-service') as typeof import('@/lib/database/services/calibration-service');
        void recordOverrides(cases).catch((err: unknown) => {
          logger.captureException(err, {
            tags: { service: 'scoring-pipeline', step: 'record-overrides' },
          });
        });
      }
    } catch (err) {
      logger.captureException(err, {
        tags: { service: 'scoring-pipeline', step: 'calibration-capture' },
      });
    }
  }

  logger.info(
    `${TAG} batch ${batch.batchId} judge notes decoded: notes=${reasonMap.size} overrides=${overriddenIds.length}`,
  );

  // Advisory judge carries only notes → NO reasons sub-phase. Terminate the
  // batch, discard sub-gate rows (relevance persisted at submit), finalize.
  await markBatchDone(batch.batchId);
  const discarded = await discardLowRelevance(
    batch.candidateIds,
    batch.relevanceMap ?? {},
  );
  if (discarded > 0) await refreshUi();
  await afterTerminal(context);
}

async function handleRelevanceResults(
  batch: PipelineBatch,
  server: ServerResults,
  context: ExecutionContext,
): Promise<void> {
  // Judge-mode batches carry the combined judge+reason result — decode + save +
  // terminate in one pass (no reasons sub-phase). Backstop/legacy batches fall
  // through to the tiered relevance→reasons flow below.
  if (batch.judgeMode === true) {
    await handleJudgeResults(batch, server, context);
    return;
  }

  const { batchResults } = await decodeBatch(batch, server);

  const nChunks = Math.max(
    1,
    Math.ceil(batch.candidateIds.length / CLOUD_SCORE_CHUNK_SIZE),
  );
  const callIds = Array.from({ length: nChunks }, (_, i) => `score:${i}`);
  const { chunkIdToCandidates } = reconstructLookups(
    callIds,
    batch.candidateIds,
  );

  const { scoreMap, failedIds } = decodeResults({
    batchResults,
    promptsById: new Map(),
    chunkIdToCandidates,
  });

  // (verifier pass removed — absorbed into the judge, Wave 7b M-P5)

  // Preserve raw pre-bucket scores for the reason prompts; storage + gating use
  // the bucketed values.
  const rawRelevanceMap: Record<string, number> = {};
  for (const [id, raw] of scoreMap) rawRelevanceMap[id] = raw;
  bucketScores(scoreMap);

  // DB writes FIRST (so the impactful subset query sees reason_pending rows),
  // then a single CAS storing the maps + next phase.
  const relevanceMap: Record<string, number> = {};
  for (const id of batch.candidateIds) {
    if (failedIds.has(id)) continue;
    const relevance = scoreMap.get(id);
    if (relevance === undefined) continue;
    relevanceMap[id] = relevance;
    try {
      await saveScoringResult(id, {
        relevance,
        reason: '',
        reasonSkipped: false,
      });
    } catch (err) {
      if (isRecordNotFoundError(err)) continue;
      logger.captureException(err, {
        tags: { service: 'scoring-pipeline', step: 'save-relevance' },
        extra: { candidateId: id },
      });
    }
  }
  await refreshUi();

  // The rows just scored are fresh donors — copy their scores onto any unscored
  // siblings (held-back same-sync duplicates from the feed-sync gate, or rows
  // stranded in a different clustering generation). Fail-open (returns 0) so a
  // propagation error never blocks the pipeline; refresh again only if it wrote.
  try {
    const inFlight = await getNonTerminalCandidateIds();
    const propagated = await propagateToUnscoredSiblings(inFlight);
    if (propagated > 0) await refreshUi();
  } catch (err) {
    logger.captureException(err, {
      tags: { service: 'scoring-pipeline', step: 'propagate-siblings' },
    });
  }

  const impactfulIds = Object.keys(relevanceMap).filter(
    (id) =>
      relevanceMap[id] > REASON_RELEVANCE_THRESHOLD &&
      (rawRelevanceMap[id] ?? 0) >= REASON_MIN_RAW_SCORE,
  );

  logger.info(
    `${TAG} batch ${batch.batchId} relevance decoded: scored=${Object.keys(relevanceMap).length} impactful=${impactfulIds.length}`,
  );

  if (impactfulIds.length === 0) {
    await mutatePipeline((run) => {
      const b = run.batches.find((x) => x.batchId === batch.batchId);
      if (!b || b.phase !== 'waiting-relevance') return null;
      b.relevanceMap = relevanceMap;
      b.rawRelevanceMap = rawRelevanceMap;
      b.reasonCandidateIds = [];
      b.phase = 'done';
      return true;
    });
    const discarded = await discardLowRelevance(
      batch.candidateIds,
      relevanceMap,
    );
    if (discarded > 0) await refreshUi();
    await afterTerminal(context);
    return;
  }

  await mutatePipeline((run) => {
    const b = run.batches.find((x) => x.batchId === batch.batchId);
    if (!b || b.phase !== 'waiting-relevance') return null;
    b.relevanceMap = relevanceMap;
    b.rawRelevanceMap = rawRelevanceMap;
    b.reasonCandidateIds = impactfulIds;
    b.phase = 'needs-reasons-submit';
    return true;
  });

  // Immediately try the reasons submit this cycle.
  await submitNeedsReasons(batch.batchId, context);
}

async function handleReasonResults(
  batch: PipelineBatch,
  server: ServerResults,
  context: ExecutionContext,
): Promise<void> {
  const { batchResults } = await decodeBatch(batch, server);
  const { reasonMap, failedIds } = decodeResults({
    batchResults,
    promptsById: new Map(),
    chunkIdToCandidates: new Map(),
  });

  for (const [id, reason] of reasonMap) {
    if (failedIds.has(id)) continue;
    try {
      await saveReason(id, reason);
    } catch (err) {
      if (isRecordNotFoundError(err)) continue;
      logger.captureException(err, {
        tags: { service: 'scoring-pipeline', step: 'save-reason' },
        extra: { candidateId: id },
      });
    }
  }

  const discarded = await discardLowRelevance(
    batch.candidateIds,
    batch.relevanceMap ?? {},
  );
  await refreshUi();
  if (discarded > 0) {
    logger.info(
      `${TAG} batch ${batch.batchId} discarded ${discarded} low-relevance rows`,
    );
  }

  await markBatchDone(batch.batchId);
  logger.info(`${TAG} batch ${batch.batchId} reasons done`);
  await afterTerminal(context);
}

// ---------------------------------------------------------------------------
// needs-reasons-submit → submit the impactful subset's reasons
// ---------------------------------------------------------------------------

async function submitNeedsReasons(
  batchId: number,
  context: ExecutionContext,
): Promise<void> {
  const snap = await getPipeline();
  if (!snap) return;
  const { run, privKeyHex } = snap;
  const batch = run.batches.find((b) => b.batchId === batchId);
  if (!batch || batch.phase !== 'needs-reasons-submit') return;

  const scored = await getScoredSuggestionsWithoutReasons();
  const idSet = new Set(batch.reasonCandidateIds ?? []);
  const subset: ScoringCandidate[] = scored.filter((c) => idSet.has(c.id));
  const bundle = await buildReasonCallsForSubset(
    subset,
    batch.rawRelevanceMap ?? {},
    REASON_RELEVANCE_THRESHOLD,
  );

  if (bundle.calls.length === 0) {
    // Every impactful row turned out ineligible for a reason — finish clean.
    await markBatchDone(batchId);
    const discarded = await discardLowRelevance(
      batch.candidateIds,
      batch.relevanceMap ?? {},
    );
    await refreshUi();
    if (discarded > 0) {
      logger.info(
        `${TAG} batch ${batchId} discarded ${discarded} low-relevance rows`,
      );
    }
    await afterTerminal(context);
    return;
  }

  // Rate-limiter admission for the follow-up POST.
  if (!gatewayRateLimiter.tryTakeImmediate()) {
    // No budget right now — leave it in needs-reasons-submit; the poller retries.
    return;
  }

  const claim = await mutatePipeline((r) => {
    const b = r.batches.find((x) => x.batchId === batchId);
    if (!b || b.phase !== 'needs-reasons-submit') return null;
    b.phase = 'submitting-reasons';
    b.submittedAt = Date.now();
    return true;
  });
  if (claim === 'aborted' || claim === 'no-run') return;

  const token = AppState.currentState !== 'active' ? run.expoPushToken : null;
  let ctx;
  try {
    ctx = await rebuildE2EEContext(SMALL_MODEL, privKeyHex, run.algo);
  } catch (err) {
    // Off-curve model attestation key (MERA-APP-39). The relevance scores are
    // already persisted, so mirror the reasons-submit hard-failure path: mark
    // the batch done (scores kept — orphaned-reasons recovery re-submits the
    // notes on a later run whose fresh attestation validates), NOT a poller
    // loop. Non-ModelKeyValidationError throws propagate unchanged.
    if (!(err instanceof ModelKeyValidationError)) throw err;
    logger.warn(
      `${TAG} batch ${batchId} reasons submit aborted — model key invalid (${err.message}); marking done (scores kept)`,
    );
    await markBatchDone(batchId);
    const discarded = await discardLowRelevance(
      batch.candidateIds,
      batch.relevanceMap ?? {},
    );
    await refreshUi();
    if (discarded > 0) {
      logger.info(
        `${TAG} batch ${batchId} discarded ${discarded} low-relevance rows`,
      );
    }
    await afterTerminal(context);
    return;
  }
  const reasonIds = bundle.eligibleCandidates.map((c) => c.id);
  logger.info(
    `${TAG} batch ${batchId} submit reasons: ${reasonIds.length} ids in ${bundle.calls.length} calls (token=${token ? 'yes' : 'no'})`,
  );
  const outcome = await sendInferenceRequest({
    bundle,
    ctx,
    token,
    model: SMALL_MODEL,
    context,
    // The batch's stored token is the completed relevance job's capability
    // token — its `jobs:submit-followup` scope authorizes this chained reasons
    // POST. Required in background (no keychain); harmless JWT-first fallback
    // in foreground.
    capabilityToken: batch.capabilityToken ?? null,
  });

  if (outcome.status === 'ok') {
    await transitionToWaitingReasons(batchId, outcome, reasonIds);
    logger.info(
      `${TAG} batch ${batchId} → waiting-reasons requestId=${outcome.requestId}`,
    );
  } else if (outcome.status === 'throttled') {
    // Stay in needs-reasons-submit — retried by the poller.
    await mutatePipeline((r) => {
      const b = r.batches.find((x) => x.batchId === batchId);
      if (!b || b.phase !== 'submitting-reasons') return null;
      b.phase = 'needs-reasons-submit';
      return true;
    });
  } else {
    // Reasons submit hard-failed — the scores are already saved, so mark the
    // batch done (NOT failed). Orphaned-reasons recovery picks the rows up next
    // sync.
    logger.warn(
      `${TAG} batch ${batchId} reasons submit failed — marking done (scores kept)`,
    );
    await markBatchDone(batchId);
    const discarded = await discardLowRelevance(
      batch.candidateIds,
      batch.relevanceMap ?? {},
    );
    await refreshUi();
    if (discarded > 0) {
      logger.info(
        `${TAG} batch ${batchId} discarded ${discarded} low-relevance rows`,
      );
    }
    await afterTerminal(context);
  }
}

// ---------------------------------------------------------------------------
// Requeue-or-fail a waiting-* batch (stale pending / 404 / 401)
// ---------------------------------------------------------------------------

async function requeueWaitingOrFail(
  batch: PipelineBatch,
  reason: 'stale' | 'not-found' | 'unauthorized' | 'attempts-exhausted',
  context: ExecutionContext,
): Promise<void> {
  const wasReasons = batch.phase === 'waiting-reasons';
  const mutated = await mutatePipeline((run) => {
    const b = run.batches.find((x) => x.batchId === batch.batchId);
    if (!b || b.phase !== batch.phase) return null;
    b.attempt = b.attempt + 1;
    if (b.attempt >= MAX_BATCH_ATTEMPTS) {
      b.phase = 'failed';
      b.failureReason = reason;
    } else {
      // Relevance batch resubmits from scratch (queued); reasons batch re-enters
      // the follow-up submit.
      b.phase = wasReasons ? 'needs-reasons-submit' : 'queued';
    }
    return true;
  });
  if (mutated === 'aborted' || mutated === 'no-run') return;

  // Re-read to see whether it became terminal.
  const snap = await getPipeline();
  const b = snap?.run.batches.find((x) => x.batchId === batch.batchId);
  if (b && b.phase === 'failed') {
    if (wasReasons) {
      // Scores are live: mark the impactful subset reason-skipped so the UI
      // stops spinning, run the batch-scoped discard, refresh, then treat as
      // terminal.
      if (b.reasonCandidateIds && b.reasonCandidateIds.length > 0) {
        await batchMarkReasonSkipped(b.reasonCandidateIds).catch(
          (err: unknown) => {
            logger.warn(
              `${TAG} batch ${batch.batchId} batchMarkReasonSkipped failed: ${String(err)}`,
            );
          },
        );
      }
      const discarded = await discardLowRelevance(
        b.candidateIds,
        b.relevanceMap ?? {},
      );
      await refreshUi();
      if (discarded > 0) {
        logger.info(
          `${TAG} batch ${batch.batchId} discarded ${discarded} low-relevance rows`,
        );
      }
    }
    // Relevance batch failure persists NOTHING — rows stay relevance NULL and
    // re-enter the next run.
    await afterTerminal(context);
  } else {
    // Requeued (not terminal): keep the pipeline moving.
    await drain(context);
    ensurePoller();
  }
}

// ---------------------------------------------------------------------------
// After a terminal transition — admit next + finalize if all terminal
// ---------------------------------------------------------------------------

/**
 * Run after a terminal transition that happened OUTSIDE the drain loop
 * (checkBatch / submitNeedsReasons / requeueWaitingOrFail). Starts a fresh
 * drain — which admits the next queued batch and, at its tail, finalizes the
 * run if everything is now terminal. Safe here because none of these callers
 * are on doDrain's stack.
 */
async function afterTerminal(context: ExecutionContext): Promise<void> {
  await drain(context);
}

async function finalize(run: PipelineRun): Promise<void> {
  if (finalizeInFlight) return finalizeInFlight;
  finalizeInFlight = doFinalize(run).finally(() => {
    finalizeInFlight = null;
  });
  return finalizeInFlight;
}

async function doFinalize(run: PipelineRun): Promise<void> {
  // Re-read to guard exactly-once under concurrency: if the run is already
  // gone, another finalize won.
  const snap = await getPipeline();
  if (!snap) return;
  if (!snap.run.batches.every((b) => isTerminal(b.phase))) return;

  logger.info(`${TAG} finalize run ${run.runId} (${run.batches.length} batches)`);

  await refreshUi();
  await clearPipeline();
  stopPoller();

  // Stamp the "last finished processing run" timestamp — cloud runs previously
  // never did this (only the on-device path in SuggestionSyncService did), so
  // the header's "updated X ago" stayed stale after a cloud run. Lazy-require
  // (like pushUiProgress) to avoid a load-time import cycle.
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { useForYouStore } = require('@/lib/stores/for-you-store') as typeof import('@/lib/stores/for-you-store');
    useForYouStore.getState().markProcessingRunFinished();
  } catch (err) {
    logger.captureException(err, {
      tags: { service: 'scoring-pipeline', step: 'finalize-mark-finished' },
    });
  }

  // Post-finalize kick: if a full quantum of unscored rows still remains (or the
  // staleness escape applies), start the next run right away instead of waiting
  // for the next discovery tick. Scheduled as a macrotask so it runs after this
  // finalize (and any outer drain) has settled.
  schedulePostFinalizeKick();
}

/** Schedule a one-shot post-finalize kick (idempotent while pending). Runs on a
 *  fresh macrotask so the drain/finalize single-flights are clear before it
 *  re-enters the enqueue path. */
function schedulePostFinalizeKick(): void {
  if (postFinalizeKickTimer) return;
  postFinalizeKickTimer = setTimeout(() => {
    postFinalizeKickTimer = null;
    void runPostFinalizeKick();
  }, 0);
}

/** Gather the still-unscored eligible rows and re-enqueue them. enqueueCandidates
 *  itself applies the strict quantum gate, so this dispatches a fresh run only
 *  when ≥ BATCH_SIZE remain (or the staleness escape fires). */
async function runPostFinalizeKick(): Promise<void> {
  try {
    // A concurrent trigger (feed-sync / scoring-pass) may already have started a
    // run between finalize and now — enqueueCandidates dedups + gates, so this
    // is safe either way.
    const candidates = await getUnscoredSuggestionsWithFacts();
    const eligibleIds = candidates
      .filter((c) => c.titleEn && c.descriptionEn && c.relatedFacts.length > 0)
      .map((c) => c.id);
    if (eligibleIds.length === 0) return;
    await enqueueCandidates(eligibleIds);
  } catch (err) {
    logger.captureException(err, {
      tags: { service: 'scoring-pipeline', step: 'post-finalize-kick' },
    });
  }
}

// ---------------------------------------------------------------------------
// Poll tick — the recurring driver
// ---------------------------------------------------------------------------

export async function pollTick(context: ExecutionContext): Promise<void> {
  const snap = await getPipeline();
  if (!snap) return;
  const { run } = snap;
  const now = Date.now();

  // 1. Revert submitting-* batches stuck past SUBMIT_STUCK_MS (an interrupted
  //    submit) back to queued (attempt+1).
  await revertStuckSubmitters(run, now);

  // 2. Attempt any needs-reasons-submit batches' follow-up submit.
  for (const b of run.batches) {
    if (b.phase === 'needs-reasons-submit') {
      await submitNeedsReasons(b.batchId, context);
    }
  }

  // 3. Poll waiting-* batches, oldest submittedAt first, honoring poll-age and
  //    per-batch spacing and the rate-limiter budget.
  const fresh = await getPipeline();
  if (!fresh) return;
  const waiting = fresh.run.batches
    .filter((b) => isWaiting(b.phase))
    .sort((a, b) => (a.submittedAt ?? 0) - (b.submittedAt ?? 0));

  // Knob 2 (P7d): on a COLD feed the first scored paint waits on the first
  // poll, so relax the poll-age gate and per-batch spacing to the poller's own
  // tick cadence (POLL_INTERVAL_MS, 7s) instead of the warm 15s min-age / 20s
  // spacing — a batch that finished fast is picked up on the very next tick
  // rather than one or two ticks later. Derived from the tick cadence (no point
  // gating tighter than the poller can fire); the rate limiter still applies and
  // the window ends the moment the first batch completes (warm thereafter).
  // Computed once per tick.
  const cold = await isFeedCold();
  const minPollAge = cold ? POLL_INTERVAL_MS : MIN_POLL_AGE_MS;
  const pollSpacing = cold ? POLL_INTERVAL_MS : PER_BATCH_POLL_SPACING_MS;

  const cap = context === 'background' ? 3 : Infinity;
  let polled = 0;
  for (const b of waiting) {
    if (polled >= cap) break;
    const nowTick = Date.now();
    if (nowTick - (b.submittedAt ?? 0) < minPollAge) continue;
    if (nowTick - (lastPolledAt.get(b.batchId) ?? 0) < pollSpacing)
      continue;
    if (!gatewayRateLimiter.tryTakeImmediate()) break;
    lastPolledAt.set(b.batchId, nowTick);
    await checkBatch(b, context);
    polled += 1;
  }
}

async function revertStuckSubmitters(
  run: PipelineRun,
  now: number,
): Promise<void> {
  for (const b of run.batches) {
    if (
      b.phase !== 'submitting-relevance' &&
      b.phase !== 'submitting-reasons'
    ) {
      continue;
    }
    if (now - (b.submittedAt ?? 0) <= SUBMIT_STUCK_MS) continue;
    const fromPhase = b.phase;
    logger.warn(
      `${TAG} batch ${b.batchId} stuck in ${fromPhase} — reverting to queued (attempt+1)`,
    );
    await mutatePipeline((r) => {
      const cur = r.batches.find((x) => x.batchId === b.batchId);
      if (!cur || cur.phase !== fromPhase) return null;
      cur.attempt = cur.attempt + 1;
      // A stuck submitting-reasons on a RELEVANCE batch (relevance already
      // saved, not reasonsOnly) must go back to needs-reasons-submit — sending
      // it to queued would make drain redo relevance scoring. Everything else
      // (submitting-relevance, or a reasonsOnly submit) requeues from scratch.
      cur.phase =
        fromPhase === 'submitting-reasons' && !cur.reasonsOnly
          ? 'needs-reasons-submit'
          : 'queued';
      return true;
    });
  }
}

// ---------------------------------------------------------------------------
// Push + recover
// ---------------------------------------------------------------------------

export async function handlePush(
  requestId: string | undefined,
  context: 'foreground' | 'background',
): Promise<void> {
  if (requestId) {
    const snap = await getPipeline();
    if (!snap) return;
    const batch = snap.run.batches.find(
      (b) => b.requestId === requestId && isWaiting(b.phase),
    );
    if (batch) {
      await checkBatch(batch, context);
      return;
    }
    // Unknown/stale requestId — fall through to a general tick.
  }
  await pollTick(context);
}

/**
 * Force-fail every non-terminal batch of the current run, then finalize it.
 * `finalize` (via doFinalize) refreshes the UI, clears the pipeline, stops the
 * poller, and stamps markProcessingRunFinished — so this is the complete
 * "abandon the run cleanly" primitive. No-op if no run exists.
 *
 * Shared by recover()'s RUN_ABANDON path and abortRun() so the force-fail →
 * finalize sequence lives in exactly one place.
 */
async function forceFailNonTerminalAndFinalize(): Promise<void> {
  await mutatePipeline((r) => {
    for (const b of r.batches) {
      if (!isTerminal(b.phase)) {
        b.phase = 'failed';
        b.failureReason = 'stale';
      }
    }
    return true;
  });
  const after = await getPipeline();
  if (after) await finalize(after.run);
}

/**
 * Force-clear the current scoring run — the deadlock escape hatch used when the
 * feed cache is wiped (ManageData) or a wedged 'running' run must be released so
 * feed-sync can resume (FeedSyncMachine's stale-guard). Reuses recover()'s
 * abandon primitive: force-fail every non-terminal batch → finalize (which
 * stamps markProcessingRunFinished + clears the pipeline).
 *
 * When no run exists it still stamps a bare clearPipeline() +
 * markProcessingRunFinished() so `lastProcessingRunFinishedAt` is ALWAYS set —
 * otherwise the FeedPreparingCard keeps spinning on a null timestamp.
 */
export async function abortRun(reason: string): Promise<void> {
  logger.warn(`${TAG} abortRun(${reason})`);
  const snap = await getPipeline();
  if (snap) {
    await forceFailNonTerminalAndFinalize();
    return;
  }
  // No run to finalize — clear anything left and stamp the finished timestamp
  // directly (only finalize/markProcessingRunFinished ever sets it, and the UI
  // gates the preparing card on it being non-null).
  await clearPipeline();
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { useForYouStore } = require('@/lib/stores/for-you-store') as typeof import('@/lib/stores/for-you-store');
    useForYouStore.getState().markProcessingRunFinished();
  } catch (err) {
    logger.captureException(err, {
      tags: { service: 'scoring-pipeline', step: 'abort-mark-finished' },
    });
  }
}

export async function recover(): Promise<'idle' | 'running'> {
  const snap = await getPipeline();
  if (!snap) return 'idle';
  const { run } = snap;

  if (Date.now() - run.startedAt > RUN_ABANDON_MS) {
    logger.warn(
      `${TAG} run ${run.runId} older than ${RUN_ABANDON_MS}ms — abandoning`,
    );
    await forceFailNonTerminalAndFinalize();
    return 'idle';
  }

  await revertStuckSubmitters(run, Date.now());
  ensurePoller();
  await drain('foreground');
  await pollTick('foreground');
  return 'running';
}

export async function getPipelineStatus(): Promise<'idle' | 'running'> {
  const snap = await getPipeline();
  if (!snap) return 'idle';
  return snap.run.batches.some((b) => !isTerminal(b.phase)) ? 'running' : 'idle';
}

/** The current run's `startedAt` epoch-ms, or null when no run exists. Exposed
 *  for the FeedSyncMachine stale-guard, which needs the run's age to decide
 *  whether a 'running' pipeline is wedged (getPipelineStatus returns only the
 *  coarse idle/running string). */
export async function getRunStartedAt(): Promise<number | null> {
  const snap = await getPipeline();
  return snap ? snap.run.startedAt : null;
}

// ---------------------------------------------------------------------------
// Foreground poller — interval alive only while a run has non-terminal batches
// AND AppState is active.
// ---------------------------------------------------------------------------

function ensurePoller(): void {
  if (!appStateSub) {
    appStateSub = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        startPollerTimer();
      } else {
        stopPollerTimer();
      }
    });
  }
  if (AppState.currentState === 'active') startPollerTimer();
}

function startPollerTimer(): void {
  if (pollerTimer) return;
  pollerTimer = setInterval(() => {
    void runPollerTick();
  }, POLL_INTERVAL_MS);
}

function stopPollerTimer(): void {
  if (pollerTimer) {
    clearInterval(pollerTimer);
    pollerTimer = null;
  }
}

function stopPoller(): void {
  stopPollerTimer();
  if (appStateSub) {
    appStateSub.remove();
    appStateSub = null;
  }
}

async function runPollerTick(): Promise<void> {
  if (pollTickRunning) return;
  pollTickRunning = true;
  try {
    const status = await getPipelineStatus();
    if (status === 'idle') {
      stopPoller();
      return;
    }
    if (AppState.currentState !== 'active') {
      stopPollerTimer();
      return;
    }
    await pollTick('foreground');
    await drain('foreground');
  } catch (err) {
    logger.captureException(err, {
      tags: { service: 'scoring-pipeline', step: 'poller-tick' },
    });
  } finally {
    pollTickRunning = false;
  }
}

// ---------------------------------------------------------------------------
// Test hooks
// ---------------------------------------------------------------------------

export function _resetForTests(): void {
  drainInFlight = null;
  finalizeInFlight = null;
  lastPolledAt.clear();
  pollTickRunning = false;
  feedWarmCached = false;
  if (postFinalizeKickTimer) {
    clearTimeout(postFinalizeKickTimer);
    postFinalizeKickTimer = null;
  }
  if (pollerTimer) {
    clearInterval(pollerTimer);
    pollerTimer = null;
  }
  if (appStateSub) {
    appStateSub.remove();
    appStateSub = null;
  }
}
