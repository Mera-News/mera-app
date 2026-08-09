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
import * as coldstartTimeline from '@/lib/diagnostics/coldstart-timeline';
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
  batchMarkExcluded,
  batchMarkGateSkipped,
  batchMarkReasonSkipped,
  getStageRowsByIds,
  type ScoringCandidate,
} from '@/lib/database/services/article-suggestion-service';
// Imported from the harness DIRECTLY (not via the mera-protocol shim): this is
// the one definition of "headline-sourced", shared with the prompt/chunk-size
// selection the shim's builders run.
import {
  isHeadlineScope,
  isScorableCandidate,
  // The NOTE pass's keep/demote RULES (`legacyNoteDemote`). Pure and shared, so
  // the pipeline and the offline goldset replay decide identically.
  decodeV3NoteResults,
} from '@/lib/news-harness/article-pipeline/scoring';
// The one definition of "this headline scored too low to exist" — expressed over
// relevanceBandRank so the cull can never disagree with the band a card prints.
import { isCulledHeadlineRelevance } from '@/lib/feed-ordering/importance-filter';
import {
  bucketScores,
  buildReasonCallsForSubset,
  buildRelevanceCalls,
  decodeResults,
  CLOUD_SCORE_CHUNK_SIZE,
  REASON_MIN_RAW_SCORE,
} from '@/lib/mera-protocol/scoring-service';
import { computeMathStage, effectiveHarnessConfig } from '@/lib/mera-protocol/stage-scoring';
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
import {
  gateUnscoredForScoring,
  propagateToUnscoredSiblings,
} from '@/lib/feed-grouping/score-propagation';
// The cold-start predicate reuses the SAME 48h donor lookback the score
// propagation uses — a table with zero scored donors in that window is exactly
// a "cold" feed (no scores to render, no siblings to propagate from).
import { SCORE_PROPAGATION_LOOKBACK_MS } from '@/lib/feed-grouping/story-grouping';

const TAG = '[scoring-pipeline]';

// Cloud scoring dispatches FIFO batches of eligible candidates in delivery
// order. The former per-fact batch grouping (factId/factStatement) is gone;
// factId/factStatement remain OPTIONAL persisted fields (always null for new
// batches) only so a run persisted by an older build still parses.
//
// Sizing rule (supersedes the Round-4 B "strict 25-article quanta"): dispatch as
// soon as MIN_DISPATCH articles are ready, and let the batch absorb everything
// else that is ready, up to MAX_BATCH_ARTICLES. The old rule dispatched only
// FULL 25-quanta, which meant a user with a handful of fresh articles waited out
// the 30-minute staleness escape to see anything — the common case on a quiet
// feed, and the one the "4 articles were analysed for you" report came from.

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Dispatch floor: enough articles to be worth a round trip. Exactly one cloud
 *  scoring chunk (CLOUD_SCORE_CHUNK_SIZE = articlesPerScorePrompt), i.e. ONE LLM
 *  call, so the smallest thing we ever send is also the cheapest useful thing. */
export const MIN_DISPATCH = CLOUD_SCORE_CHUNK_SIZE;
/** Safety ceiling on a single batch. A batch becomes one HTTP job carrying
 *  ceil(n / CLOUD_SCORE_CHUNK_SIZE) LLM calls, so this caps a backlog burst at
 *  10 calls per request rather than letting a 500-row backlog build one enormous
 *  job that risks the gateway's 120s upstream timeout. Overflow spills into
 *  further batches, which drain MAX_IN_FLIGHT at a time. */
export const MAX_BATCH_ARTICLES = 10 * CLOUD_SCORE_CHUNK_SIZE;
/** P4b — TOP-HEADLINE relevance chunk size (3). Read off the harness config
 *  rather than the mera-protocol shim so it can't come back undefined and turn
 *  the two constants below into NaN. */
const HEADLINE_SCORE_CHUNK_SIZE =
  DEFAULT_HARNESS_CONFIG.articlePipeline.headlineArticlesPerScorePrompt;
/** Dispatch floor for an all-headline batch. Same rule as MIN_DISPATCH — one
 *  LLM call's worth — at the headline chunk size, so a handful of headlines
 *  isn't held back below a floor sized for the longer standard chunk. */
export const MIN_DISPATCH_HEADLINE = HEADLINE_SCORE_CHUNK_SIZE;
/** Ceiling for an all-headline batch. Same rule as MAX_BATCH_ARTICLES — at most
 *  10 LLM calls in one request — at the headline chunk size. Reusing the
 *  standard 50 here would put 17 calls in one job and break the invariant that
 *  constant exists to hold. */
export const MAX_BATCH_ARTICLES_HEADLINE = 10 * HEADLINE_SCORE_CHUNK_SIZE;
/** Legacy alias, kept exported for back-compat with older persisted-run readers
 *  and tests. Points at the dispatch floor, which is what now gates a run. */
export const BATCH_SIZE = MIN_DISPATCH;
export const MAX_IN_FLIGHT = 3;
/** @deprecated Legacy alias for the dispatch floor. Use MIN_DISPATCH. */
export const MIN_RUN_CANDIDATES = MIN_DISPATCH;
/** Escape hatch: if the oldest unscored row has been waiting this long, dispatch
 *  the sub-MIN_DISPATCH remainder too — unscored articles don't render, so the
 *  floor could otherwise hide a 1-4 article day indefinitely. */
export const MAX_UNSCORED_WAIT_MS = 30 * 60_000;
const SUBMIT_STUCK_MS = 60_000;
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
const MAX_BATCH_ATTEMPTS = 2;
/** Consecutive poller-tick throws before the run is abandoned outright. The one
 *  behaviour-risky knob in the unwedge work — exported so a hotfix OTA can raise
 *  it if it turns out to abandon runs that would have recovered. */
export const POLLER_FAILURE_ABORT_THRESHOLD = 3;
const RUN_ABANDON_MS = 24 * 3600_000;
/** Poller tick cadence while a run is active.
 *
 *  Derived from the gateway rate limiter rather than hard-coded: that limiter
 *  (MIN_GATEWAY_INTERVAL_MS, shared by submits AND polls) is what actually paces
 *  us, so the real polling cadence is its interval — 3s — no matter what we put
 *  here. Ticking is only how we notice a slot has freed.
 *
 *  The lead matters. Ticking at EXACTLY the limiter interval works right up
 *  until a submit takes a slot between two ticks: from then on every tick lands
 *  a hair before `nextGrantAt`, `tryTakeImmediate()` returns false, and the poll
 *  slips a whole interval — a permanent 2x slowdown with nothing to resync it.
 *  Leading slightly means a missed tick is retried a fraction of a second later
 *  instead of a full interval later, so the poller re-locks onto the limiter on
 *  its own. A tick that can't take a slot is a cheap no-op, so the lead costs
 *  nothing. */
const POLL_TICK_LEAD_MS = 250;
const POLL_INTERVAL_MS =
  gatewayRateLimiter.MIN_GATEWAY_INTERVAL_MS - POLL_TICK_LEAD_MS;
/** No settling delay before a batch's first poll. This used to be 15s on the
 *  theory that asking early is wasted, but it put a hard 15s floor under the
 *  first scored paint even when the job was already done. The rate limiter
 *  already stops us hammering; an early 'pending' costs one cheap GET. */
const MIN_POLL_AGE_MS = 0;
/** Minimum gap between polls OF THE SAME batch. Matched to the tick so a single
 *  batch isn't artificially held back — with MAX_IN_FLIGHT = 3 and a 3s limiter
 *  slot, the limiter still decides actual cadence. */
const PER_BATCH_POLL_SPACING_MS = POLL_INTERVAL_MS;

// ---------------------------------------------------------------------------
// Persisted batch annotations
//
// These extra per-batch fields live in a local intersection type rather than in
// `PipelineBatch` (scoring-pipeline-store): the store persists the run as plain
// JSON and reads it back with `JSON.parse`, so unknown fields round-trip
// untouched, and a run that carries none of them parses exactly as before.
// ---------------------------------------------------------------------------

interface AnnotatedBatchFields {
  /** RETIRED MARKER — written only by the deleted v3 scorer, never by this
   *  build. Read by {@link hasRetiredScorerMarker} so a batch submitted under v3
   *  and still in flight across the upgrade is requeued instead of being handed
   *  to the legacy decoder, whose output contract it does not match. Delete once
   *  no device can be holding a v3-era run (they abandon after RUN_ABANDON_MS).
   *
   *  `PipelineBatch.judgeMode` is the same kind of marker for the deleted judge
   *  path; it lives in the persisted store type rather than here. */
  v3Mode?: boolean;
  /** `articlePipeline.legacyNoteDemote` — true when this batch's reason calls
   *  were built with the NOTE prompt (which may demote) instead of the
   *  caption-only reason prompt.
   *
   *  Persisted rather than re-read from the config at decode, because the two
   *  prompts have different OUTPUT CONTRACTS (`{"keep","why"}` vs bare prose),
   *  so a batch submitted under one and decoded under the other would have its
   *  answers read by the wrong parser. An OTA that flips the flag must not reach
   *  batches already in flight. Absent ⇒ the caption-only path, which is what
   *  makes every run written before this field existed resume correctly. */
  noteMode?: boolean;
}

type AnnotatedBatch = PipelineBatch & AnnotatedBatchFields;

/** True for a batch submitted by EITHER retired scorer — v3's merged two-axis
 *  call or the judge. Nothing in this build writes either marker; they are read
 *  so a batch still in flight across the upgrade is requeued rather than
 *  mis-decoded. See the field comment on {@link AnnotatedBatchFields.v3Mode}. */
function hasRetiredScorerMarker(b: PipelineBatch): boolean {
  return (b as AnnotatedBatch).v3Mode === true || b.judgeMode === true;
}

/** Read the legacy note/demote marker off a batch of unknown vintage. */
function isNoteModeBatch(b: PipelineBatch): boolean {
  return (b as AnnotatedBatch).noteMode === true;
}

/** Batches whose `reason:<id>` results carry a `{"keep","why"}` verdict rather
 *  than bare prose — i.e. batches submitted with `legacyNoteDemote` on. The ONE
 *  predicate both the reason-call BUILDER and the reason-result DECODER consult,
 *  so the prompt that was sent and the parser that reads it can never disagree.
 *
 *  A thin alias over {@link isNoteModeBatch} today (it used to also cover v3
 *  batches, whose merged call returned the same verdict shape). Kept as its own
 *  name because it states the CONTRACT the two call sites actually share, which
 *  is not the same claim as "this batch set a flag". */
function usesNotePrompt(b: PipelineBatch): boolean {
  return isNoteModeBatch(b);
}

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
/** One-shot timer for the FIRST poller tick, aligned to the rate limiter's next
 *  grant rather than a fixed POLL_INTERVAL_MS. A separate handle from
 *  `pollerTimer` so start/stop/reset can clear both unambiguously. */
let pollerKickTimer: ReturnType<typeof setTimeout> | null = null;
let appStateSub: { remove: () => void } | null = null;
let pollTickRunning = false;
/** Consecutive runPollerTick throws; reset on any clean tick. See
 *  POLLER_FAILURE_ABORT_THRESHOLD. Reset by _resetForTests. */
let consecutivePollerFailures = 0;

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

// ---------------------------------------------------------------------------
// P4b — headline/standard batch partitioning
//
// TOP-HEADLINE candidates are scored with a different system prompt AND a
// different chunk size (3 vs 5). A batch becomes ONE inference request whose
// `score:N` calls the decoder re-derives by re-chunking `candidateIds`, so a
// batch that mixed the two would have to mix chunk sizes — and the decoder,
// which can only apply one size, would attribute scores to the WRONG articles
// with no error anywhere. Batches are therefore homogeneous BY CONSTRUCTION:
// fresh ids are split here, before any batch exists, and each partition is
// chunked with its own ceiling and dispatch floor.
//
// (The submit path independently derives the variant from the candidates it
// actually sends and persists the chunk size it actually used, so even a
// mixed batch could only ever be under-routed to the standard prompt — never
// mis-decoded. This partition is what makes the headline route reachable.)
// ---------------------------------------------------------------------------

/** One homogeneous group of fresh ids, in delivery order. */
export interface EnqueuePartition {
  ids: string[];
  headline: boolean;
}

/** Split fresh ids into the standard group then the headline group, preserving
 *  delivery order within each. Empty groups are omitted, so a feed with no
 *  headlines yields exactly one partition and the pre-P4b batch layout. */
export function partitionFreshIds(
  fresh: string[],
  headlineIds: ReadonlySet<string>,
): EnqueuePartition[] {
  const headline: string[] = [];
  const standard: string[] = [];
  for (const id of fresh) {
    if (headlineIds.has(id)) headline.push(id);
    else standard.push(id);
  }
  const out: EnqueuePartition[] = [];
  if (standard.length > 0) out.push({ ids: standard, headline: false });
  if (headline.length > 0) out.push({ ids: headline, headline: true });
  return out;
}

/**
 * Which of `ids` are headline-sourced, read off the persisted stage metadata.
 *
 * Ids the query doesn't return — deleted rows, and rows already terminal
 * `excluded` (getStageRowsByIds filters those) — are STANDARD by omission,
 * which is the safe default: the worst case is a headline scored with the
 * standard prompt, never a mis-decoded batch.
 *
 * Fail-open on a read error for the same reason: enqueueing must not die
 * because a metadata read did. An empty set reproduces the pre-P4b layout
 * exactly.
 */
async function lookupHeadlineIds(ids: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  try {
    for (const row of await getStageRowsByIds(ids)) {
      if (isHeadlineScope(row.headlineScope)) out.add(row.id);
    }
  } catch (err) {
    logger.captureException(err, {
      tags: { service: 'scoring-pipeline', step: 'headline-partition' },
    });
    return new Set<string>();
  }
  return out;
}

/** The articles a chunk is responsible for: each candidate plus the duplicate
 *  siblings the gate elected it to stand in for. Deduped, candidate order first.
 *  Written unconditionally — a batch whose coverage happens to equal its
 *  candidates still needs the field, because `candidateIds` is REPLACED by the
 *  eligible subset at submit and would otherwise shrink the denominator mid-run. */
function coveredIdsFor(
  candidateIds: string[],
  coveredIdsByRep?: Readonly<Record<string, string[]>>,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const id of candidateIds) {
    for (const covered of coveredIdsByRep?.[id] ?? [id]) {
      if (seen.has(covered)) continue;
      seen.add(covered);
      out.push(covered);
    }
  }
  return out;
}

function makeQueuedBatch(
  batchId: number,
  candidateIds: string[],
  reasonsOnly = false,
  coveredIdsByRep?: Readonly<Record<string, string[]>>,
): PipelineBatch {
  return {
    batchId,
    phase: 'queued',
    candidateIds,
    coveredIds: coveredIdsFor(candidateIds, coveredIdsByRep),
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

/**
 * P9 hard-filter reconcile for score propagation. A propagated row is written
 * terminal `complete` with the donor's relevance and NEVER passes through
 * computeMathStage/computeAndScore, which is where `screenHardSuppressions`
 * runs — so a hard-"Blocked" article could inherit a passing score and render.
 * Scoped to the ids just propagated; the shared matcher lives in suppression-
 * sweep, so there is still exactly one hard screen.
 *
 * Lazy `require` for module-graph weight, same rationale as refreshUi below and
 * persona-mutation-sweeps::runSweep.
 */
const reconcileHardFilters = async (ids: string[]): Promise<void> => {
  if (ids.length === 0) return; // guard before the require — keep the empty case free
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const sweep = require('@/lib/services/suppression-sweep') as typeof import('@/lib/services/suppression-sweep');
  await sweep.purgeHardFilteredByIds(ids);
};

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

/** Read the persisted run and project its article progress. `null` when no run
 *  exists / every batch is terminal. Consumed by the store's boot hydration.
 *  Idle is read off the projection's own zero total rather than
 *  derivePipelineUiState's phase — one definition of idle, not two that must be
 *  kept in lockstep. */
export async function getPipelineBatchProgress(): Promise<PipelineBatchProgress | null> {
  const snap = await getPipeline();
  if (!snap) return null;
  const progress = derivePipelineBatchProgress(snap.run);
  return progress.total === 0 ? null : progress;
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
    // `!snap` first: it implies `ui.phase === 'idle'` anyway, and it is what
    // narrows `snap` for the else branch.
    if (!snap || ui.phase === 'idle') {
      store.setAsyncJobPhase('idle');
      store.setBatchProgress(null);
    } else {
      // Two projections on purpose: the cloud-progress row wants the candidates
      // the cloud actually carries, the "Analysing X of Y articles" line wants
      // the articles those candidates cover. See derivePipelineBatchProgress.
      store.setAsyncJobPhase(ui.phase, ui.processedCount, ui.totalCount);
      store.setBatchProgress(derivePipelineBatchProgress(snap.run));
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
 * Add fresh unscored candidate ids into the pipeline. ids already in a
 * non-terminal batch are deduped out; the remaining fresh ids (delivery order
 * preserved) are chunked into batches of at most MAX_BATCH_ARTICLES.
 *
 * A chunk is dispatched as soon as it holds MIN_DISPATCH (= one LLM call) —
 * creating the run (minting the E2EE keypair) if none exists, else appending to
 * it. Only a sub-MIN_DISPATCH remainder is deferred to accumulate, and even that
 * is dispatched when `flushPartial` is set (the caller knows no more are coming)
 * or when the oldest unscored row has aged past MAX_UNSCORED_WAIT_MS.
 *
 * So 5 ready articles go out now as a single one-call request, while 40 go out
 * as one request carrying 8 calls — small feeds get latency, busy feeds keep
 * throughput. The rule is uniform for run creation AND appends; no foreground
 * special-case.
 *
 * `coveredIdsByRep` is the scoring gate's group membership (rep id → every
 * article in its duplicate group). It is recorded on each batch as `coveredIds`
 * so the header can count the articles the run really covers, and never affects
 * what is dispatched. Omit it and every id simply covers itself — correct for
 * the callers that bypass the gate.
 */
export async function enqueueCandidates(
  ids: string[],
  flushPartial = false,
  coveredIdsByRep?: Readonly<Record<string, string[]>>,
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

  // P4b: split first, so no batch can ever hold both a headline and a standard
  // candidate. Each partition is then chunked with its OWN ceiling and floor —
  // a headline batch is 10 calls of 3, a standard batch 10 calls of 5.
  const partitions = partitionFreshIds(fresh, await lookupHeadlineIds(fresh));

  const dispatch: string[][] = [];
  let deferred = 0;
  // The trailing partials' ids when they're held back — returned to the caller
  // so feed-sync can flush them once the whole lot is hydrated (flushPartial).
  const deferredIds: string[] = [];
  // The staleness escape reads the oldest unscored row's age; memoised so two
  // partitions with a remainder each still cost at most ONE DB read.
  let oldestAgeMs: number | null = null;
  const readOldestAgeMs = async (): Promise<number | null> => {
    if (oldestAgeMs === null) {
      const oldestCreatedAt = await getOldestUnscoredCreatedAt();
      oldestAgeMs = oldestCreatedAt !== null ? Date.now() - oldestCreatedAt : -1;
    }
    return oldestAgeMs < 0 ? null : oldestAgeMs;
  };

  for (const partition of partitions) {
    const maxArticles = partition.headline
      ? MAX_BATCH_ARTICLES_HEADLINE
      : MAX_BATCH_ARTICLES;
    const minDispatch = partition.headline
      ? MIN_DISPATCH_HEADLINE
      : MIN_DISPATCH;
    // FIFO batches capped at the partition's ceiling. chunkIds yields at most
    // one trailing short chunk (the last one); dispatch anything that reaches
    // the floor, defer only a sub-floor remainder.
    for (const chunk of chunkIds(partition.ids, maxArticles)) {
      if (chunk.length >= minDispatch) {
        dispatch.push(chunk);
        continue;
      }
      // Sub-floor remainder — not yet worth its own LLM call. chunkIds only
      // ever yields one such chunk per partition, as the last, so the DB read
      // below runs at most once per enqueue (memoised above).
      //
      // Flush: the caller (feed-sync, after a fully-hydrated lot) asked to score
      // everything now. We don't refetch until the whole lot is scored, so a
      // deferred remainder would sit idle for up to MAX_UNSCORED_WAIT_MS with no
      // next fetch coming to top it up — dispatch it immediately.
      if (flushPartial) {
        logger.debug(
          `${TAG} enqueueCandidates: flush — dispatching remainder of ${chunk.length} (lot fully hydrated)`,
        );
        dispatch.push(chunk);
        continue;
      }
      // (The P7d cold-start knob that dispatched a >=10-row partial on a cold
      // feed is gone: MIN_DISPATCH is 5, so every chunk it would have caught now
      // dispatches on the fast path above regardless of feed warmth.)
      const age = await readOldestAgeMs();
      if (age !== null && age >= MAX_UNSCORED_WAIT_MS) {
        logger.debug(
          `${TAG} enqueueCandidates: staleness escape — dispatching remainder of ${chunk.length} (oldest unscored waited ${Math.round(age / 60_000)}min)`,
        );
        dispatch.push(chunk);
      } else {
        deferred += chunk.length;
        deferredIds.push(...chunk);
        logger.debug(
          `${TAG} enqueueCandidates: deferred ${chunk.length} unscored (<${minDispatch} dispatch floor, oldest ${Math.round((age ?? 0) / 60_000)}min)`,
        );
      }
    }
  }

  if (dispatch.length === 0) {
    if (snap) {
      await drain('foreground');
      ensurePoller();
    }
    return { deferred: deferredIds };
  }

  logger.debug(
    `${TAG} enqueueCandidates: ${fresh.length} fresh ids → ${dispatch.length} batch(es) dispatched, ${deferred} deferred (run ${snap ? 'exists' : 'new'})`,
  );

  const build = (base: number): PipelineBatch[] =>
    dispatch.map((c, i) => makeQueuedBatch(base + i, c, false, coveredIdsByRep));

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
      c.relevance >= REASON_RELEVANCE_THRESHOLD &&
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
  logger.debug(
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
      logger.debug(
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

    // doSubmit rethrows anything that isn't a ModelKeyValidationError. Before
    // this catch that throw escaped doDrain → drain() → runPollerTick, leaving
    // the batch stranded in submitting-* forever while revertStuckSubmitters
    // requeued it every 60s — the MERA-APP-39 wedge. A throwing submit must
    // never abort the admission loop or strand a batch, whatever the cause.
    try {
      // The admission check above already spent this request's limiter slot.
      await doSubmit(queued.batchId, context, true);
    } catch (err) {
      logger.captureException(err, {
        tags: { service: 'scoring-pipeline', step: 'submit' },
        extra: { batchId: queued.batchId, context },
      });
      await failOrRetrySubmit(
        queued.batchId,
        queued.reasonsOnly ? 'submitting-reasons' : 'submitting-relevance',
      );
      continue;
    }
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
  grantAlreadyHeld = false,
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
      await doSubmitReasonsOnly(run, batch, privKeyHex, context, grantAlreadyHeld);
      return;
    }
    await doSubmitRelevance(run, batch, privKeyHex, context, grantAlreadyHeld);
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
 * The calibration-overrides-aware config — the SAME effective config
 * `computeMathStage` scores with, and the carrier for the runtime v4
 * article-tag flags. One lookup per batch. Fail-opens to
 * DEFAULT_HARNESS_CONFIG (which also covers tests that mock stage-scoring
 * without this export).
 */
async function scoringHarnessConfig(): Promise<HarnessConfig> {
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
  grantAlreadyHeld = false,
): Promise<void> {
  const all = await getUnscoredSuggestionsWithFacts();
  const idSet = new Set(batch.candidateIds);
  const subset = all.filter((c) => idSet.has(c.id));

  // Run the deterministic math on-device NOW (no LLM). This partitions the
  // batch into math-mode (tagged metadata → judge job) vs backstop (untagged →
  // legacy tiered LLM relevance), and — for the judge path — gives us the
  // computed scores we persist so a judge failure fail-opens to the math.
  const math = await computeMathStage(subset);

  // HARD "not interested" filters. `?? new Set()` because the orchestrator
  // tests mock computeMathStage with the pre-wave shape — a missing field must
  // mean "nothing excluded", never a crash.
  const excludedIds = math.excludedIds ?? new Set<string>();
  let active = subset;
  if (excludedIds.size > 0) {
    logger.debug(
      `${TAG} batch ${batch.batchId} hard filters excluded ${excludedIds.size}/${subset.length}: ${[
        ...new Set((math.excludedValueById ?? new Map<string, string>()).values()),
      ]
        .slice(0, 10)
        .join(', ')}`,
    );
    await batchMarkExcluded([...excludedIds]);
    await refreshUi();
    active = subset.filter((c) => !excludedIds.has(c.id));
  }

  // Every candidate in the batch was filtered out — nothing left to submit.
  // Terminal transition inside the drain loop (doDrain's maybeFinalize handles
  // the run finalize); without this the batch would wedge in
  // `submitting-relevance` or submit an empty inference request.
  if (math.stage.length === 0) {
    logger.debug(
      `${TAG} batch ${batch.batchId} fully hard-filtered — marking done`,
    );
    await markBatchDone(batch.batchId);
    return;
  }

  // The calibration-overrides-aware config. It carries the v4 article-tag flags
  // into the call builders below, and reading it is a pure read of an
  // already-cached settings row.
  //
  // (`math.modeMap` is no longer consulted here. It used to partition the batch
  // into math-mode rows for the judge and backstop rows for the legacy path;
  // with the judge deleted there is one path and every candidate takes it.)
  const cfg = await scoringHarnessConfig();

  // Push-token policy (a): attach the run's token only when this is the LAST
  // relevance-needing batch — no other relevance batch is queued or submitting.
  const otherRelevancePending = run.batches.some(
    (b) =>
      b.batchId !== batch.batchId &&
      !b.reasonsOnly &&
      (b.phase === 'queued' || b.phase === 'submitting-relevance'),
  );
  const token = otherRelevancePending ? null : run.expoPushToken;

  // (The RELEVANCE_V3 branch that used to sit here — ONE merged
  // score+impact+conditional-reason call for every candidate — is deleted with
  // the rest of the v3 scorer. Its toggle now selects v4, which is this same
  // legacy path with two article-tag features layered onto the PROMPTS: `cfg`
  // carries them, and they reach the builders below through
  // `cfg.articlePipeline`.)

  // --- THE SCORING PATH — the two-phase tiered LLM flow, unchanged. ---------
  // No math audit is persisted here; a failed batch must leave its rows
  // `unscored` and re-runnable.
  {
    // `cfg.articlePipeline`, not the builder's default literal: ADD 1
    // (`legacyTagPromptEnabled`, the v4 toggle) is a RUNTIME flag, and the
    // shim's module-level `ARTICLE_CFG` is frozen at import. Passing the
    // effective config is what makes the toggle reach the calls the app sends.
    const bundle = await buildRelevanceCalls(active, cfg.articlePipeline);
    if (bundle.calls.length === 0 || bundle.eligibleCandidates.length === 0) {
      logger.debug(
        `${TAG} batch ${batch.batchId} relevance bundle empty — marking done`,
      );
      // Terminal transition inside the drain loop; doDrain's maybeFinalize
      // handles the run finalize (calling afterTerminal here would re-enter
      // drain).
      await markBatchDone(batch.batchId);
      return;
    }
    const eligibleIds = bundle.eligibleCandidates.map((c) => c.id);

    // SOFT suppression ("shown less") on the legacy path. The cloud LLM knows
    // nothing about the user's filters and its score REPLACES the math score
    // that carried the penalty, so a soft filter would do nothing at all on this
    // path. Carry the penalty the math already computed for each candidate
    // (components.suppressPenalty = Σ P_SUP·strength capped at P_SUP_CAP, via
    // the one kind-aware matcher in suppression.ts) on the batch, and subtract
    // it at decode. Keyed over the WHOLE stage, not just the backstop rows:
    // line above sends `active` (every survivor) down the legacy prompt, so a
    // math-mode row in a mixed batch loses its penalty too. Non-zero entries
    // only, and the field stays undefined when nothing matched — a user with no
    // soft filters takes the exact pre-change code path.
    const suppressPenaltyMap: Record<string, number> = {};
    for (const c of math.stage) {
      const penalty = math.componentsMap.get(c.input.id)?.suppressPenalty ?? 0;
      if (penalty > 0) suppressPenaltyMap[c.input.id] = penalty;
    }
    const penalisedCount = Object.keys(suppressPenaltyMap).length;
    if (penalisedCount > 0) {
      logger.debug(
        `${TAG} batch ${batch.batchId} soft filters will penalise ${penalisedCount}/${math.stage.length} at decode`,
      );
    }

    // P4b: the builder picked the prompt variant from the candidates and reports
    // the chunk size it ACTUALLY used. Persist that value (below) rather than
    // re-deriving it at decode — submit and decode then cannot disagree, which
    // is the only thing standing between a headline batch and scores attributed
    // to the wrong articles. Absent (older builder) ⇒ the standard size.
    const scoreChunkSize = bundle.scoreChunkSize ?? CLOUD_SCORE_CHUNK_SIZE;

    const ctx = await rebuildE2EEContext(SMALL_MODEL, privKeyHex, run.algo);
    logger.debug(
      `${TAG} batch ${batch.batchId} submit relevance (backstop): ${eligibleIds.length} ids in ${bundle.calls.length} calls, chunk=${scoreChunkSize} (token=${token ? 'yes' : 'no'})`,
    );
    const outcome = await sendInferenceRequest({
      bundle,
      ctx,
      token,
      model: SMALL_MODEL,
      context,
      grantAlreadyHeld,
    });

    if (outcome.status === 'ok') {
      // `legacyNoteDemote` is decided HERE, once, and persisted on the batch.
      // The reason calls are not built until a later phase, so the flag must be
      // captured at the moment the batch commits to being a legacy batch —
      // reading the literal again at reason-build or decode time would let an
      // OTA change the output contract underneath an in-flight batch. Default
      // OFF ⇒ `noteMode` is left undefined and every downstream predicate reads
      // exactly as it did before this flag existed.
      await transitionToWaitingRelevance(
        batch.batchId,
        outcome,
        eligibleIds,
        penalisedCount > 0 ? suppressPenaltyMap : undefined,
        scoreChunkSize,
        cfg.articlePipeline.legacyNoteDemote === true
          ? { noteMode: true }
          : undefined,
      );
      logger.debug(
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

}

async function doSubmitReasonsOnly(
  run: PipelineRun,
  batch: PipelineBatch,
  privKeyHex: string,
  context: ExecutionContext,
  grantAlreadyHeld = false,
): Promise<void> {
  const scored = await getScoredSuggestionsWithoutReasons();
  const idSet = new Set(batch.candidateIds);
  const subset = scored.filter((c) => idSet.has(c.id));
  const rawMap: Record<string, number> = {};
  for (const c of subset) {
    if (typeof c.relevance === 'number') rawMap[c.id] = c.relevance;
  }
  // A reasonsOnly batch never passed through `transitionToWaitingRelevance`, so
  // it carries no `noteMode` yet. Decide it HERE, build with it, and persist it
  // on the transition below — same submit-time capture as the relevance path.
  // Without this the flag would demote on the main path and silently not on the
  // orphaned-reason sweep, which is the kind of split that only shows up as
  // "some rows kept a note they shouldn't have".
  //
  // Read through `scoringHarnessConfig()`, the SAME source the relevance path
  // uses — not the raw `DEFAULT_HARNESS_CONFIG` literal. `effectiveHarnessConfig`
  // is where a flag becomes runtime-layerable (it is how the v4 article-tag
  // flags are bound), so a literal read here would put the orphan sweep on a
  // different prompt from the main path — the exact split this code exists to
  // prevent.
  const reasonsCfg = await scoringHarnessConfig();
  const noteMode = reasonsCfg.articlePipeline.legacyNoteDemote === true;
  const bundle = await buildReasonCallsForSubset(
    subset,
    rawMap,
    REASON_RELEVANCE_THRESHOLD,
    noteMode,
    // ADD 2 (`legacyTagReasonGateEnabled`, the v4 toggle) is read from this
    // object inside the builder — same reason `noteMode` is resolved here
    // rather than from the literal.
    reasonsCfg.articlePipeline,
  );
  // Before the empty-bundle early return: the gate may have emptied the bundle
  // by demoting EVERY row, and those demotions still have to be written.
  await applyTagGatedDemotions(batch.batchId, bundle.tagGatedDemoteIds);
  if (bundle.calls.length === 0) {
    logger.debug(
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
  logger.debug(
    `${TAG} batch ${batch.batchId} submit reasonsOnly: ${reasonIds.length} ids in ${bundle.calls.length} calls`,
  );
  const outcome = await sendInferenceRequest({
    bundle,
    ctx,
    token,
    model: SMALL_MODEL,
    context,
    grantAlreadyHeld,
  });

  if (outcome.status === 'ok') {
    await transitionToWaitingReasons(
      batch.batchId,
      outcome,
      reasonIds,
      rawMap,
      noteMode,
    );
    logger.debug(
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
  /** Non-zero soft-suppression penalties to subtract from the LLM scores at
   *  decode. */
  suppressPenaltyMap?: Record<string, number>,
  /** The chunk size the `score:N` calls were built with, so decode re-chunks
   *  candidateIds identically. */
  scoreChunkSize?: number,
  /** Per-batch prompt annotations (currently just `noteMode`). Assigned
   *  unconditionally below, like the maps above, so a retry can never inherit
   *  the previous attempt's annotations. */
  annotations?: AnnotatedBatchFields,
): Promise<void> {
  await mutatePipeline((run) => {
    const b = run.batches.find((x) => x.batchId === batchId) as
      | AnnotatedBatch
      | undefined;
    if (!b || b.phase !== 'submitting-relevance') return null;
    // Cleared unconditionally. This is what stops a batch REQUEUED off the
    // stale-v3 detector (handleRelevanceResults) from carrying its v3 marker
    // back into `waiting-relevance` and looping through the detector until its
    // attempts run out. Nothing sets it any more; only clearing it is left.
    b.v3Mode = undefined;
    // Assigned unconditionally, for the same reason: a retry re-entering submit
    // must never inherit the previous attempt's prompt choice.
    b.noteMode = annotations?.noteMode === true ? true : undefined;
    b.phase = 'waiting-relevance';
    b.requestId = outcome.requestId;
    b.capabilityToken = outcome.capabilityToken || undefined;
    b.candidateIds = eligibleIds; // eligible/submit order = decode join key
    b.submittedAt = Date.now();
    // Assigned unconditionally (same rationale as suppressPenaltyMap below): a
    // retry that re-enters submit must never inherit the previous attempt's
    // chunk size.
    b.scoreChunkSize = scoreChunkSize;
    // Assigned unconditionally (not only when present) so a retry that re-enters
    // submit can never inherit a stale map from the previous attempt.
    b.suppressPenaltyMap = suppressPenaltyMap;
    // Cleared for the same reason `v3Mode` is: nothing writes it any more, and a
    // requeued judge-era batch must not carry its marker back into
    // `waiting-relevance` and trip the retired-scorer detector every cycle.
    b.judgeMode = undefined;
    return true;
  });
}

async function transitionToWaitingReasons(
  batchId: number,
  outcome: { requestId: string; capabilityToken: string },
  reasonIds: string[],
  relevanceMap?: Record<string, number>,
  /** `articlePipeline.legacyNoteDemote` as decided at THIS submit — passed only
   *  by `doSubmitReasonsOnly`, whose batches never pass through
   *  `transitionToWaitingRelevance` and so have no marker yet.
   *
   *  Deliberately "assign only when supplied", unlike the unconditional
   *  assignments in `transitionToWaitingRelevance`: `submitNeedsReasons` also
   *  lands here, for a batch whose `noteMode` was already fixed at RELEVANCE
   *  submit. Overwriting it from the live literal there is exactly the
   *  in-flight-OTA hazard the field exists to prevent, so an omitted argument
   *  must leave the stored value alone. */
  noteMode?: boolean,
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
    // See the parameter's doc comment: assign ONLY when supplied, so a
    // needs-reasons-submit batch keeps the marker fixed at relevance submit.
    if (noteMode !== undefined) {
      (b as AnnotatedBatch).noteMode = noteMode === true ? true : undefined;
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
  logger.debug(`${TAG} batch ${batchId} throttled — requeued (attempt unchanged)`);
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
  // The 'ed25519' fallback is the correct default for jobs persisted before the
  // ecdsa split, but a run reaching here WITHOUT an algo on a current build is
  // a schema-1 leftover worth seeing — decrypting under the wrong curve is the
  // MERA-APP-39 failure mode.
  if (snap && !snap.run.algo) {
    logger.warn(
      `${TAG} decodeBatch: run has no persisted algo — assuming ed25519 (pre-split job)`,
    );
  }
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
  // BATCH FROM A RETIRED SCORER. Both v3 (the merged two-axis call) and the
  // judge (the combined {"j","s"?,"r"?} call) are deleted, but a persisted batch
  // outlives the code that wrote it: a device can still be holding one submitted
  // under either, sitting in `waiting-relevance` across the upgrade. Their
  // results are DIFFERENT output contracts from the legacy `score:N` chunks, so
  // the decoder below would not fail loudly — it would write garbage scores onto
  // real rows.
  //
  // Requeue instead of decoding. A `waiting-relevance` failure persists NOTHING,
  // so the rows return to `unscored` and the requeued batch is re-submitted from
  // scratch down the legacy path — they get correctly re-scored rather than
  // merely dropped.
  //
  // The two markers differ in how likely they are. v3 was a shipped user-facing
  // toggle, so real devices ran it. Judge mode required the (since-deleted)
  // `EXPO_PUBLIC_USE_ARTICLE_TAGS=true`, which was unset in `.env` and false by
  // default, so no shipped build could have produced one — it is covered anyway
  // because the machinery already exists and a dev/staging device is not worth
  // reasoning about twice.
  if (hasRetiredScorerMarker(batch)) {
    logger.warn(
      `${TAG} batch ${batch.batchId} was submitted by a retired scorer — requeueing for a legacy re-score`,
    );
    await requeueWaitingOrFail(batch, 'stale-scorer', context);
    return;
  }

  const { batchResults } = await decodeBatch(batch, server);
  coldstartTimeline.mark('first-relevance-decode', `decoded=${batchResults.length}`);

  // P4b: re-chunk with the size the SUBMIT actually used, persisted on the
  // batch. A headline batch was chunked at 3, a standard one at 5 — applying
  // the wrong size here silently shifts every score onto a neighbouring
  // article. `??` covers batches submitted by a pre-P4b build (all of which
  // used CLOUD_SCORE_CHUNK_SIZE) and any that stored no size.
  const scoreChunkSize = batch.scoreChunkSize ?? CLOUD_SCORE_CHUNK_SIZE;
  const nChunks = Math.max(
    1,
    Math.ceil(batch.candidateIds.length / scoreChunkSize),
  );
  const callIds = Array.from({ length: nChunks }, (_, i) => `score:${i}`);
  const { chunkIdToCandidates } = reconstructLookups(
    callIds,
    batch.candidateIds,
    scoreChunkSize,
  );

  const { scoreMap, failedIds } = decodeResults({
    batchResults,
    promptsById: new Map(),
    chunkIdToCandidates,
  });

  // (verifier pass removed — absorbed into the judge, Wave 7b M-P5)

  // SOFT suppression ("shown less"): subtract the penalty the on-device math
  // computed at submit from the LLM score that replaced it. Applied HERE —
  // before rawRelevanceMap is captured and before bucketScores — so the
  // demotion reaches every consumer at once: the persisted bucket, the raw
  // scores fed to the reason prompts, the `impactfulIds` reason gate below and
  // discardLowRelevance. Rows with no entry are never rewritten (byte-identical
  // to the pre-change path), and the decoder already clamped to [0, 1.1], so
  // only the lower bound can bite.
  const suppressPenaltyMap = batch.suppressPenaltyMap;
  if (suppressPenaltyMap) {
    let penalised = 0;
    for (const [id, penalty] of Object.entries(suppressPenaltyMap)) {
      if (!(penalty > 0) || failedIds.has(id)) continue;
      const scored = scoreMap.get(id);
      if (scored === undefined) continue;
      scoreMap.set(id, Math.max(0, scored - penalty));
      penalised += 1;
    }
    if (penalised > 0) {
      logger.debug(
        `${TAG} batch ${batch.batchId} soft filters penalised ${penalised}/${scoreMap.size}`,
      );
    }
  }

  // Preserve raw pre-bucket scores for the reason prompts; storage + gating use
  // the bucketed values.
  const rawRelevanceMap: Record<string, number> = {};
  for (const [id, raw] of scoreMap) rawRelevanceMap[id] = raw;
  bucketScores(scoreMap);

  // TOP-HEADLINE CULL (same rule as the judge path): a headline-sourced row that
  // scored below the MEDIUM band is terminally `excluded` instead of saved.
  // Topic-matched rows are never culled — their LOW band stays on the Dashboard.
  // Before the save loop, so no score is written over the terminal status.
  const culledHeadlineIds = new Set<string>();
  const headlineIds = await lookupHeadlineIds(batch.candidateIds);
  if (headlineIds.size > 0) {
    for (const id of headlineIds) {
      if (failedIds.has(id)) continue;
      const relevance = scoreMap.get(id);
      if (relevance === undefined) continue;
      if (isCulledHeadlineRelevance(relevance)) culledHeadlineIds.add(id);
    }
    if (culledHeadlineIds.size > 0) {
      logger.debug(
        `${TAG} batch ${batch.batchId} culled ${culledHeadlineIds.size}/${headlineIds.size} sub-MEDIUM headlines`,
      );
      await batchMarkExcluded([...culledHeadlineIds]);
      // Culled ids leave BOTH maps: relevanceMap feeds discardLowRelevance,
      // which would flip a sub-KEEP row from `excluded` back to a reason-skipped
      // `complete`; rawRelevanceMap is the reason-prompt score lookup.
      for (const id of culledHeadlineIds) delete rawRelevanceMap[id];
    }
  }

  // DB writes FIRST (so the impactful subset query sees reason_pending rows),
  // then a single CAS storing the maps + next phase.
  const relevanceMap: Record<string, number> = {};
  for (const id of batch.candidateIds) {
    if (failedIds.has(id) || culledHeadlineIds.has(id)) continue;
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
    const propagated = await propagateToUnscoredSiblings(inFlight, reconcileHardFilters);
    if (propagated > 0) await refreshUi();
  } catch (err) {
    logger.captureException(err, {
      tags: { service: 'scoring-pipeline', step: 'propagate-siblings' },
    });
  }

  const impactfulIds = Object.keys(relevanceMap).filter(
    (id) =>
      relevanceMap[id] >= REASON_RELEVANCE_THRESHOLD &&
      (rawRelevanceMap[id] ?? 0) >= REASON_MIN_RAW_SCORE,
  );

  logger.debug(
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

/**
 * Apply a v3 pass-2 batch: per article, a keep-or-demote verdict and (when
 * kept) the sentence the user reads.
 *
 * The decode is NOT `decodeResults`. That reader runs `parseReasonResponse`,
 * which treats the whole response as prose — handed `{"keep":true,"why":"…"}` it
 * would cheerfully persist the raw JSON as the note.
 *
 * FAIL OPEN, in both directions:
 *   - an unusable response leaves the pass-1 score and `reason_pending`, so the
 *     orphaned-reasons sweep retries it. An unreadable answer is not evidence
 *     that an article deserves demoting;
 *   - a KEEP with no sentence is the same state — scored, still owed a note —
 *     rather than a row stamped terminal with nothing to show.
 * Only an explicit `{"keep": false}` demotes, and it writes the score terminal
 * with no note: the row is going below the render gate, so a note for it would
 * be spend with no reader.
 */
/**
 * ADD 2's persistence half — the write that makes skipping a pass-2 reason call
 * sound.
 *
 * `buildReasonCallsForSubset` returns `tagGatedDemoteIds` when
 * `articlePipeline.legacyTagReasonGateEnabled` is on (default off ⇒ always
 * empty ⇒ this is a no-op). Those rows had their reason call SKIPPED, so they
 * must simultaneously leave the feed: this path's reason threshold equals its
 * render gate, so a skipped-but-not-demoted row would render with no note and
 * sit in `reason_pending` forever, re-elected by every later gate pass.
 *
 * IT KEEPS ITS REAL RELEVANCE and goes terminal as `reason_skipped`. It used to
 * be written at `feedVerifierDemoteScore` (0.28) to force it under the render
 * gate, which threw away a score an LLM call had just produced and told every
 * downstream reader "this scored badly" when the truth was "we chose not to
 * narrate it". The status carries that meaning now, and carries it honestly.
 *
 * NOT the same action as `applyV3NoteResults`' demote loop, which this used to
 * mirror. That one acts on an LLM VERDICT that the article does not belong in
 * the feed — a claim about relevance, so overwriting relevance is right there.
 * This one is a deterministic decision about the NOTE, taken from the event type
 * alone, and it makes no claim about the score at all.
 */
async function applyTagGatedDemotions(
  batchId: number,
  demoteIds: string[] | undefined,
): Promise<void> {
  if (!demoteIds || demoteIds.length === 0) return;
  try {
    await batchMarkGateSkipped(demoteIds);
  } catch (err) {
    logger.captureException(err, {
      tags: { service: 'scoring-pipeline', step: 'tag-gate-skip' },
      extra: { count: String(demoteIds.length) },
    });
  }
  logger.debug(
    `${TAG} batch ${batchId} article-tag reason gate: marked ${demoteIds.length} ` +
      `rows reason_skipped (real relevance kept), skipping their reason calls`,
  );
}

async function applyV3NoteResults(
  batch: PipelineBatch,
  batchResults: { id: string; output: string; error?: string }[],
): Promise<void> {
  const demoteScore = DEFAULT_HARNESS_CONFIG.articlePipeline.feedVerifierDemoteScore;

  // The RULES live in the harness (`decodeV3NoteResults`); this function owns
  // only the DB writes. That split is what lets the offline goldset replay
  // measure the SHIPPED decision logic rather than a look-alike written beside
  // it — the same reason `applyFeedVerifierDecisions` is shaped this way.
  const { demoteIds, reasons, unusableIds } = decodeV3NoteResults(batchResults);

  for (const id of demoteIds) {
    try {
      await saveScoringResult(id, {
        relevance: demoteScore,
        reason: '',
        // Terminal: below the gate it owes no note at all, so leaving it
        // `reason_pending` would strand it in the recovery sweep forever.
        reasonSkipped: true,
      });
    } catch (err) {
      if (isRecordNotFoundError(err)) continue;
      logger.captureException(err, {
        tags: { service: 'scoring-pipeline', step: 'save-v3-note' },
        extra: { candidateId: id },
      });
    }
  }
  for (const [id, why] of reasons) {
    try {
      await saveReason(id, why);
    } catch (err) {
      if (isRecordNotFoundError(err)) continue;
      logger.captureException(err, {
        tags: { service: 'scoring-pipeline', step: 'save-v3-note' },
        extra: { candidateId: id },
      });
    }
  }

  logger.debug(
    `${TAG} batch ${batch.batchId} notes: kept=${reasons.size} ` +
      `demoted=${demoteIds.length} unusable=${unusableIds.length}`,
  );
}

async function handleReasonResults(
  batch: PipelineBatch,
  server: ServerResults,
  context: ExecutionContext,
): Promise<void> {
  const { batchResults } = await decodeBatch(batch, server);

  // The SAME predicate the reason-call builder used. A legacy batch submitted
  // with `legacyNoteDemote` sent the note prompt, so its answers are
  // `{"keep","why"}` verdicts and must go to the note applier — handing them to
  // the prose decoder would persist raw JSON as the user-facing note.
  if (usesNotePrompt(batch)) {
    await applyV3NoteResults(batch, batchResults);
  } else {
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
  }

  const discarded = await discardLowRelevance(
    batch.candidateIds,
    batch.relevanceMap ?? {},
  );
  await refreshUi();
  if (discarded > 0) {
    logger.debug(
      `${TAG} batch ${batch.batchId} discarded ${discarded} low-relevance rows`,
    );
  }

  await markBatchDone(batch.batchId);
  logger.debug(`${TAG} batch ${batch.batchId} reasons done`);
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
    // Read off the BATCH, not the live config: a batch submitted under v3 (or
    // under `legacyNoteDemote`) must decode the same way even if the flag
    // flipped while it was in flight, or its responses would be parsed by the
    // wrong reader. `usesNotePrompt` is the single predicate the DECODER also
    // consults, so the prompt sent and the parser used cannot diverge.
    usesNotePrompt(batch),
    // ADD 2 (`legacyTagReasonGateEnabled`, the v4 toggle). Read LIVE, unlike
    // `noteMode` above: the gate changes which rows get a call and demotes the
    // rest in this same function — it does not change any output CONTRACT, so
    // there is nothing an in-flight flag flip could mis-parse.
    (await scoringHarnessConfig()).articlePipeline,
  );

  // Same ordering rule as the reasonsOnly path: write the demotions before the
  // empty-bundle early return, since the gate can empty the bundle by itself.
  await applyTagGatedDemotions(batchId, bundle.tagGatedDemoteIds);

  if (bundle.calls.length === 0) {
    // Every impactful row turned out ineligible for a reason — finish clean.
    await markBatchDone(batchId);
    const discarded = await discardLowRelevance(
      batch.candidateIds,
      batch.relevanceMap ?? {},
    );
    await refreshUi();
    if (discarded > 0) {
      logger.debug(
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
      logger.debug(
        `${TAG} batch ${batchId} discarded ${discarded} low-relevance rows`,
      );
    }
    await afterTerminal(context);
    return;
  }
  const reasonIds = bundle.eligibleCandidates.map((c) => c.id);
  logger.debug(
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
    // The admission check above (`tryTakeImmediate` before the CAS claim)
    // already spent this request's limiter slot.
    grantAlreadyHeld: true,
  });

  if (outcome.status === 'ok') {
    await transitionToWaitingReasons(batchId, outcome, reasonIds);
    logger.debug(
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
      logger.debug(
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
  reason: 'stale' | 'not-found' | 'unauthorized' | 'attempts-exhausted' | 'stale-scorer',
  context: ExecutionContext,
): Promise<void> {
  const wasReasons = batch.phase === 'waiting-reasons';
  const mutated = await mutatePipeline((run) => {
    const b = run.batches.find((x) => x.batchId === batch.batchId);
    if (!b || b.phase !== batch.phase) return null;
    b.attempt = b.attempt + 1;
    if (b.attempt >= MAX_BATCH_ATTEMPTS) {
      b.phase = 'failed';
      // `stale-scorer` is an in-code reason only — it narrows a log line, and the
      // requeue (not the failure) is the outcome that matters for it. It is
      // deliberately NOT added to the PERSISTED `failureReason` union in
      // scoring-pipeline-store: that union is written into a settings row and
      // read back by older builds, so widening it is a data-format change for a
      // transient upgrade-window case. It records as the `stale` it behaves as.
      b.failureReason = reason === 'stale-scorer' ? 'stale' : reason;
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
        logger.debug(
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

/** Is a feed-sync job in flight right now? Read lazily so this module keeps no
 *  static edge into the scheduler graph (AppScheduler → task defs →
 *  FeedSyncMachine → this file). scheduler-store itself is a leaf, but the lazy
 *  require matches how the rest of the codebase crosses this boundary and keeps
 *  the pipeline importable from a bare background wake. */
function isFeedSyncRunning(): boolean {
  try {
    const { useSchedulerStore } =
      require('@/lib/scheduler/scheduler-store') as typeof import('@/lib/scheduler/scheduler-store');
    return useSchedulerStore.getState().taskCurrentStatus['feed-sync'] === 'running';
  } catch {
    // Scheduler not loaded (e.g. a background wake that never booted it) —
    // nothing can be mid-hydration, so flushing is safe.
    return false;
  }
}

/** Gather the still-unscored eligible rows and re-enqueue them.
 *
 *  This is the handoff for rows that feed-sync hydrated while a run was already
 *  in flight (its `suppressEnqueue` path, which skips both the enqueue and its
 *  own tail flush). We flush the remainder here rather than deferring it: the
 *  run has just finalized, so nothing is in flight and nothing is going to top a
 *  sub-MIN_DISPATCH remainder up — exactly the argument feed-sync's tail flush
 *  makes. Without the flush those rows waited out MAX_UNSCORED_WAIT_MS (30 min)
 *  on a quiet feed, since the `missingIds === 0` branch never hydrates and so
 *  never reaches a tail flush of its own.
 *
 *  The one case we must NOT flush is a finalize landing while feed-sync is still
 *  hydrating later chunks — dispatching 3 rows when 50 are a second away wastes
 *  a round trip. There, feed-sync's own end-of-cycle flush owns the remainder,
 *  so we fall back to the normal accumulate-and-gate behaviour. */
async function runPostFinalizeKick(): Promise<void> {
  try {
    // A concurrent trigger (feed-sync / scoring-pass) may already have started a
    // run between finalize and now — enqueueCandidates dedups + gates, so this
    // is safe either way.
    await enqueueUnscoredEligible({ flushRemainder: !isFeedSyncRunning() });
  } catch (err) {
    logger.captureException(err, {
      tags: { service: 'scoring-pipeline', step: 'post-finalize-kick' },
    });
  }
}

/** The user's geo/language context, which steers WHICH sibling of a duplicate
 *  group the gate elects. Lazy-required (like refreshUi) so this module keeps no
 *  static edge into the persona/store graph, and fail-open to null — the legacy,
 *  geo-blind election — because an enqueue must never die on a context read. */
async function loadGateUserContext(): Promise<
  Parameters<typeof gateUnscoredForScoring>[1]
> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('@/lib/user-context/user-geo-language-context') as typeof import('@/lib/user-context/user-geo-language-context');
    return await mod.loadUserGeoLanguageContext();
  } catch (err) {
    logger.captureException(err, {
      tags: { service: 'scoring-pipeline', step: 'gate-user-context' },
    });
    return null;
  }
}

/**
 * Re-elect every still-unscored eligible row from the DB and enqueue it.
 *
 * Shared by the post-finalize kick and by feed-sync's suppressed cycle, which
 * both face the same question: rows exist that nothing has dispatched, and we
 * need to know whether to respect the MIN_DISPATCH floor or push the remainder
 * through. Pass `flushRemainder` when the caller knows no more rows are coming.
 *
 * GATE-BYPASS FIX: this used to enqueue EVERY eligible unscored row with no
 * story grouping at all — the one enqueue path that skipped
 * `gateUnscoredForScoring`. Duplicates of an already-scored story therefore paid
 * for their own LLM pass instead of inheriting a donor's score, and every
 * same-sync duplicate of a fresh story was scored N times instead of once. Both
 * of the other enqueue sites (feed-sync, the background scoring pass) route
 * through the gate; this one now does too, with the SAME shape they use:
 * propagate → reconcile hard filters → refresh → enqueue only the elected
 * representatives that are also scorable. The gate is imported, never
 * reimplemented, so there is exactly one election/propagation rule.
 */
export async function enqueueUnscoredEligible(
  opts: { flushRemainder?: boolean } = {},
): Promise<{ enqueued: number }> {
  const candidates = await getUnscoredSuggestionsWithFacts();
  // `isScorableCandidate`, not `isEligible` — a TOP-HEADLINE row is factless by
  // design. This is the enqueue that fires when feed-sync hydrated NOTHING
  // (`runPostFinalizeKick`, and feed-sync's suppressed cycle), so leaving the
  // fact requirement here would have enqueued headlines only on syncs that
  // happened to hydrate new articles — an intermittent bug that reads as
  // "sometimes works" and is unfalsifiable in QA.
  const eligible = new Set(
    candidates.filter(isScorableCandidate).map((c) => c.id),
  );
  if (eligible.size === 0) return { enqueued: 0 };

  const inFlight = await getNonTerminalCandidateIds();
  const gate = await gateUnscoredForScoring(inFlight, await loadGateUserContext());

  if (gate.propagatedCount > 0) {
    // P9: propagated rows are written terminal `complete` WITHOUT ever meeting
    // the scoring stage's hard screen (score-propagation's HARD FILTERS note).
    // The gate reports only a COUNT, so the reconcile is the FULL sweep — the
    // gate propagates over ALL unscored rows, not just this call's ids. Never
    // fails the enqueue: the propagation is already committed.
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const sweep = require('@/lib/services/suppression-sweep') as typeof import('@/lib/services/suppression-sweep');
      await sweep.purgeHardFilteredSuggestions();
    } catch (err) {
      logger.captureException(err, {
        tags: { service: 'scoring-pipeline', step: 'reconcile-hard-filters' },
      });
    }
    await refreshUi();
  }

  // Only elected representatives, and only the ones this path is allowed to
  // score. `flushRemainder` semantics are unchanged — it is still the caller's
  // "no more rows are coming" signal, passed straight through.
  const toEnqueue = gate.enqueueIds.filter((id) => eligible.has(id));
  logger.debug(
    `${TAG} enqueueUnscoredEligible: ${eligible.size} eligible → gate propagated ${gate.propagatedCount}, held back ${gate.heldBackCount}, enqueue ${toEnqueue.length}`,
  );
  if (toEnqueue.length === 0) return { enqueued: 0 };
  await enqueueCandidates(
    toEnqueue,
    opts.flushRemainder === true,
    gate.coveredIdsByRep,
  );
  return { enqueued: toEnqueue.length };
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

  // The old P7d "knob 2" relaxed a 15s min-age / 20s spacing down to the tick
  // cadence on a cold feed only. Both gates are now at/below the tick for EVERY
  // feed (MIN_POLL_AGE_MS = 0, spacing = the tick), so the cold branch computed
  // the same numbers as the warm one while paying an `isFeedCold()` DB read on
  // every tick. Dropped.
  //
  // Cadence is governed by the gateway rate limiter (MIN_GATEWAY_INTERVAL_MS,
  // 3s, shared with submits), not by these gates — `tryTakeImmediate()` below is
  // what actually paces us, and a tick that can't take a slot costs nothing.
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
      // Honour the attempt cap, as failOrRetrySubmit does. Without it this
      // requeued unboundedly: a submit that throws every time was reverted
      // →requeued→claimed→thrown forever, and only FeedSyncMachine's 30-minute
      // stale guard broke the loop (MERA-APP-39). An unbounded counter here is
      // a defect independent of any specific throw cause.
      if (cur.attempt >= MAX_BATCH_ATTEMPTS) {
        cur.phase = 'failed';
        cur.failureReason = 'submit-failed';
        return true;
      }
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
  if (pollerTimer || pollerKickTimer) return;
  // FIRST-TICK ALIGNMENT. The submit that just ran consumed a limiter slot, so
  // a fixed POLL_INTERVAL_MS (= MIN_GATEWAY_INTERVAL_MS - POLL_TICK_LEAD_MS)
  // first tick lands BEFORE `nextGrantAt` whenever the submit round trip was
  // quicker than the lead — `tryTakeImmediate()` refuses and the very first
  // GET /results slips a whole extra interval. Measured on prod before this
  // change: 5533ms POST → first poll, with the server's results already
  // waiting (the decode landed 118ms after the poll). Ask the limiter when the
  // slot actually frees instead of guessing.
  //
  // The +1 is not cosmetic: a timer that fires one millisecond early costs a
  // full POLL_INTERVAL_MS, which is precisely the off-by-a-hair failure this
  // exists to remove.
  const firstDelay = Math.min(
    POLL_INTERVAL_MS,
    gatewayRateLimiter.msUntilNextGrant() + 1,
  );
  pollerKickTimer = setTimeout(() => {
    pollerKickTimer = null;
    void runPollerTick();
    if (!pollerTimer) {
      pollerTimer = setInterval(() => {
        void runPollerTick();
      }, POLL_INTERVAL_MS);
    }
  }, firstDelay);
}

function stopPollerTimer(): void {
  if (pollerKickTimer) {
    clearTimeout(pollerKickTimer);
    pollerKickTimer = null;
  }
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
    consecutivePollerFailures = 0;
  } catch (err) {
    consecutivePollerFailures += 1;
    logger.captureException(err, {
      tags: { service: 'scoring-pipeline', step: 'poller-tick' },
      extra: { consecutivePollerFailures },
    });
    // Generic wedge backstop, independent of cause: a tick that throws leaves
    // the run non-terminal, and a non-terminal run makes EVERY feed-sync cycle
    // a no-op (FeedSyncMachine skips while the pipeline is 'running'). Rather
    // than re-throwing every 7s until the 15-minute stale guard fires, abandon
    // the run after a few consecutive failures — its rows stay Unscored and
    // re-enter the next run under a fresh context, which is the outcome we
    // want anyway.
    if (consecutivePollerFailures >= POLLER_FAILURE_ABORT_THRESHOLD) {
      logger.warn(
        `${TAG} poller tick threw ${consecutivePollerFailures}x consecutively — aborting run to unblock feed-sync`,
      );
      consecutivePollerFailures = 0;
      await abortRun('poller-tick-throw').catch(() => {});
    }
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
  consecutivePollerFailures = 0;
  feedWarmCached = false;
  if (postFinalizeKickTimer) {
    clearTimeout(postFinalizeKickTimer);
    postFinalizeKickTimer = null;
  }
  if (pollerKickTimer) {
    clearTimeout(pollerKickTimer);
    pollerKickTimer = null;
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
