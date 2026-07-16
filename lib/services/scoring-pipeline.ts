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
  prepareE2EEContext,
  rebuildE2EEContext,
} from '@/lib/e2ee/e2ee-service';
import {
  countUnscoredSuggestions,
  getOldestUnscoredCreatedAt,
  getScoredSuggestionsWithoutReasons,
  getUnscoredSuggestionsWithFacts,
  saveReason,
  saveScoringResult,
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
} from '@/lib/mera-protocol/scoring-service';
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

const TAG = '[scoring-pipeline]';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const BATCH_SIZE = 25;
export const MAX_IN_FLIGHT = 3;
/** Minimum accumulated unscored count before a fresh run is created — below
 *  this, every enqueue would pay full run overhead (E2EE keypair mint, run
 *  lifecycle, foreground poller) for a trickle. See MAX_UNSCORED_WAIT_MS for
 *  the escape that prevents this from hiding news indefinitely. */
export const MIN_RUN_CANDIDATES = 25;
/** Escape hatch: if the oldest unscored row has been waiting this long, start
 *  a run anyway even below MIN_RUN_CANDIDATES — unscored articles don't
 *  render, so a strict count gate could hide news for hours on slow days. */
export const MAX_UNSCORED_WAIT_MS = 30 * 60_000;
const SUBMIT_STUCK_MS = 60_000;
const BATCH_STALE_MS = 15 * 60_000;
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
// Last poll timestamp per batchId — enforces PER_BATCH_POLL_SPACING_MS. Kept in
// memory (not persisted) so a fresh process simply re-polls.
const lastPolledAt = new Map<number, number>();

let pollerTimer: ReturnType<typeof setInterval> | null = null;
let appStateSub: { remove: () => void } | null = null;
let pollTickRunning = false;

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

function nonTerminalCandidateIds(run: PipelineRun): Set<string> {
  const s = new Set<string>();
  for (const b of run.batches) {
    if (isTerminal(b.phase)) continue;
    for (const id of b.candidateIds) s.add(id);
  }
  return s;
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

/** Best-effort push of the derived phase + progress into the For-You header
 *  store. Lazily-required (like refreshUi) to avoid a load-time import cycle. */
async function pushUiProgress(): Promise<void> {
  try {
    const ui = await getPipelineUiState();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { useForYouStore } = require('@/lib/stores/for-you-store') as typeof import('@/lib/stores/for-you-store');
    if (ui.phase === 'idle') {
      useForYouStore.getState().setAsyncJobPhase('idle');
    } else {
      useForYouStore
        .getState()
        .setAsyncJobPhase(ui.phase, ui.processedCount, ui.totalCount);
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
 * Add fresh unscored candidate ids into the pipeline as ≤25-article relevance
 * batches. Feed-sync re-fires this every ~10s, so ids already present in a
 * non-terminal batch are deduped out. Creates the run (minting the E2EE
 * keypair) if none exists, else appends.
 */
export async function enqueueCandidates(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const snap = await getPipeline();

  const existing = snap ? nonTerminalCandidateIds(snap.run) : new Set<string>();
  const fresh = ids.filter((id) => !existing.has(id));
  if (fresh.length === 0) {
    if (snap) {
      await drain('foreground');
      ensurePoller();
    }
    return;
  }

  // Gate RUN CREATION only — appending to an already-running run is unchanged
  // (that run is already paying its overhead). Below MIN_RUN_CANDIDATES total
  // accumulated unscored rows, defer creating a run unless the oldest unscored
  // row has aged past MAX_UNSCORED_WAIT_MS (escape so a slow trickle can't
  // hide news for hours). Rows stay `unscored` and re-enter the next cycle.
  if (!snap) {
    const totalUnscored = await countUnscoredSuggestions();
    if (totalUnscored < MIN_RUN_CANDIDATES) {
      const oldestCreatedAt = await getOldestUnscoredCreatedAt();
      const oldestAgeMs =
        oldestCreatedAt !== null ? Date.now() - oldestCreatedAt : 0;
      if (oldestCreatedAt === null || oldestAgeMs < MAX_UNSCORED_WAIT_MS) {
        logger.info(
          `${TAG} enqueueCandidates: deferred: ${totalUnscored}/${MIN_RUN_CANDIDATES} unscored, oldest ${Math.round(oldestAgeMs / 60_000)}min`,
        );
        return;
      }
      logger.info(
        `${TAG} enqueueCandidates: min-run escape: oldest unscored waited ${Math.round(oldestAgeMs / 60_000)}min`,
      );
    }
  }

  const chunks = chunkIds(fresh, BATCH_SIZE);
  logger.info(
    `${TAG} enqueueCandidates: ${fresh.length} fresh ids → ${chunks.length} batch(es) (run ${snap ? 'exists' : 'new'})`,
  );

  if (!snap) {
    await createRunWithBatches((base) =>
      chunks.map((c, i) => makeQueuedBatch(base + i, c)),
    );
  } else {
    await appendBatches((base) =>
      chunks.map((c, i) => makeQueuedBatch(base + i, c)),
    );
  }

  await drain('foreground');
  ensurePoller();
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

  if (batch.reasonsOnly) {
    await doSubmitReasonsOnly(run, batch, privKeyHex, context);
    return;
  }
  await doSubmitRelevance(run, batch, privKeyHex, context);
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
  const bundle = await buildRelevanceCalls(subset);
  if (bundle.calls.length === 0 || bundle.eligibleCandidates.length === 0) {
    logger.info(
      `${TAG} batch ${batch.batchId} relevance bundle empty — marking done`,
    );
    // Terminal transition inside the drain loop; doDrain's maybeFinalize handles
    // the run finalize (calling afterTerminal here would re-enter drain).
    await markBatchDone(batch.batchId);
    return;
  }
  const eligibleIds = bundle.eligibleCandidates.map((c) => c.id);

  // Push-token policy (a): attach the run's token only when this is the LAST
  // relevance-needing batch — no other relevance batch is queued or submitting.
  const otherRelevancePending = run.batches.some(
    (b) =>
      b.batchId !== batch.batchId &&
      !b.reasonsOnly &&
      (b.phase === 'queued' || b.phase === 'submitting-relevance'),
  );
  const token = otherRelevancePending ? null : run.expoPushToken;

  const ctx = await rebuildE2EEContext(SMALL_MODEL, privKeyHex, run.algo);
  logger.info(
    `${TAG} batch ${batch.batchId} submit relevance: ${eligibleIds.length} ids in ${bundle.calls.length} calls (token=${token ? 'yes' : 'no'})`,
  );
  const outcome = await sendInferenceRequest({
    bundle,
    ctx,
    token,
    model: SMALL_MODEL,
    context,
  });

  if (outcome.status === 'ok') {
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
): Promise<void> {
  await mutatePipeline((run) => {
    const b = run.batches.find((x) => x.batchId === batchId);
    if (!b || b.phase !== 'submitting-relevance') return null;
    b.phase = 'waiting-relevance';
    b.requestId = outcome.requestId;
    b.capabilityToken = outcome.capabilityToken || undefined;
    b.candidateIds = eligibleIds; // eligible/submit order = decode join key
    b.submittedAt = Date.now();
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

async function handleRelevanceResults(
  batch: PipelineBatch,
  server: ServerResults,
  context: ExecutionContext,
): Promise<void> {
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
  const ctx = await rebuildE2EEContext(SMALL_MODEL, privKeyHex, run.algo);
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
  reason: 'stale' | 'not-found' | 'unauthorized',
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

  const cap = context === 'background' ? 3 : Infinity;
  let polled = 0;
  for (const b of waiting) {
    if (polled >= cap) break;
    const nowTick = Date.now();
    if (nowTick - (b.submittedAt ?? 0) < MIN_POLL_AGE_MS) continue;
    if (nowTick - (lastPolledAt.get(b.batchId) ?? 0) < PER_BATCH_POLL_SPACING_MS)
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

export async function recover(): Promise<'idle' | 'running'> {
  const snap = await getPipeline();
  if (!snap) return 'idle';
  const { run } = snap;

  if (Date.now() - run.startedAt > RUN_ABANDON_MS) {
    logger.warn(
      `${TAG} run ${run.runId} older than ${RUN_ABANDON_MS}ms — abandoning`,
    );
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
  if (pollerTimer) {
    clearInterval(pollerTimer);
    pollerTimer = null;
  }
  if (appStateSub) {
    appStateSub.remove();
    appStateSub = null;
  }
}
