// Async inference job — persistent pending-job lock + last-nudge tracker.
// Backed by the existing key/value `settings` table to avoid a schema migration.
//
// - `pendingAsyncJob` must survive app cold-start so a submit → push → reconcile
//   cycle that spans a process restart doesn't double-submit.
// - `lastNudgeAt` gates the on-device hourly nudge so we don't spam the user.

import logger from '@/lib/logger';
import { secureStore } from '@/lib/utils/secure-store-adapter';
import {
  deleteSetting,
  getSetting,
  setSetting,
} from './setting-service';

const PENDING_JOB_KEY = 'async_inference_pending_job';
// The per-cycle Ed25519 secret (used to decrypt E2EE responses on reconcile)
// is sensitive, so it is kept OUT of the unencrypted WatermelonDB `settings`
// row and stored in expo-secure-store (keychain, pinned to
// AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY via the adapter — the accessibility the
// background reconcile needs when it wakes from a silent push while locked).
const PENDING_JOB_PRIVKEY_KEY = 'async_inference_pending_job_privkey';
const LAST_NUDGE_KEY = 'async_inference_last_nudge';
const CYCLE_STATE_KEY = 'inference_cycle_state';
const NOTIF_DISPATCHED_KEY = 'inference_cycle_notif_dispatched_for';

/** The two protocol-level phases the gateway understands. The state machine
 *  drives client-side branching; this is just the wire-protocol marker. */
export type AsyncJobPhase = 'relevance' | 'reasons';

/** Single source of truth for cycle progress. Persisted to the settings
 *  table so a process kill mid-cycle recovers cleanly on next app open
 *  via `recoverCycle()` in the state-machine module. */
export type InferenceCycleState =
  | 'idle'
  | 'submitting-relevance'
  | 'waiting-for-relevance'
  | 'unpacking-relevance'
  | 'submitting-reason'
  | 'waiting-for-reason'
  | 'unpacking-reason';

export async function getCycleState(): Promise<InferenceCycleState> {
  const raw = await getSetting(CYCLE_STATE_KEY);
  if (!raw) return 'idle';
  return (raw as InferenceCycleState) ?? 'idle';
}

export async function setCycleState(next: InferenceCycleState): Promise<void> {
  await setSetting(CYCLE_STATE_KEY, next);
}

/** Records the `idempotencyKey` of the last cycle whose reason-phase notif
 *  was dispatched. `unpacking-reason` consults this before firing the local
 *  "X impactful articles" notification so a re-run after a crash doesn't
 *  double-notify. */
export async function getNotifDispatchedFor(): Promise<string | null> {
  return await getSetting(NOTIF_DISPATCHED_KEY);
}

export async function setNotifDispatchedFor(key: string): Promise<void> {
  await setSetting(NOTIF_DISPATCHED_KEY, key);
}

export interface PendingAsyncJob {
  requestId: string;
  /** Two-phase flow: 'relevance' = score-only round, 'reasons' = reason-only
   *  round for the subset that qualified. Legacy records missing `phase` are
   *  treated as 'reasons' by the reconciler for backwards compat. */
  phase: AsyncJobPhase;
  candidateIds: string[];
  /** Ordered list of BatchCall ids submitted to the inference server, e.g.
   *  `score:0`, `score:1`, …, `reason:<articleId>`. Only the ids are
   *  persisted — the full prompt/system bodies live in `bundle.calls` in
   *  memory until the request is sent, then are dropped. Persisting the
   *  prompts blew past Android's 2 MB per-row CursorWindow limit on large
   *  reason batches (~960 KB JSON for 451 calls). Reconciliation only
   *  needs the ids: result decoding maps `score:N` → candidate chunk via
   *  `candidateIds` + the chunk size, and `reason:<id>` is self-encoding. */
  callIds: string[];
  /** Populated after phase-1 completes. Carried into phase-2 so the reconciler
   *  can derive impactful/emergency id sets from a single source of truth (not
   *  re-querying the DB, which might have been partially updated by a
   *  concurrent sync). */
  relevanceMap?: Record<string, number>;
  submittedAt: number;
  /** Null when the device has no registered Expo push token. The job still
   *  submits; results are retrieved by foreground polling instead of a
   *  gateway silent-push wake. */
  expoPushToken: string | null;
  modelCalls: number;
  /** Hex-encoded Ed25519 secret used to decrypt E2EE responses on reconcile.
   *  Device-local only; never leaves this device. */
  clientPrivKeyHex: string;
  /** UUID assigned at cycle start (when state moves out of `idle`). Used by
   *  `unpacking-reason` to dedupe the local "X impactful articles" push so
   *  a recovery re-run doesn't double-notify the user. Survives the phase-1
   *  → phase-2 transition unchanged — both phases belong to the same cycle. */
  idempotencyKey?: string;
}

export async function getPendingAsyncJob(): Promise<PendingAsyncJob | null> {
  const raw = await getSetting(PENDING_JOB_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as PendingAsyncJob & {
      // Legacy field: rows written before the calls→callIds slim-down stored
      // the full BatchCall[] inline. Migrate on read so an in-flight cycle
      // survives the app upgrade.
      calls?: { id: string }[];
    };
    if (!parsed.callIds && Array.isArray(parsed.calls)) {
      parsed.callIds = parsed.calls.map((c) => c.id);
      delete parsed.calls;
    }

    // The secret key lives in secure-store, not in the SQLite row. Legacy rows
    // written before this split still carry an inline `clientPrivKeyHex` and no
    // secure-store companion; for those, drop the stale row and re-submit
    // (the secret is per-cycle and disposable — a lost key costs one re-score,
    // never user data). New rows have an empty `clientPrivKeyHex` in the JSON.
    if (parsed.clientPrivKeyHex) {
      await deleteSetting(PENDING_JOB_KEY).catch((err: unknown) => {
        logger.captureException(err, {
          tags: { service: 'async-job-service', step: 'clear-legacy-job-setting' },
        });
      });
      await secureStore
        .deleteItemAsync(PENDING_JOB_PRIVKEY_KEY)
        .catch((err: unknown) => {
          logger.captureException(err, {
            tags: { service: 'async-job-service', step: 'clear-legacy-privkey' },
          });
        });
      return null;
    }

    let privKeyHex: string | null;
    try {
      privKeyHex = await secureStore.getItemAsync(PENDING_JOB_PRIVKEY_KEY);
    } catch (err) {
      // Transient keychain error (e.g. locked device on background wake) —
      // distinct from "key not found". Don't clear the pending job row; the
      // next foreground wake will retry once the keychain is accessible again.
      logger.captureException(err, {
        tags: { service: 'async-job-service', step: 'read-privkey' },
      });
      return null;
    }
    if (!privKeyHex) {
      // Secret missing (partial write / OS eviction) — the pending job is
      // unrecoverable. Clear both stores and re-submit on the next cycle.
      await deleteSetting(PENDING_JOB_KEY).catch((err: unknown) => {
        logger.captureException(err, {
          tags: { service: 'async-job-service', step: 'clear-orphaned-job-setting' },
        });
      });
      await secureStore
        .deleteItemAsync(PENDING_JOB_PRIVKEY_KEY)
        .catch((err: unknown) => {
          logger.captureException(err, {
            tags: { service: 'async-job-service', step: 'clear-orphaned-privkey' },
          });
        });
      return null;
    }
    parsed.clientPrivKeyHex = privKeyHex;
    return parsed;
  } catch (err) {
    logger.captureException(err, {
      tags: { service: 'async-job-service', method: 'getPendingAsyncJob' },
    });
    await deleteSetting(PENDING_JOB_KEY).catch((err: unknown) => {
      logger.captureException(err, {
        tags: { service: 'async-job-service', step: 'clear-corrupted-job-setting' },
      });
    });
    await secureStore.deleteItemAsync(PENDING_JOB_PRIVKEY_KEY).catch((err: unknown) => {
      logger.captureException(err, {
        tags: { service: 'async-job-service', step: 'clear-corrupted-privkey' },
      });
    });
    return null;
  }
}

/**
 * Thrown by the CAS-guarded variants of setPendingAsyncJob / clearPendingAsyncJob
 * when the stored `requestId` does not match the caller's expectation. Callers
 * interpret this as "another worker got here first — back off".
 */
export class PendingJobStaleError extends Error {
  constructor(
    public readonly expected: string | null,
    public readonly actual: string | null,
  ) {
    super(
      `PendingJobStale: expected=${expected ?? 'null'} actual=${actual ?? 'null'}`,
    );
    this.name = 'PendingJobStaleError';
  }
}

/**
 * Write the pending-job row.
 *
 * With `expectedRequestId` supplied, performs a compare-and-swap: reads the
 * current row, verifies its `requestId` matches `expectedRequestId` (use
 * `null` to require "no row present"), and only then writes. Mismatch throws
 * `PendingJobStaleError` — the caller is no longer the authoritative writer.
 *
 * Without `expectedRequestId`, writes unconditionally (initial empty-slot
 * submit from `submitInferenceJob` where the caller has already verified the
 * slot is empty via `getPendingAsyncJob`).
 */
export async function setPendingAsyncJob(
  job: PendingAsyncJob,
  opts?: { expectedRequestId: string | null },
): Promise<void> {
  if (opts) {
    const existing = await getPendingAsyncJob();
    const actual = existing?.requestId ?? null;
    if (actual !== opts.expectedRequestId) {
      throw new PendingJobStaleError(opts.expectedRequestId, actual);
    }
  }
  // Split the secret out of the SQLite row: the keychain holds the Ed25519
  // secret; the unencrypted `settings` row holds only non-secret metadata.
  // Write the secret first so a crash between the two writes leaves a
  // recoverable secret rather than a metadata row pointing at a missing key
  // (getPendingAsyncJob treats a missing companion key as unrecoverable).
  await secureStore.setItemAsync(PENDING_JOB_PRIVKEY_KEY, job.clientPrivKeyHex);
  const { clientPrivKeyHex: _omit, ...metadata } = job;
  await setSetting(PENDING_JOB_KEY, JSON.stringify(metadata));
}

/**
 * Clear the pending-job row, optionally CAS-guarded by `expectedRequestId`.
 * Mismatch throws `PendingJobStaleError` so a loser in a race does not wipe
 * the winner's record.
 */
export async function clearPendingAsyncJob(
  opts?: { expectedRequestId: string | null },
): Promise<void> {
  if (opts) {
    const existing = await getPendingAsyncJob();
    const actual = existing?.requestId ?? null;
    if (actual !== opts.expectedRequestId) {
      throw new PendingJobStaleError(opts.expectedRequestId, actual);
    }
  }
  await deleteSetting(PENDING_JOB_KEY);
  // Delete the secret companion explicitly so it never outlives the cycle —
  // after the split it is no longer implicitly cleared with the settings row.
  await secureStore.deleteItemAsync(PENDING_JOB_PRIVKEY_KEY).catch((err: unknown) => {
    logger.captureException(err, {
      tags: { service: 'async-job-service', step: 'clear-privkey' },
    });
  });
}

export async function getLastNudgeAt(): Promise<number | null> {
  const raw = await getSetting(LAST_NUDGE_KEY);
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

export async function setLastNudgeAt(timestamp: number): Promise<void> {
  await setSetting(LAST_NUDGE_KEY, String(timestamp));
}
