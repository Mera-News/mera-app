// async-job-reconciler — two-phase fetch/decode/persist/dispatch.
//
// Phase 1 ('relevance'): decode score results, bucket + save relevance to the
// local DB with reason empty. If any rows clear REASON_RELEVANCE_THRESHOLD,
// submit a phase-2 job for reasons. Otherwise clear pending silently —
// nothing is impactful, no notification.
//
// Phase 2 ('reasons'): decode reason results, save each reason, clear
// pending, dispatch the notification using the phase-1-derived relevanceMap
// as the source of truth for impactful membership.
//
// Entry paths (all idempotent): silent-push task, expo-background-task fire,
// AppState→active foreground fallback, pull-to-refresh.

import { fetch as expoFetch } from 'expo/fetch';
import { Directory, File, Paths } from 'expo-file-system';
import * as Sentry from '@sentry/react-native';
import logger from '@/lib/logger';
import { getJwtToken } from '@/lib/auth-client';
import {
  clearCapabilityToken,
  getCapabilityToken,
} from '@/lib/llm/capability-token';
import {
  decryptContent,
  prepareE2EEContext,
} from '@/lib/e2ee/e2ee-service';
import {
  clearPendingAsyncJob,
  getNotifDispatchedFor,
  getPendingAsyncJob,
  PendingJobStaleError,
  setCycleState,
  setNotifDispatchedFor,
  setPendingAsyncJob,
  type PendingAsyncJob,
} from '@/lib/database/services/async-job-service';
import { useForYouStore } from '@/lib/stores/for-you-store';
import { useUserStore } from '@/lib/stores/user-store';
import {
  batchMarkReasonSkipped,
  deleteSuggestionsByServerIds,
  getScoredSuggestionsWithoutReasons,
  getUnscoredSuggestionsWithFacts,
  saveReason,
  saveScoringResult,
  type ScoringCandidate,
} from '@/lib/database/services/article-suggestion-service';
import {
  bucketScores,
  buildReasonCallsForSubset,
  decodeResults,
  CLOUD_SCORE_CHUNK_SIZE,
  REASON_MIN_RAW_SCORE,
} from '@/lib/mera-protocol/scoring-service';
import { dispatchResultsNotification } from './notification-dispatch';
import {
  bytesToHex,
  sendInferenceRequest,
} from '@/lib/llm/submitInferenceJob';
import type { ExecutionContext } from '@/lib/llm/execution-context';
import { SMALL_MODEL } from '@/lib/llm/constants';
import type { BatchCompletionResult } from '@/lib/llm/cloudComplete';
import {
  INFERENCE_ENDPOINT,
  DUMP_QUERIES_ENABLED as DUMP_RESULTS_ENABLED,
} from '@/lib/config/endpoints';

const TAG = '[async-job-reconciler]';

const STALE_AFTER_MS = 60 * 60 * 1000;

// Bucketed-relevance floor that gates phase-2 LLM reason generation. Replaces
// the old per-user notificationSensitivity knob — kept at the same value the
// old code defaulted to so behaviour is unchanged for users who never moved
// the slider.
const REASON_RELEVANCE_THRESHOLD = 0.3;


export type ReconcileResult = 'completed' | 'pending' | 'stale' | 'error';

/**
 * Module-scope single-flight guard. Every trigger (silent push, OS periodic
 * task, AppState→active, cold-start) funnels through
 * `reconcileAsyncJobResults`. If two triggers fire in the same JS context
 * within the reconcile window, the second call returns the first's live
 * Promise instead of racing. Paired with the DB-level CAS in
 * `setPendingAsyncJob` for cross-context defense (silent-push task vs. main
 * foreground context may not share module state on all platforms).
 */
let inFlight: Promise<ReconcileResult> | null = null;

export async function reconcileAsyncJobResults(
  context: ExecutionContext,
  requestId?: string,
): Promise<ReconcileResult> {
  if (inFlight) return inFlight;
  inFlight = reconcileAsyncJobResultsInner(context, requestId).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function reconcileAsyncJobResultsInner(
  context: ExecutionContext,
  requestId?: string,
): Promise<ReconcileResult> {
  const pending = await getPendingAsyncJob();
  if (!pending) return 'completed';
  if (requestId && pending.requestId !== requestId) {
    logger.warn(
      `${TAG} requestId mismatch pending=${pending.requestId} asked=${requestId}`,
    );
  }

  const effectiveId = pending.requestId;

  const age = Date.now() - pending.submittedAt;
  if (age > STALE_AFTER_MS) {
    logger.warn(`${TAG} job ${effectiveId} stale (${Math.round(age / 1000)}s)`);
    await clearPendingAsyncJob().catch((err: unknown) => {
      logger.captureException(err, {
        tags: { service: 'async-job-reconciler', step: 'clear-stale-job' },
        extra: { requestId: effectiveId },
      });
    });
    await clearCapabilityToken();
    await setCycleState('idle');
    useForYouStore.getState().setAsyncJobPhase('idle');
    return 'stale';
  }

  // Placeholder requestId means the prior submitInferenceJob crashed between
  // claiming the slot and writing back the server-issued id. We no longer
  // persist the full `calls` payload (it overflowed Android's 2 MB per-row
  // CursorWindow), so we can't resubmit from the placeholder — instead clear
  // the stuck slot once it's old enough that the original submit isn't still
  // in-flight, and let the next sync cycle resubmit fresh from current DB
  // state.
  //
  // Age-gated: a fresh placeholder may be owned by an in-flight submit in
  // this same process (the POST + gzip + server-ack can easily take 20–40s on
  // a big payload). Don't wipe a slot that may still be claimed by a live
  // submit.
  if (effectiveId.startsWith('placeholder-')) {
    const PLACEHOLDER_STUCK_MS = 60_000;
    const placeholderAge = Date.now() - (pending.submittedAt ?? 0);
    if (placeholderAge < PLACEHOLDER_STUCK_MS) {
      logger.info(
        `${TAG} placeholder still fresh (age=${placeholderAge}ms) — skipping`,
      );
      return 'pending';
    }
    logger.warn(
      `${TAG} placeholder stuck (age=${placeholderAge}ms) — clearing slot; next cycle will resubmit`,
    );
    await clearPendingAsyncJob({ expectedRequestId: pending.requestId }).catch(
      (err: unknown) => {
        if (!(err instanceof PendingJobStaleError)) throw err;
      },
    );
    await clearCapabilityToken();
    await setCycleState('idle');
    useForYouStore.getState().setAsyncJobPhase('idle');
    return 'stale';
  }

  let rawResults: ServerResults;
  try {
    const ageSec = Math.round(age / 1000);
    const res = await fetchResults(effectiveId, context);
    if (res === 'pending') {
      logger.info(
        `${TAG} fetchResults → pending requestId=${effectiveId} phase=${pending.phase ?? 'legacy'} age=${ageSec}s`,
      );
      return 'pending';
    }
    if (res === 'not-found') {
      logger.warn(`${TAG} fetchResults → not-found requestId=${effectiveId}`);
      await clearPendingAsyncJob().catch((err: unknown) => {
        logger.captureException(err, {
          tags: { service: 'async-job-reconciler', step: 'clear-not-found-job' },
          extra: { requestId: effectiveId },
        });
      });
      await clearCapabilityToken();
      await setCycleState('idle');
      useForYouStore.getState().setAsyncJobPhase('idle');
      return 'stale';
    }
    logger.info(
      `${TAG} fetchResults → completed requestId=${effectiveId} phase=${pending.phase ?? 'legacy'} rows=${res.results.length}`,
    );
    rawResults = res;
  } catch (err) {
    logger.captureException(err, {
      tags: { service: 'async-job-reconciler', step: 'fetch' },
    });
    return 'error';
  }

  // Legacy pending records without `phase` → the old combined-flow reconcile.
  // The decoder handles score: + reason: uniformly; dispatch fires as before.
  const phase = pending.phase ?? 'reasons';

  try {
    if (phase === 'relevance') {
      await setCycleState('unpacking-relevance');
      return await reconcileRelevancePhase(pending, rawResults, context);
    }
    await setCycleState('unpacking-reason');
    return await reconcileReasonPhase(pending, rawResults);
  } catch (err) {
    logger.captureException(err, {
      tags: { service: 'async-job-reconciler', step: 'apply', phase },
    });
    return 'error';
  }
}

// ---------------------------------------------------------------------------
// Phase 1 — relevance completed
// ---------------------------------------------------------------------------

async function reconcileRelevancePhase(
  pending: PendingAsyncJob,
  server: ServerResults,
  context: ExecutionContext,
): Promise<ReconcileResult> {
  // Flip the UI status to the phase-2 message as soon as relevance results
  // arrive — decoding + persisting + submitting reasons takes a few seconds
  // and we don't want the feed stuck on "Sifting through…" while that runs.
  // The actual phase-2 submit a few hundred lines below also calls
  // setAsyncJobPhase('reasons', ...) with fresh counts; this is just an
  // earlier UI hint.
  useForYouStore.getState().setAsyncJobPhase('reasons');
  const privKey = hexToBytes(pending.clientPrivKeyHex);
  const batchResults: BatchCompletionResult[] = server.results.map((r) =>
    toBatchResult(r, privKey),
  );

  if (DUMP_RESULTS_ENABLED) {
    dumpResultsForDev('relevance', batchResults, server.results).catch(
      (err: unknown) => {
        logger.warn(`${TAG} results dump failed: ${String(err)}`);
      },
    );
  }

  const { chunkIdToCandidates } = reconstructLookups(
    pending.callIds,
    pending.candidateIds,
  );

  const { scoreMap, failedIds } = decodeResults({
    batchResults,
    promptsById: new Map(),
    chunkIdToCandidates,
  });
  // Preserve the raw (pre-bucket) scores so phase-2 reason generation receives
  // the LLM's actual estimate — not the 0.4/0.6/0.8/1.1 bucket midpoint. The
  // reason prompt instructs the model to "explain, don't re-judge" the score,
  // so feeding it a coarse bucket value produced over-confident narration for
  // borderline-low scores. Storage + sensitivity filtering still use buckets.
  const rawRelevanceMap: Record<string, number> = {};
  for (const [id, raw] of scoreMap) rawRelevanceMap[id] = raw;

  bucketScores(scoreMap);

  const relevanceMap: Record<string, number> = {};
  for (const candidateId of pending.candidateIds) {
    if (failedIds.has(candidateId)) continue;
    const relevance = scoreMap.get(candidateId);
    if (relevance === undefined) continue;
    relevanceMap[candidateId] = relevance;
    try {
      // Persist relevance now; reason empty + not skipped + not failed resolves
      // to status='reason_pending', which is exactly how we want the DB to
      // signal "reason pending" for phase-2 readers.
      await saveScoringResult(candidateId, {
        relevance,
        reason: '',
        reasonSkipped: false,
      });
    } catch (err) {
      // Benign: the local row was deleted by a concurrent syncFeed cleanup
      // because the server's `unscoredArticleSuggestionIds` no longer
      // includes it. Skip silently — not a real error.
      if (isRecordNotFoundError(err)) {
        continue;
      }
      logger.captureException(err, {
        tags: { service: 'async-job-reconciler', step: 'save-relevance' },
        extra: { candidateId },
      });
    }
  }

  const { refreshSuggestionsInStoreUnsafe } = await import(
    './SuggestionSyncService'
  );
  await refreshSuggestionsInStoreUnsafe();

  // Decide which candidates need reasons:
  //   (a) bucketed relevance clears REASON_RELEVANCE_THRESHOLD, AND
  //   (b) the *raw* pre-bucket score clears REASON_MIN_RAW_SCORE — so the
  //       weakest bucketed-up rows (e.g. raw 0.41 → bucket 0.4) don't burn
  //       reason-gen compute on a match the model barely believed in.
  const impactfulIds = Object.keys(relevanceMap).filter(
    (id) =>
      relevanceMap[id] > REASON_RELEVANCE_THRESHOLD &&
      (rawRelevanceMap[id] ?? 0) >= REASON_MIN_RAW_SCORE,
  );

  if (impactfulIds.length === 0) {
    logger.info(
      `${TAG} phase=relevance done, no impactful rows (threshold=${REASON_RELEVANCE_THRESHOLD}) — skipping phase 2`,
    );
    // Discard low-relevance rows from article_suggestions, mark every
    // candidate processed in synced_suggestion_ids, then either chain the
    // next batch or go idle. Order: clear pending → discard → mark → chain.
    await clearPendingAsyncJob({ expectedRequestId: pending.requestId }).catch(
      (err: unknown) => {
        if (!(err instanceof PendingJobStaleError)) throw err;
      },
    );
    await clearCapabilityToken();
    const discardedCount = await discardLowRelevance(
      pending.candidateIds,
      relevanceMap,
    );
    if (discardedCount > 0) {
      logger.info(`${TAG} discarded ${discardedCount} low-relevance rows`);
    }
    await finishCycle();
    return 'completed';
  }

  // Rebuild full candidate records for the impactful subset — the stored
  // pending-job `candidateIds` is just ids; reason prompts need title, body,
  // related facts. After phase-1 save the impactful rows match
  // (relevance_completed=true && reason_completed=false), so the
  // scored-without-reasons query hydrates them with facts identically to
  // the phase-1 loader.
  const idSet = new Set(impactfulIds);
  const scoredWithoutReasons = await getScoredSuggestionsWithoutReasons();
  const subsetCandidates: ScoringCandidate[] = scoredWithoutReasons.filter(
    (c) => idSet.has(c.id),
  );

  logger.info(
    `${TAG} phase=relevance done: scored=${Object.keys(relevanceMap).length} impactful=${impactfulIds.length} (threshold=${REASON_RELEVANCE_THRESHOLD}, REASON_MIN_RAW=${REASON_MIN_RAW_SCORE})`,
  );
  const reasonBundle = await buildReasonCallsForSubset(
    subsetCandidates,
    rawRelevanceMap,
    REASON_RELEVANCE_THRESHOLD,
  );
  const reasonIds = reasonBundle.eligibleCandidates.map((c) => c.id);
  logger.info(
    `${TAG} reason gen: ${reasonIds.length} ids in ${reasonBundle.calls.length} calls`,
  );
  if (reasonBundle.calls.length === 0) {
    // Every impactful row was ineligible (missing title/facts) — nothing to
    // ask for. Clear pending, dispatch notification, then run the same
    // discard + mark-processed + auto-chain dance as the impactful=0 branch.
    await clearPendingAsyncJob({ expectedRequestId: pending.requestId }).catch(
      (err: unknown) => {
        if (!(err instanceof PendingJobStaleError)) throw err;
      },
    );
    await clearCapabilityToken();
    await dispatchResultsNotification({
      scoredIds: Object.keys(relevanceMap),
    });
    const discardedCount = await discardLowRelevance(
      pending.candidateIds,
      relevanceMap,
    );
    if (discardedCount > 0) {
      logger.info(`${TAG} discarded ${discardedCount} low-relevance rows`);
    }
    await finishCycle();
    return 'completed';
  }

  // Submit phase 2 inline. Capability token in AsyncStorage covers the POST
  // (scope `jobs:submit-followup`), so this works from background as well as
  // foreground — no keychain access required. CAS-claim the slot on a
  // placeholder before submitting so a concurrent reconciler in another JS
  // context can't double-submit.
  await setCycleState('submitting-reason');
  const phase2Model = SMALL_MODEL;
  const ctx = await prepareE2EEContext(phase2Model);
  const token = pending.expoPushToken;

  const placeholderRequestId = makePlaceholderRequestId();
  const placeholder: PendingAsyncJob = {
    requestId: placeholderRequestId,
    phase: 'reasons',
    candidateIds: reasonBundle.eligibleCandidates.map((c) => c.id),
    callIds: reasonBundle.calls.map((c) => c.id),
    relevanceMap,
    submittedAt: Date.now(),
    expoPushToken: token,
    modelCalls: reasonBundle.calls.length,
    clientPrivKeyHex: bytesToHex(ctx.privateKey),
    idempotencyKey: pending.idempotencyKey,
  };
  try {
    await setPendingAsyncJob(placeholder, {
      expectedRequestId: pending.requestId,
    });
  } catch (err) {
    if (err instanceof PendingJobStaleError) {
      logger.warn(
        `${TAG} CAS lost — concurrent reconcile already claimed the slot, skipping phase-2 submit`,
      );
      return 'completed';
    }
    throw err;
  }

  const newRequestId = await sendInferenceRequest({
    bundle: reasonBundle,
    ctx,
    token,
    model: phase2Model,
    context,
  });
  if (!newRequestId) {
    logger.warn(`${TAG} phase=reasons submit failed — clearing placeholder`);
    await clearPendingAsyncJob({
      expectedRequestId: placeholderRequestId,
    }).catch((err: unknown) => {
      if (!(err instanceof PendingJobStaleError)) throw err;
    });
    await clearCapabilityToken();
    await setCycleState('idle');
    useForYouStore.getState().setAsyncJobPhase('idle');
    return 'error';
  }

  const next: PendingAsyncJob = {
    ...placeholder,
    requestId: newRequestId,
    submittedAt: Date.now(),
  };
  await setPendingAsyncJob(next, { expectedRequestId: placeholderRequestId });
  await setCycleState('waiting-for-reason');
  useForYouStore.getState().setAsyncJobPhase('reasons');
  logger.info(
    `${TAG} phase=reasons submitted requestId=${newRequestId} calls=${reasonBundle.calls.length}`,
  );

  return 'completed';
}

// ---------------------------------------------------------------------------
// Phase 2 — reasons completed (also the legacy combined-flow path)
// ---------------------------------------------------------------------------

async function reconcileReasonPhase(
  pending: PendingAsyncJob,
  server: ServerResults,
): Promise<ReconcileResult> {
  const privKey = hexToBytes(pending.clientPrivKeyHex);
  const batchResults: BatchCompletionResult[] = server.results.map((r) =>
    toBatchResult(r, privKey),
  );

  if (DUMP_RESULTS_ENABLED) {
    dumpResultsForDev('reasons', batchResults, server.results).catch(
      (err: unknown) => {
        logger.warn(`${TAG} results dump failed: ${String(err)}`);
      },
    );
  }

  const { chunkIdToCandidates } = reconstructLookups(
    pending.callIds,
    pending.candidateIds,
  );

  const { scoreMap, reasonMap, failedIds } = decodeResults({
    batchResults,
    promptsById: new Map(),
    chunkIdToCandidates,
  });
  // Legacy combined-flow results may carry score: ids too; bucket defensively.
  bucketScores(scoreMap);

  // Phase-2 flow: write reasons. Legacy flow: also write scores.
  const legacyCombined = !pending.phase;
  const scoredIds: string[] = [];

  for (const candidateId of pending.candidateIds) {
    if (failedIds.has(candidateId)) continue;

    if (legacyCombined) {
      const relevance = scoreMap.get(candidateId);
      if (relevance === undefined) continue;
      const reason = reasonMap.get(candidateId) ?? '';
      const reasonSkipped = relevance < 0.4;
      try {
        await saveScoringResult(candidateId, {
          relevance,
          reason,
          reasonSkipped,
        });
        scoredIds.push(candidateId);
      } catch (err) {
        logger.captureException(err, {
          tags: { service: 'async-job-reconciler', step: 'save-legacy' },
          extra: { candidateId },
        });
      }
      continue;
    }

    // Phase-2 proper: only reason:id results.
    const reason = reasonMap.get(candidateId);
    if (reason === undefined) continue;
    try {
      await saveReason(candidateId, reason);
    } catch (err) {
      if (isRecordNotFoundError(err)) continue;
      logger.captureException(err, {
        tags: { service: 'async-job-reconciler', step: 'save-reason' },
        extra: { candidateId },
      });
    }
  }

  const { refreshSuggestionsInStoreUnsafe } = await import(
    './SuggestionSyncService'
  );
  await refreshSuggestionsInStoreUnsafe();

  await clearPendingAsyncJob();
  await clearCapabilityToken();

  // Dispatch the notification for the rows that just landed BEFORE the
  // discard pass — the dispatch reads `useForYouStore.suggestions` which
  // we just refreshed above, and we want it to see the still-present
  // sub-threshold rows so the count math is consistent with what was
  // saved this cycle.
  //
  // Idempotency-keyed: a recovery re-run after a crash mid-`unpacking-reason`
  // would otherwise fire a duplicate "X impactful articles" push. We persist
  // the cycle's idempotencyKey on first dispatch and skip any future
  // dispatch carrying the same key. Cycles without a key (legacy combined
  // flow) always dispatch — they predate this guard.
  const idemKey = pending.idempotencyKey ?? null;
  const lastDispatched = idemKey ? await getNotifDispatchedFor() : null;
  const shouldDispatch = !idemKey || lastDispatched !== idemKey;

  if (shouldDispatch) {
    if (!legacyCombined && pending.relevanceMap) {
      const scored = Object.keys(pending.relevanceMap);
      await dispatchResultsNotification({ scoredIds: scored });
    } else {
      await dispatchResultsNotification({ scoredIds });
    }
    if (idemKey) await setNotifDispatchedFor(idemKey);
  } else {
    logger.info(
      `${TAG} phase-2 dispatch skipped — already fired for idempotencyKey=${idemKey}`,
    );
  }

  // Discard low-relevance rows from article_suggestions and mark every
  // candidate processed in synced_suggestion_ids. Keep cut == display
  // threshold == 0.3, so we never store rows that won't appear in the
  // feed. relevanceMap is the authoritative source: legacy combined-flow
  // built it from this batch's scoreMap; phase-2 carried it from phase-1.
  const relevanceForDiscard: Record<string, number> = legacyCombined
    ? Object.fromEntries(scoreMap.entries())
    : pending.relevanceMap ?? {};
  const discardedCount = await discardLowRelevance(
    pending.candidateIds,
    relevanceForDiscard,
  );
  if (discardedCount > 0) {
    logger.info(`${TAG} discarded ${discardedCount} low-relevance rows`);
    // Refresh again so the feed reflects the post-discard state.
    await refreshSuggestionsInStoreUnsafe();
  }
  await finishCycle();

  return 'completed';
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface ServerResults {
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

/** Build the Authorization header for a /results GET. Foreground prefers
 *  JWT and falls back to capability token if `getJwtToken` throws or returns
 *  null. Background uses capability token only — never reads keychain on a
 *  silent-push wake. Throws if no usable credential exists for the context. */
async function pickResultsAuthHeader(
  context: ExecutionContext,
  requestId: string,
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
    const cap = await getCapabilityToken();
    if (cap) {
      logger.warn(
        `${TAG} foreground using capability-token fallback for /results (JWT unavailable)`,
      );
      return `Bearer ${cap}`;
    }
    Sentry.addBreadcrumb({
      category: 'auth',
      level: 'warning',
      message: 'foreground /results: no JWT and no capability token',
      data: { requestId },
    });
    throw new Error('no auth available (foreground)');
  }
  const cap = await getCapabilityToken();
  if (!cap) {
    Sentry.addBreadcrumb({
      category: 'auth',
      level: 'warning',
      message: 'background /results: no capability token in AsyncStorage',
      data: { requestId },
    });
    throw new Error('no capability token available (background)');
  }
  return `Bearer ${cap}`;
}

async function fetchResults(
  requestId: string,
  context: ExecutionContext,
): Promise<ServerResults | 'pending' | 'not-found'> {
  // Per-context auth.
  //   Foreground: prefer the keychain JWT; fall back to capability token if
  //     keychain is transiently unavailable AND a capability token exists.
  //   Background: capability token only — never touch the keychain on a
  //     silent-push wake (locked-device → SecureStore throws).
  const authHeader = await pickResultsAuthHeader(context, requestId);

  const res = await (expoFetch as unknown as typeof globalThis.fetch)(
    `${INFERENCE_ENDPOINT}/v1/inference/jobs/${requestId}/results`,
    {
      method: 'GET',
      headers: { Authorization: authHeader },
    },
  );

  if (res.status === 404) return 'not-found';
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

function toBatchResult(
  row: ServerResults['results'][number],
  privKey: Uint8Array,
): BatchCompletionResult {
  if (!row.ok) {
    return { id: row.id, output: '', error: row.error ?? 'unknown' };
  }
  const choice = row.response?.choices?.[0];
  const encContent =
    choice?.message?.content ?? choice?.message?.reasoning_content ?? '';
  if (!encContent) return { id: row.id, output: '' };

  try {
    const output = decryptContent(encContent, privKey).trim();
    return { id: row.id, output };
  } catch (err) {
    return {
      id: row.id,
      output: '',
      error: err instanceof Error ? err.message : 'decrypt error',
    };
  }
}

function reconstructLookups(
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

/**
 * Local sentinel id used to claim the pending-job slot before a phase-2 submit
 * returns a real requestId. Uniqueness only needs to be good enough to
 * distinguish concurrent placeholders in the same process — collision math is
 * trivially in our favor.
 */
function makePlaceholderRequestId(): string {
  return `placeholder-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Watermelon throws `Record <table>#<id> not found` when an update targets a
 * row that has since been deleted (typically because syncFeed dropped it after
 * the server's id-set shrank). Treat as a benign skip — not a real error.
 */
function isRecordNotFoundError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /Record\s+\S+\s+not\s+found/i.test(msg);
}

const KEEP_RELEVANCE_THRESHOLD = 0.3;

/**
 * Discard freshly-scored rows whose relevance ≤ KEEP_RELEVANCE_THRESHOLD from
 * `article_suggestions`. Their ids stay marked as processed in
 * `synced_suggestion_ids` (caller does that), so the next batch picker won't
 * re-fetch them. This is the *only* path that mutates article_suggestions
 * during a cycle.
 */
async function discardLowRelevance(
  candidateIds: string[],
  relevanceMap: Record<string, number>,
): Promise<number> {
  const toDiscard = candidateIds.filter((id) => {
    const r = relevanceMap[id];
    return r !== undefined && r <= KEEP_RELEVANCE_THRESHOLD;
  });
  if (toDiscard.length === 0) return 0;
  return await deleteSuggestionsByServerIds(toDiscard);
}

/**
 * Recovery path: submit a reason-generation job for article_suggestion rows
 * that have relevance scores (phase-1 done) but no reasons (phase-2 lost).
 *
 * Called by runBackgroundCycle when submitInferenceJob returns 'skipped-empty'
 * (no new candidates to score) but orphaned scored-without-reason rows exist.
 * Uses the stored bucketed relevance values in place of raw pre-bucket scores
 * since those are not persisted past phase-1 reconciliation.
 */
export async function submitOrphanedReasonJob(
  context: ExecutionContext,
): Promise<'submitted' | 'skipped-pending' | 'skipped-empty' | 'skipped-no-token' | 'error'> {
  const pending = await getPendingAsyncJob();
  if (pending) return 'skipped-pending';

  const candidates = await getScoredSuggestionsWithoutReasons();
  const qualified = candidates.filter(
    (c) => typeof c.relevance === 'number' && c.relevance > REASON_RELEVANCE_THRESHOLD,
  );
  if (qualified.length === 0) return 'skipped-empty';

  // Push token is optional — submit tokenless and rely on foreground polling
  // when absent (Android FCM-registration failures). The gateway omits the
  // completion push for tokenless jobs.
  const token = useUserStore.getState().userPersona?.expoPushToken ?? null;

  // Build relevance map from stored (bucketed) values. Raw pre-bucket scores
  // are not persisted; REASON_MIN_RAW_SCORE=0 means all threshold-passing rows
  // still qualify.
  const rawRelevanceMap: Record<string, number> = {};
  for (const c of qualified) rawRelevanceMap[c.id] = c.relevance!;

  const reasonBundle = await buildReasonCallsForSubset(
    qualified,
    rawRelevanceMap,
    REASON_RELEVANCE_THRESHOLD,
  );

  // Candidates excluded by isEligible (no title/desc/facts) will never get a
  // reason — mark them skipped now so they stop showing the loading spinner.
  const eligibleIds = new Set(reasonBundle.eligibleCandidates.map((c) => c.id));
  const ineligibleOrphans = qualified.filter((c) => !eligibleIds.has(c.id));
  if (ineligibleOrphans.length > 0) {
    logger.info(
      `${TAG} [orphan-reason] marking ${ineligibleOrphans.length} ineligible orphans as reason-skipped (missing title/desc/facts)`,
    );
    await batchMarkReasonSkipped(ineligibleOrphans.map((c) => c.id));
    const { refreshSuggestionsInStoreUnsafe } = await import('./SuggestionSyncService');
    await refreshSuggestionsInStoreUnsafe();
  }

  if (reasonBundle.calls.length === 0) {
    return 'skipped-empty';
  }

  logger.info(
    `${TAG} [orphan-reason] submitting ${reasonBundle.calls.length} calls for ${qualified.length} orphaned rows`,
  );

  await setCycleState('submitting-reason');
  const phase2Model = SMALL_MODEL;
  const ctx = await prepareE2EEContext(phase2Model);
  const idempotencyKey = `orphan-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;

  const placeholderRequestId = makePlaceholderRequestId();
  const placeholder: PendingAsyncJob = {
    requestId: placeholderRequestId,
    phase: 'reasons',
    candidateIds: reasonBundle.eligibleCandidates.map((c) => c.id),
    callIds: reasonBundle.calls.map((c) => c.id),
    relevanceMap: rawRelevanceMap,
    submittedAt: Date.now(),
    expoPushToken: token,
    modelCalls: reasonBundle.calls.length,
    clientPrivKeyHex: bytesToHex(ctx.privateKey),
    idempotencyKey,
  };

  try {
    await setPendingAsyncJob(placeholder, { expectedRequestId: null });
  } catch (err) {
    if (err instanceof PendingJobStaleError) {
      logger.warn(`${TAG} [orphan-reason] CAS lost — concurrent submitter claimed slot`);
      await setCycleState('idle');
      return 'skipped-pending';
    }
    throw err;
  }

  const newRequestId = await sendInferenceRequest({
    bundle: reasonBundle,
    ctx,
    token,
    model: phase2Model,
    context,
  });

  if (!newRequestId) {
    logger.warn(`${TAG} [orphan-reason] submit failed — clearing placeholder`);
    await clearPendingAsyncJob({ expectedRequestId: placeholderRequestId }).catch(
      (err: unknown) => {
        if (!(err instanceof PendingJobStaleError)) throw err;
      },
    );
    await clearCapabilityToken();
    await setCycleState('idle');
    useForYouStore.getState().setAsyncJobPhase('idle');
    return 'error';
  }

  const job: PendingAsyncJob = {
    ...placeholder,
    requestId: newRequestId,
    submittedAt: Date.now(),
  };
  await setPendingAsyncJob(job, { expectedRequestId: placeholderRequestId });
  await setCycleState('waiting-for-reason');
  useForYouStore.getState().setAsyncJobPhase('reasons');
  logger.info(
    `${TAG} [orphan-reason] submitted requestId=${newRequestId} calls=${reasonBundle.calls.length}`,
  );
  return 'submitted';
}

/**
 * Final step of every cycle: flip `asyncJobPhase` to idle and announce the
 * drain. Phase-1 submits the entire unprocessed set in one job, so by the
 * time we reach here there is nothing left to chain.
 */
async function finishCycle(): Promise<void> {
  await setCycleState('idle');
  useForYouStore.getState().setAsyncJobPhase('idle');
  useForYouStore.getState().markProcessingRunFinished();
}


function hexToBytes(hex: string): Uint8Array {
  const len = hex.length / 2;
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/**
 * DEV-ONLY: dump decrypted LLM results to a timestamped .md file alongside the
 * plaintext prompt dumps written by `dumpPromptsForDev`. Pair a prompt dump
 * (same timestamp prefix) with its results dump to see exactly what the model
 * returned for each call id.
 */
async function dumpResultsForDev(
  phase: 'relevance' | 'reasons',
  batchResults: BatchCompletionResult[],
  rawRows: ServerResults['results'],
): Promise<void> {
  const dir = new Directory(Paths.document, 'prompt-dumps');
  if (!dir.exists) dir.create({ intermediates: true });

  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const file = new File(
    dir,
    `${ts}-results-${phase}-${batchResults.length}.md`,
  );

  const finishById = new Map<string, string>();
  for (const row of rawRows) {
    finishById.set(row.id, row.response?.choices?.[0]?.finish_reason ?? '');
  }

  const parts: string[] = [
    `# Inference results — ${new Date().toISOString()}`,
    `phase: ${phase}`,
    `calls: ${batchResults.length}`,
    '',
  ];

  for (const r of batchResults) {
    parts.push('---');
    parts.push(`## \`${r.id}\``);
    parts.push(`finish_reason: ${finishById.get(r.id) ?? ''}`);
    if (r.error) parts.push(`error: ${r.error}`);
    parts.push('');
    parts.push('```');
    parts.push(r.output || '(empty)');
    parts.push('```');
    parts.push('');
  }

  file.create();
  file.write(parts.join('\n'));
  logger.info(`${TAG} [dev] dumped results → ${file.uri}`);
}
