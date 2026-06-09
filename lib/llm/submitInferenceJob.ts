// submitInferenceJob — phase-1 entry point for the two-phase async inference
// flow. Sends score-only calls; the phase-1 reconciler decides which
// candidates qualify for reason-generation and fires the phase-2 submit via
// the exported `sendInferenceRequest` helper.

import { fetch as expoFetch } from 'expo/fetch';
import logger from '@/lib/logger';
import { withRetry } from '@/lib/utils/retry';
import {
  setCapabilityToken,
  getCapabilityToken,
} from './capability-token';
import type { ExecutionContext } from './execution-context';
import {
  getPendingAsyncJob,
  PendingJobStaleError,
  setCycleState,
  setPendingAsyncJob,
  clearPendingAsyncJob,
  type PendingAsyncJob,
} from '@/lib/database/services/async-job-service';
import {
  getUnscoredSuggestionsWithFacts,
} from '@/lib/database/services/article-suggestion-service';
import {
  buildRelevanceCalls,
  type CloudCallBundle,
} from '@/lib/mera-protocol/scoring-service';
import type { BatchCall } from '@/lib/llm/types';
import {
  encryptContent,
  prepareE2EEContext,
  type E2EEContext,
} from '@/lib/e2ee/e2ee-service';
import { SMALL_MODEL } from './constants';
import { getJwtToken } from '@/lib/auth-client';
import pako from 'pako';
import { Directory, File, Paths } from 'expo-file-system';
import { useUserStore } from '@/lib/stores/user-store';
import { useForYouStore } from '@/lib/stores/for-you-store';
import { INFERENCE_ENDPOINT, DUMP_QUERIES_ENABLED } from '@/lib/config/endpoints';

const TAG = '[submitInferenceJob]';

const JOBS_API = `${INFERENCE_ENDPOINT}/v1/inference/jobs`;

export type SubmitStatus =
  | 'submitted'
  | 'skipped-pending'
  | 'skipped-empty'
  | 'skipped-no-token'
  | 'skipped-stale-pending';

/** Phase-1 public entry — score-only submit. Called by every trigger that
 *  wants to kick off a fresh scoring pass. */
export async function submitInferenceJob(): Promise<SubmitStatus> {
  const pending = await getPendingAsyncJob();
  if (pending) {
    logger.info(`${TAG} pending job ${pending.requestId} active — skipping`);
    return 'skipped-pending';
  }

  const candidates = await getUnscoredSuggestionsWithFacts();
  logger.info(`${TAG} unscored candidates loaded=${candidates.length}`);
  if (candidates.length === 0) return 'skipped-empty';

  // The push token is no longer a hard gate. When present, the gateway uses it
  // to wake the app with a silent push on completion; when absent (common on
  // Android where FCM registration fails), the job still submits and results
  // are retrieved by the foreground polling path (inference-recover / scoring
  // pass reconcile). See sendInferenceRequest — the token is omitted from the
  // body when null.
  const token = getCachedExpoPushToken();
  if (!token) {
    logger.info(`${TAG} no Expo push token — submitting tokenless, will poll for results`);
  }

  const bundle = await buildRelevanceCalls(candidates);
  if (bundle.calls.length === 0 || bundle.eligibleCandidates.length === 0) {
    logger.info(
      `${TAG} buildRelevanceCalls produced 0 eligible — candidates=${candidates.length} but all filtered (missing title/desc/facts?)`,
    );
    return 'skipped-empty';
  }
  const eligibleIds = bundle.eligibleCandidates.map((c) => c.id);
  logger.info(
    `${TAG} relevance gen: ${eligibleIds.length} ids in ${bundle.calls.length} calls`,
  );

  const model = SMALL_MODEL;
  const ctx = await prepareE2EEContext(model);

  // Placeholder-first CAS: reserve the empty pending slot BEFORE submitting.
  // If another trigger already inserted a pending row (cross-JS-context race
  // between silent-push task and foreground), the CAS fails and we back off
  // without submitting a duplicate.
  const placeholderRequestId = `placeholder-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  // Cycle-scoped idempotency key for the eventual "X impactful articles"
  // dispatch in phase-2. Survives the phase-1 → phase-2 swap, so a recovery
  // re-run of `unpacking-reason` doesn't double-notify.
  const idempotencyKey = `cycle-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
  const placeholder: PendingAsyncJob = {
    requestId: placeholderRequestId,
    phase: 'relevance',
    candidateIds: bundle.eligibleCandidates.map((c) => c.id),
    callIds: bundle.calls.map((c) => c.id),
    submittedAt: Date.now(),
    expoPushToken: token,
    modelCalls: bundle.calls.length,
    clientPrivKeyHex: bytesToHex(ctx.privateKey),
    idempotencyKey,
  };

  try {
    await setPendingAsyncJob(placeholder, { expectedRequestId: null });
  } catch (err) {
    if (err instanceof PendingJobStaleError) {
      logger.info(`${TAG} CAS lost — another submitter claimed the slot`);
      return 'skipped-pending';
    }
    throw err;
  }
  await setCycleState('submitting-relevance');

  try {
    const requestId = await sendInferenceRequest({
      bundle,
      ctx,
      token,
      model,
      // Phase-1 submit always runs in the foreground (called from syncFeed
      // / runScoringPass on app-resume). JWT is the right credential here.
      context: 'foreground',
    });
    if (!requestId) {
      await clearPendingAsyncJob({ expectedRequestId: placeholderRequestId }).catch(
        (err: unknown) => {
          if (!(err instanceof PendingJobStaleError)) throw err;
        },
      );
      await setCycleState('idle');
      return 'skipped-stale-pending';
    }

    const job: PendingAsyncJob = { ...placeholder, requestId };
    await setPendingAsyncJob(job, { expectedRequestId: placeholderRequestId });
    await setCycleState('waiting-for-relevance');
    useForYouStore.getState().setAsyncJobPhase('relevance');
    logger.info(
      `${TAG} phase=relevance submitted requestId=${requestId} calls=${bundle.calls.length}`,
    );
    return 'submitted';
  } catch (err) {
    if (err instanceof PendingJobStaleError) {
      // The reconciler (or another submitter) advanced the pending row
      // out from under us — typically by resubmitting our placeholder
      // after deciding it was stuck. The job that took our slot is
      // already in flight on the backend; clobbering it here would
      // orphan it. Leave the DB row alone and let the normal poll
      // cycle drive it to completion.
      logger.warn(
        `${TAG} CAS lost on write-back — another path advanced the job; leaving DB row intact`,
      );
      return 'skipped-stale-pending';
    }
    logger.captureException(err, { tags: { service: 'submitInferenceJob' } });
    await clearPendingAsyncJob({ expectedRequestId: placeholderRequestId }).catch(
      (cerr: unknown) => {
        if (!(cerr instanceof PendingJobStaleError)) throw cerr;
      },
    );
    await setCycleState('idle');
    useForYouStore.getState().setAsyncJobPhase('idle');
    return 'skipped-stale-pending';
  }
}

/**
 * Shared submit primitive: encrypt the bundle's calls end-to-end, gzip the
 * body, POST to /v1/inference/jobs, return the server-issued requestId.
 * Reused by phase-1 above and by the phase-2 reason submit inside the
 * reconciler. Caller is responsible for persisting the PendingAsyncJob row
 * after getting the requestId.
 */
export async function sendInferenceRequest(args: {
  bundle: CloudCallBundle;
  ctx: E2EEContext;
  /** Null when the device has no registered Expo push token — the field is
   *  omitted from the request body and the gateway skips the completion push. */
  token: string | null;
  model: string;
  /** Required. Foreground submits use the keychain JWT (only the user's
   *  active device can mint one). Background submits — phase-2 chain from
   *  a silent-push wake — use the cycle's capability token from
   *  AsyncStorage so the keychain is never read while the device may be
   *  locked. No silent fallback either direction. */
  context: ExecutionContext;
}): Promise<string | null> {
  const { bundle, ctx, token, model, context } = args;

  if (DUMP_QUERIES_ENABLED) {
    dumpPromptsForDev(bundle.calls).catch((err: unknown) => {
      logger.warn(`${TAG} prompt dump failed: ${String(err)}`);
    });
  }

  // If every BatchCall in the bundle shares an identical system prompt
  // (true for phase-1 score chunks and phase-2 reason calls by construction),
  // encrypt it ONCE and hoist it to the top-level `sharedSystem` field. The
  // gateway prepends it to each request's messages[] before proxying — saves
  // ~37–44% of raw body bytes vs. repeating the ciphertext per call.
  const sharedSystemPlaintext = computeSharedSystem(bundle.calls);
  const sharedSystem = sharedSystemPlaintext
    ? encryptContent(sharedSystemPlaintext, ctx)
    : null;

  const encryptedCalls = bundle.calls.map((call: BatchCall) => {
    const messages: { role: string; content: string }[] = [];
    if (!sharedSystem && call.system.length > 0) {
      messages.push({ role: 'system', content: encryptContent(call.system, ctx) });
    }
    if (call.prompt.length > 0) {
      messages.push({ role: 'user', content: encryptContent(call.prompt, ctx) });
    }
    return {
      id: call.id,
      body: {
        messages,
        stream: false,
        temperature: call.temperature ?? 0.3,
        model,
        chat_template_kwargs: { enable_thinking: call.enableThinking ?? false },
        ...(call.maxTokens !== undefined && { max_tokens: call.maxTokens }),
      },
    };
  });

  // Build the persisted session object: forwardable E2EE headers that the
  // gateway processor replays upstream when the job runs.
  const e2eeSession: Record<string, string> = {};
  for (const [k, v] of Object.entries(ctx.headers)) {
    if (typeof v === 'string') e2eeSession[k] = v;
  }

  const body: {
    expoPushToken?: string;
    e2eeSession: Record<string, string>;
    requests: typeof encryptedCalls;
    sharedSystem?: string;
  } = {
    e2eeSession,
    requests: encryptedCalls,
  };
  // Only include the token when present — the gateway DTO accepts its absence
  // (tokenless submit) but rejects an empty/invalid token via @Matches.
  if (token) body.expoPushToken = token;
  if (sharedSystem) body.sharedSystem = sharedSystem;

  const bodyJson = JSON.stringify(body);
  const gzipped = pako.gzip(bodyJson);

  const rawBytes = bodyJson.length;
  const gzippedBytes = gzipped.length;
  const ratio = rawBytes > 0 ? (gzippedBytes / rawBytes) * 100 : 0;
  logger.info(
    `${TAG} payload: calls=${bundle.calls.length} raw=${rawBytes}B gzipped=${gzippedBytes}B (${ratio.toFixed(1)}%)`,
  );

  // Per-context auth.
  //   Foreground: prefer the keychain JWT. If `getJwtToken` throws or
  //     returns null (keychain transiently unavailable, session expired,
  //     etc.) AND a capability token from a previous cycle is present in
  //     AsyncStorage, fall back to that — beats failing the whole call.
  //   Background: capability token only. Never read the keychain from a
  //     silent-push wake; the device may be locked and SecureStore items
  //     pinned to AfterFirstUnlock would throw `keychain-unavailable`.
  let authHeader: string;
  if (context === 'foreground') {
    let jwt: string | null = null;
    try {
      jwt = await getJwtToken();
    } catch (err) {
      logger.warn(
        `${TAG} foreground getJwtToken threw — falling back to capability token if present: ${String(err)}`,
      );
    }
    if (jwt) {
      authHeader = `Bearer ${jwt}`;
    } else {
      const cap = await getCapabilityToken();
      if (!cap) {
        throw new Error(
          'sendInferenceRequest: foreground has no JWT and no capability token',
        );
      }
      logger.warn(
        `${TAG} foreground using capability-token fallback (JWT unavailable)`,
      );
      authHeader = `Bearer ${cap}`;
    }
  } else {
    const cap = await getCapabilityToken();
    if (!cap) {
      throw new Error('sendInferenceRequest: no capability token (background)');
    }
    authHeader = `Bearer ${cap}`;
  }

  let res: Response;
  try {
    res = await withRetry(
      async () => {
        const r = await (expoFetch as unknown as typeof globalThis.fetch)(
          JOBS_API,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Content-Encoding': 'gzip',
              Authorization: authHeader,
            },
            body: gzipped as unknown as BodyInit,
          },
        );
        if (r.status >= 500) {
          const text = await r.text().catch(() => '');
          throw new Error(`${TAG} submit failed (${r.status}): ${text.slice(0, 200)}`);
        }
        return r;
      },
      undefined,
      4,
      TAG,
    );
  } catch (err) {
    logger.captureException(err, {
      tags: { service: 'submitInferenceJob', status: 'retry-exhausted' },
      extra: { url: JOBS_API },
    });
    return null;
  }

  if (res.status !== 202) {
    const text = await res.text().catch(() => '');
    // Was logger.warn — that's only a breadcrumb, so the failure stayed
    // silent and the only Sentry signal was the 30s empty-feed watchdog.
    // Surface as an exception so the *source* of a stalled cycle is loud.
    logger.captureException(
      new Error(`${TAG} submit failed ${res.status}`),
      {
        tags: { service: 'submitInferenceJob', status: String(res.status) },
        extra: { url: JOBS_API, status: res.status, body: text.slice(0, 500) },
      },
    );
    return null;
  }

  const { requestId, capabilityToken } = (await res.json()) as {
    requestId: string;
    capabilityToken?: string;
  };
  if (!requestId) {
    logger.captureException(
      new Error(`${TAG} submit succeeded but no requestId`),
      {
        tags: { service: 'submitInferenceJob' },
        extra: { url: JOBS_API, status: res.status },
      },
    );
    return null;
  }

  // Stash the gateway-issued capability token. Bound to (userId, requestId,
  // exp=24h, scopes={results:read, jobs:submit-followup}); covers both the
  // /results GET and the phase-2 follow-up POST so neither ever needs the
  // keychain JWT. Cleared by the state machine when the cycle returns to
  // `idle`.
  if (capabilityToken) {
    await setCapabilityToken(capabilityToken);
  } else {
    logger.warn(
      `${TAG} gateway returned no capabilityToken — falling back to JWT auth on subsequent calls`,
    );
  }

  return requestId;
}

/**
 * Read the Expo push token from the hydrated persona. The boot-time
 * `ensurePushTokenRegistered` in _layout.tsx is responsible for populating
 * this. If missing (cold-start race before that runs), the caller returns
 * 'skipped-no-token' and the next trigger picks it up.
 */
function getCachedExpoPushToken(): string | null {
  return useUserStore.getState().userPersona?.expoPushToken ?? null;
}

/**
 * If every call in the bundle shares the same non-empty `system` plaintext,
 * return that plaintext for hoisting into the job's top-level `sharedSystem`
 * field. Return null when calls disagree or the system is empty — in that
 * case each request carries its own system message inline.
 */
function computeSharedSystem(calls: BatchCall[]): string | null {
  if (calls.length === 0) return null;
  const first = calls[0].system;
  if (!first || first.length === 0) return null;
  for (let i = 1; i < calls.length; i++) {
    if (calls[i].system !== first) return null;
  }
  return first;
}

/**
 * DEV-ONLY: dump the plaintext (pre-encryption) prompts to a timestamped .md
 * file under the app's document directory. Pull with:
 *   xcrun simctl get_app_container booted com.mera.news data
 * then copy out `Documents/prompt-dumps/*.md`. Gitignored at project root
 * under `prompt-dumps/` so you can also stash them there while iterating.
 */
async function dumpPromptsForDev(calls: BatchCall[]): Promise<void> {
  const dir = new Directory(Paths.document, 'prompt-dumps');
  if (!dir.exists) dir.create({ intermediates: true });

  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const file = new File(dir, `${ts}-calls-${calls.length}.md`);

  const parts: string[] = [
    `# Inference job — ${new Date().toISOString()}`,
    `Calls: ${calls.length}`,
    '',
  ];
  for (const call of calls) {
    parts.push(`---`);
    parts.push(`## Call \`${call.id}\``);
    parts.push(
      `temp: ${call.temperature ?? 0.3}${call.maxTokens !== undefined ? ` · max_tokens: ${call.maxTokens}` : ''}`,
    );
    parts.push('');
    parts.push(`### System`);
    parts.push('```');
    parts.push(call.system);
    parts.push('```');
    parts.push('');
    parts.push(`### User`);
    parts.push('```');
    parts.push(call.prompt);
    parts.push('```');
    parts.push('');
  }

  file.create();
  file.write(parts.join('\n'));
  logger.info(`${TAG} [dev] dumped prompts → ${file.uri}`);
}

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
