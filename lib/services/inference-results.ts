// inference-results — shared fetch/decode/persist primitives for cloud
// inference jobs. These are the reusable helpers the multi-batch scoring
// pipeline (lib/services/scoring-pipeline.ts) builds on: authenticate + GET a
// job's /results, decrypt each row into a BatchCompletionResult, reconstruct
// the chunk→candidate lookup, and discard freshly-scored low-relevance rows.
//
// (The legacy single-slot two-phase reconciler that used to live here — and its
// submit/notify orchestration — was removed once every trigger moved to the
// pipeline; only these stateless primitives survive.)

import { fetch as expoFetch } from 'expo/fetch';
import * as Sentry from '@sentry/react-native';
import logger from '@/lib/logger';
import { getJwtToken } from '@/lib/auth-client';
import { decryptContent, type SigningAlgo } from '@/lib/e2ee/e2ee-service';
import {
  batchMarkReasonSkipped,
  type ScoringCandidate,
} from '@/lib/database/services/article-suggestion-service';
import { CLOUD_SCORE_CHUNK_SIZE } from '@/lib/mera-protocol/scoring-service';
import type { ExecutionContext } from '@/lib/llm/execution-context';
import type { BatchCompletionResult } from '@/lib/llm/cloudComplete';
import { INFERENCE_ENDPOINT } from '@/lib/config/endpoints';

const TAG = '[inference-results]';

// Hard wall-clock timeout on the /results GET. Without it a hung socket
// (captive portal / dead connection) leaves the await pending forever, which
// freezes the scoring poller's `runPollerTick` finally, pins `pollTickRunning`
// true, kills the 7s poller, and leaves the pipeline stuck 'running' — so
// feed-sync (which skips while scoring is in flight) never fetches again.
const RESULTS_FETCH_TIMEOUT_MS = 30_000;

// Bucketed-relevance floor that gates phase-2 LLM reason generation. Replaces
// the old per-user notificationSensitivity knob — kept at the same value the
// old code defaulted to so behaviour is unchanged for users who never moved
// the slider. Consumed by the pipelined-batch orchestrator's impactful-subset
// gate.
export const REASON_RELEVANCE_THRESHOLD = 0.3;

// ---------------------------------------------------------------------------
// Result shape
// ---------------------------------------------------------------------------

export interface ServerResults {
  requestId: string;
  results: Array<{
    id: string;
    ok: boolean;
    response?: UpstreamResponse;
    error?: string;
  }>;
}

interface UpstreamResponse {
  choices?: Array<{
    message?: {
      content?: string;
      reasoning_content?: string;
    };
    finish_reason?: string;
  }>;
}

// ---------------------------------------------------------------------------
// Auth + fetch
// ---------------------------------------------------------------------------

/** Build the Authorization header for a /results GET. Foreground prefers the
 *  keychain JWT and falls back to the per-batch `capabilityToken` if
 *  `getJwtToken` throws or returns null. Background uses the per-batch
 *  capability token only — never reads the keychain on a silent-push wake.
 *  Throws if no usable credential exists for the context.
 *
 *  `capabilityToken` is the batch's own per-batch token (each pipeline batch
 *  carries a distinct one). */
export async function pickResultsAuthHeader(
  context: ExecutionContext,
  requestId: string,
  capabilityToken?: string,
): Promise<string> {
  if (context === 'foreground') {
    let jwt: string | null = null;
    try {
      jwt = await getJwtToken();
    } catch (err) {
      logger.warn(
        `${TAG} foreground getJwtToken threw — trying capability token: ${String(err)}`,
      );
    }
    if (jwt) return `Bearer ${jwt}`;
    if (capabilityToken) {
      logger.warn(
        `${TAG} foreground using capability-token fallback for /results (JWT unavailable)`,
      );
      return `Bearer ${capabilityToken}`;
    }
    Sentry.addBreadcrumb({
      category: 'auth',
      level: 'warning',
      message: 'foreground /results: no JWT and no capability token',
      data: { requestId },
    });
    throw new Error('no auth available (foreground)');
  }
  if (!capabilityToken) {
    Sentry.addBreadcrumb({
      category: 'auth',
      level: 'warning',
      message: 'background /results: no capability token',
      data: { requestId },
    });
    throw new Error('no capability token available (background)');
  }
  return `Bearer ${capabilityToken}`;
}

export async function fetchResults(
  requestId: string,
  context: ExecutionContext,
  capabilityToken?: string,
): Promise<ServerResults | 'pending' | 'not-found' | 'unauthorized'> {
  // Per-context auth.
  //   Foreground: prefer the keychain JWT; fall back to the per-batch
  //     capability token if the keychain is transiently unavailable.
  //   Background: per-batch capability token only — never touch the keychain
  //     on a silent-push wake (locked-device → SecureStore throws).
  const authHeader = await pickResultsAuthHeader(context, requestId, capabilityToken);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RESULTS_FETCH_TIMEOUT_MS);
  let res: Awaited<ReturnType<typeof globalThis.fetch>>;
  try {
    res = await (expoFetch as unknown as typeof globalThis.fetch)(
      `${INFERENCE_ENDPOINT}/v1/inference/jobs/${requestId}/results`,
      {
        method: 'GET',
        headers: { Authorization: authHeader },
        signal: controller.signal,
      },
    );
  } finally {
    clearTimeout(timer);
  }

  if (res.status === 404) return 'not-found';
  // The capability token carries a 2h TTL. A 401/403 here means the token
  // expired or was rejected server-side — unrecoverable by retrying with the
  // same token, so treat it like 404: the caller drops the batch/job and
  // resubmits fresh, rather than retrying forever as a transient error.
  if (res.status === 401 || res.status === 403) return 'unauthorized';
  if (!res.ok) {
    let bodyStr = '';
    try {
      const bodyText = await res.text();
      try {
        bodyStr = JSON.stringify(JSON.parse(bodyText));
      } catch {
        bodyStr = bodyText;
      }
    } catch {
      bodyStr = '<unreadable body>';
    }
    throw new Error(`results fetch ${res.status} ${bodyStr}`);
  }

  const text = await res.text();
  const parsed: unknown = JSON.parse(text);
  if (
    parsed &&
    typeof parsed === 'object' &&
    'pending' in parsed &&
    (parsed as { pending?: boolean }).pending === true
  ) {
    return 'pending';
  }
  return parsed as ServerResults;
}

// ---------------------------------------------------------------------------
// Decode
// ---------------------------------------------------------------------------

export function toBatchResult(
  row: ServerResults['results'][number],
  privKey: Uint8Array,
  algo: SigningAlgo,
): BatchCompletionResult {
  if (!row.ok) {
    return { id: row.id, output: '', error: row.error ?? 'unknown' };
  }
  const choice = row.response?.choices?.[0];
  const encContent =
    choice?.message?.content ?? choice?.message?.reasoning_content ?? '';
  if (!encContent) return { id: row.id, output: '' };

  try {
    const output = decryptContent(encContent, privKey, algo).trim();
    return { id: row.id, output };
  } catch (err) {
    return {
      id: row.id,
      output: '',
      error: err instanceof Error ? err.message : 'decrypt error',
    };
  }
}

export function reconstructLookups(
  callIds: string[],
  candidateIds: string[],
): {
  chunkIdToCandidates: Map<string, ScoringCandidate[]>;
} {
  const chunkIdToCandidates = new Map<string, ScoringCandidate[]>();

  for (const callId of callIds) {
    if (callId.startsWith('score:')) {
      const idx = Number(callId.slice('score:'.length));
      const start = idx * CLOUD_SCORE_CHUNK_SIZE;
      const chunkIds = candidateIds.slice(
        start,
        start + CLOUD_SCORE_CHUNK_SIZE,
      );
      const chunkCandidates: ScoringCandidate[] = chunkIds.map((id) => ({
        id,
        titleEn: null,
        descriptionEn: null,
        countryCode: null,
        userTopicIds: [],
        relatedFacts: [],
      }));
      chunkIdToCandidates.set(callId, chunkCandidates);
    }
  }

  return { chunkIdToCandidates };
}

// ---------------------------------------------------------------------------
// Persist helpers
// ---------------------------------------------------------------------------

/**
 * Watermelon throws `Record <table>#<id> not found` when an update targets a
 * row that has since been deleted (typically because syncFeed dropped it after
 * the server's id-set shrank). Treat as a benign skip — not a real error.
 */
export function isRecordNotFoundError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /Record\s+\S+\s+not\s+found/i.test(msg);
}

const KEEP_RELEVANCE_THRESHOLD = 0.3;

/**
 * Finalize freshly-scored rows whose relevance ≤ KEEP_RELEVANCE_THRESHOLD as
 * scored-low tombstones — `batchMarkReasonSkipped` sets `status=Complete` in
 * one batched write, keeping the same ids/local pk rather than deleting the
 * rows. This is the *only* path that mutates article_suggestions during a
 * cycle.
 *
 * Rows must be kept, not deleted: feed-sync's `stepDiff` compares server ids
 * against every physically-present local row, so a deleted id looks "missing"
 * on the very next sync and gets re-downloaded and re-scored — an infinite
 * discard/re-hydrate churn loop. Tombstoning avoids this because the id stays
 * present locally. The tombstones are invisible to the user (every UI layer
 * filters to `relevance > KEEP_RELEVANCE_THRESHOLD`), are never re-scored
 * (`getUnscoredSuggestionsWithFacts` only selects `status=Unscored`) or picked
 * up for reasons (`enqueueOrphanedReasons` filters to `relevance >
 * REASON_RELEVANCE_THRESHOLD`), and are eventually pruned by the 48h
 * data-cleanup task.
 *
 * (The old comment here claimed discarded ids "stay marked as processed in
 * `synced_suggestion_ids`" — that tombstone table was dropped in migration
 * v24 and nothing ever wrote to it, so this path was silently hard-deleting
 * rows and causing the churn loop described above.)
 */
export async function discardLowRelevance(
  candidateIds: string[],
  relevanceMap: Record<string, number>,
): Promise<number> {
  const toDiscard = candidateIds.filter((id) => {
    const r = relevanceMap[id];
    return r !== undefined && r <= KEEP_RELEVANCE_THRESHOLD;
  });
  if (toDiscard.length === 0) return 0;
  await batchMarkReasonSkipped(toDiscard);
  return toDiscard.length;
}

export function hexToBytes(hex: string): Uint8Array {
  const len = hex.length / 2;
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}
