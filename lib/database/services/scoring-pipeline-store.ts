// Scoring-pipeline run store — persistent state for the multi-batch cloud
// scoring pipeline (the ~19-batch successor to the single-slot async
// inference job in `async-job-service.ts`).
//
// Mirrors async-job-service's doctrine:
//   - Non-secret run/batch metadata lives in the unencrypted WatermelonDB
//     `settings` row (key `async_pipeline_run`) so it survives cold-start and a
//     submit → push → reconcile cycle that spans a process restart.
//   - The run-level E2EE private key (used to decrypt gateway responses on
//     reconcile) is sensitive, so it is kept OUT of the SQLite row and stored in
//     expo-secure-store (keychain, pinned via the adapter to
//     AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY — the accessibility a background
//     reconcile needs when it wakes from a silent push while the device is
//     locked). The secret is per-run and disposable: a lost key costs one
//     re-score, never user data.
//   - Prompt bodies (system/user text) are NEVER persisted. Persisting them
//     blew past Android's 2 MB per-row CursorWindow limit on large reason
//     batches (~960 KB JSON for 451 calls) in the single-slot design. Only ids
//     and decoded score maps live here; the reconciler re-derives everything
//     else from `candidateIds` order + the score maps.

import type { SigningAlgo } from '@/lib/e2ee/e2ee-service';
import logger from '@/lib/logger';
import { secureStore } from '@/lib/utils/secure-store-adapter';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  deleteSetting,
  getSetting,
  setSetting,
} from './setting-service';

const PIPELINE_KEY = 'async_pipeline_run';
// The run-level E2EE secret is kept out of the unencrypted `settings` row and
// stored in the keychain (see file header).
const PIPELINE_PRIVKEY_KEY = 'async_pipeline_privkey';

// Legacy keys from the single-slot async-job design, cleaned up once per
// process on first `getPipeline`. `async_inference_pending_job` +
// `async_inference_pending_job_privkey` were async-job-service's own constants
// (module-private there); `mera.cycle.capabilityToken` was the AsyncStorage key
// of the now-deleted `lib/llm/capability-token.ts` — kept here as a literal so
// the cleanup still purges installs that wrote it.
const LEGACY_PENDING_JOB_KEY = 'async_inference_pending_job';
const LEGACY_PENDING_JOB_PRIVKEY_KEY = 'async_inference_pending_job_privkey';
const LEGACY_CAPABILITY_TOKEN_KEY = 'mera.cycle.capabilityToken';

export type BatchPhase =
  | 'queued'
  | 'submitting-relevance'
  | 'waiting-relevance'
  | 'needs-reasons-submit' // crash-resumable gap: relevance decoded+saved, reasons POST not yet sent
  | 'submitting-reasons'
  | 'waiting-reasons'
  | 'done'
  | 'failed';

export interface PipelineBatch {
  batchId: number;
  phase: BatchPhase;
  /** Recovery batch that skips the relevance round and submits reasons directly. */
  reasonsOnly?: boolean;
  /** ≤25 ids; array order is the decode join key for `score:N` results. */
  candidateIds: string[];
  /** Round-3 B1: the primary fact this batch's candidates were grouped under
   *  (strongest owning fact via matched-topic weights). `null` for the merged
   *  tail batch (orphans + sub-3-candidate facts) and for legacy runs. Drives the
   *  per-fact status accordion + fact-stage projection. */
  factId?: string | null;
  /** Human fact statement for `factId` (the accordion label). Null for the tail
   *  batch / legacy runs. */
  factStatement?: string | null;
  /** Round-3 B1: true when this batch runs the combined judge+notes cloud job
   *  (all candidates are math-mode). A proper persisted field now (previously a
   *  `BatchWithJudge` cast). False/absent ⇒ the legacy backstop relevance→reasons
   *  path. */
  judgeMode?: boolean;
  /** Round-3 B1: judge-mode only — the above-threshold subset the judge job was
   *  built over, in the EXACT order buildJudgeCalls chunked (the `judge:N` decode
   *  join key). Distinct from candidateIds (which covers every row, incl. the
   *  sub-threshold rows persisted at submit and never sent to the judge). */
  judgedIds?: string[];
  /** Current outstanding gateway job; `placeholder-…` while `submitting-*`. */
  requestId?: string;
  /** Per-batch gateway capability token (results:read / jobs:submit-followup). */
  capabilityToken?: string;
  reasonCandidateIds?: string[];
  /** Bucketed relevance scores by candidate id. */
  relevanceMap?: Record<string, number>;
  /** Raw relevance scores — fed into the reason prompts on resubmit. */
  rawRelevanceMap?: Record<string, number>;
  /** Reset at each phase submit. */
  submittedAt?: number;
  attempt: number;
  failureReason?:
    | 'stale'
    | 'not-found'
    | 'unauthorized'
    | 'submit-failed'
    | 'attempts-exhausted';
}

export interface PipelineRun {
  /** Run-shape version. Bumped to 2 in Round-3 B1 (per-fact batches gained
   *  factId/factStatement/judgeMode/judgedIds). A persisted schema-1 run still
   *  parses cleanly (the new fields are all optional) and simply projects as one
   *  generic fact-stage — RUN_ABANDON_MS bounds its lifetime. */
  schema: 1 | 2;
  /** Unique identifier for the run. */
  runId: string;
  startedAt: number;
  algo: SigningAlgo;
  expoPushToken: string | null;
  batches: PipelineBatch[];
  /** CAS counter — bumped on every successful mutate. */
  version: number;
}

/**
 * Thrown by `mutatePipeline` when the cross-context compare-and-swap fails on
 * every attempt (another context kept winning the write race). Callers back
 * off and retry the whole read-modify-write on the next tick.
 */
export class PipelineStaleError extends Error {
  constructor(public readonly attempts: number) {
    super(`PipelineStale: CAS failed after ${attempts} attempt(s)`);
    this.name = 'PipelineStaleError';
  }
}

// ---------------------------------------------------------------------------
// Legacy cleanup (once per process)
// ---------------------------------------------------------------------------

let legacyCleanupDone = false;

/**
 * Best-effort, run-once removal of the single-slot design's persisted state.
 * Individually try/caught so a keychain hiccup on one key never blocks the
 * others or throws into `getPipeline`.
 */
async function runLegacyCleanupOnce(): Promise<void> {
  if (legacyCleanupDone) return;
  legacyCleanupDone = true;

  try {
    await deleteSetting(LEGACY_PENDING_JOB_KEY);
  } catch (err) {
    logger.warn(
      `[scoring-pipeline-store] legacy pending-job setting cleanup failed: ${String(err)}`,
    );
  }
  try {
    await secureStore.deleteItemAsync(LEGACY_PENDING_JOB_PRIVKEY_KEY);
  } catch (err) {
    logger.warn(
      `[scoring-pipeline-store] legacy pending-job privkey cleanup failed: ${String(err)}`,
    );
  }
  try {
    await AsyncStorage.removeItem(LEGACY_CAPABILITY_TOKEN_KEY);
  } catch (err) {
    logger.warn(
      `[scoring-pipeline-store] legacy capability-token cleanup failed: ${String(err)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Delete both the settings row and the keychain secret (row first). */
async function clearBoth(): Promise<void> {
  await deleteSetting(PIPELINE_KEY).catch((err: unknown) => {
    logger.captureException(err, {
      tags: { service: 'scoring-pipeline-store', step: 'clear-row' },
    });
  });
  await secureStore.deleteItemAsync(PIPELINE_PRIVKEY_KEY).catch((err: unknown) => {
    logger.captureException(err, {
      tags: { service: 'scoring-pipeline-store', step: 'clear-privkey' },
    });
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Create the pipeline run. Writes the secret to the keychain FIRST, then the
 * settings row (so a crash between the two writes leaves a recoverable secret
 * rather than a metadata row pointing at a missing key — the mirror of
 * `getPipeline`'s "missing companion key ⇒ unrecoverable" rule).
 *
 * Throws if a run already exists — the caller must append batches via
 * `mutatePipeline` instead of overwriting a live run.
 */
export async function createPipeline(
  run: Omit<PipelineRun, 'version' | 'schema'>,
  privKeyHex: string,
): Promise<void> {
  const existing = await getSetting(PIPELINE_KEY);
  if (existing) {
    throw new Error(
      'A pipeline run already exists — use mutatePipeline to append batches.',
    );
  }
  await secureStore.setItemAsync(PIPELINE_PRIVKEY_KEY, privKeyHex);
  const full: PipelineRun = { ...run, schema: 2, version: 1 };
  await setSetting(PIPELINE_KEY, JSON.stringify(full));
}

/**
 * Read the current run + its keychain secret. Returns null when no run exists.
 *
 * Self-heals two corrupt states by clearing both stores (a lost key costs one
 * re-score, never user data):
 *   - settings row present but JSON unparseable, or
 *   - settings row present but the keychain secret is missing (partial write /
 *     OS eviction).
 * A transient keychain read error (locked device on background wake) is NOT
 * treated as "missing" — it returns null WITHOUT clearing, so the next
 * foreground wake retries.
 *
 * Also performs a one-time, best-effort cleanup of the legacy single-slot keys.
 */
export async function getPipeline(): Promise<{
  run: PipelineRun;
  privKeyHex: string;
} | null> {
  await runLegacyCleanupOnce();

  const raw = await getSetting(PIPELINE_KEY);
  if (!raw) return null;

  let run: PipelineRun;
  try {
    run = JSON.parse(raw) as PipelineRun;
  } catch (err) {
    logger.captureException(err, {
      tags: { service: 'scoring-pipeline-store', method: 'getPipeline' },
    });
    logger.addBreadcrumb(
      'pipeline run row unparseable — clearing both stores',
      'scoring-pipeline-store',
    );
    await clearBoth();
    return null;
  }

  let privKeyHex: string | null;
  try {
    privKeyHex = await secureStore.getItemAsync(PIPELINE_PRIVKEY_KEY);
  } catch (err) {
    // Transient keychain error (e.g. locked device) — distinct from "not
    // found". Don't clear; retry once the keychain is accessible again.
    logger.captureException(err, {
      tags: { service: 'scoring-pipeline-store', step: 'read-privkey' },
    });
    return null;
  }

  if (!privKeyHex) {
    logger.addBreadcrumb(
      'pipeline run privkey missing — clearing both stores',
      'scoring-pipeline-store',
    );
    await clearBoth();
    return null;
  }

  return { run, privKeyHex };
}

/**
 * Clear the run: settings row first, then the keychain secret. A secret without
 * a row is harmless (getPipeline returns null and never surfaces it), so this
 * ordering is safe — it mirrors async-job-service's clear ordering.
 */
export async function clearPipeline(): Promise<void> {
  await deleteSetting(PIPELINE_KEY);
  await secureStore.deleteItemAsync(PIPELINE_PRIVKEY_KEY).catch((err: unknown) => {
    logger.captureException(err, {
      tags: { service: 'scoring-pipeline-store', step: 'clear-privkey' },
    });
  });
}

const MAX_CAS_ATTEMPTS = 3;

// In-process write serialization: a module-level promise chain guarantees that
// concurrent callers in ONE JS context never interleave their read-modify-write
// (layer 1). The cross-context CAS inside `runMutation` guards against a second
// process/native context (layer 2).
let writeQueue: Promise<unknown> = Promise.resolve();

/**
 * The ONLY write path after `createPipeline`. Applies `mutator` to a deep copy
 * of the current run and persists it with `version + 1`, under a two-layer
 * concurrency defense:
 *   1. In-process serialization via `writeQueue`.
 *   2. Cross-context CAS: the write only lands if the stored `version` still
 *      equals the version read at the start of the attempt (re-read
 *      immediately before writing). On mismatch it re-reads + re-applies, up to
 *      3 attempts, then throws `PipelineStaleError`.
 *
 * The mutator returning `null` aborts the write ('aborted'). Any other value
 * (including `undefined`) is a valid result and is returned alongside the
 * persisted run. Returns 'no-run' if no run exists.
 *
 * The keychain secret is never touched here — mutations only rewrite the
 * non-secret settings row.
 */
export async function mutatePipeline<T>(
  mutator: (run: PipelineRun) => T | null,
): Promise<{ result: T; run: PipelineRun } | 'aborted' | 'no-run'> {
  const task = writeQueue.then(() => runMutation(mutator));
  // Keep the chain alive even if this task rejects, so a thrown
  // PipelineStaleError doesn't wedge every subsequent mutate.
  writeQueue = task.then(
    () => undefined,
    () => undefined,
  );
  return task;
}

async function runMutation<T>(
  mutator: (run: PipelineRun) => T | null,
): Promise<{ result: T; run: PipelineRun } | 'aborted' | 'no-run'> {
  for (let attempt = 1; attempt <= MAX_CAS_ATTEMPTS; attempt++) {
    const rawBefore = await getSetting(PIPELINE_KEY);
    if (!rawBefore) return 'no-run';

    let current: PipelineRun;
    try {
      current = JSON.parse(rawBefore) as PipelineRun;
    } catch {
      // Corrupt row — a concurrent getPipeline will self-heal it; nothing to
      // mutate here.
      return 'no-run';
    }

    const readVersion = current.version;
    // Deep copy so the mutator can't observe partial state or mutate the
    // parsed original in place; the run is pure JSON.
    const draft = JSON.parse(JSON.stringify(current)) as PipelineRun;

    const result = mutator(draft);
    if (result === null) return 'aborted';

    // Re-read immediately before writing so a write by another context between
    // our initial read and now is detected (compare-and-swap).
    const rawLatest = await getSetting(PIPELINE_KEY);
    if (!rawLatest) return 'no-run';
    let latestVersion: number;
    try {
      latestVersion = (JSON.parse(rawLatest) as PipelineRun).version;
    } catch {
      // Someone corrupted it under us — treat as a conflict and retry.
      continue;
    }
    if (latestVersion !== readVersion) {
      // Lost the race — re-read and re-apply.
      continue;
    }

    draft.version = readVersion + 1;
    await setSetting(PIPELINE_KEY, JSON.stringify(draft));
    return { result: result as T, run: draft };
  }

  throw new PipelineStaleError(MAX_CAS_ATTEMPTS);
}
