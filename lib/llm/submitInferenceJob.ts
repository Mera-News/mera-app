// submitInferenceJob — the shared submit primitive for the cloud inference
// flow. `sendInferenceRequest` encrypts a bundle's calls end-to-end, gzips the
// body, POSTs it to /v1/inference/jobs, and returns the server-issued
// requestId + capability token. The multi-batch scoring pipeline
// (lib/services/scoring-pipeline.ts) owns all job state; this module is
// stateless and just performs one authenticated submit.

import { fetch as expoFetch } from 'expo/fetch';
import logger from '@/lib/logger';
import { withRetry } from '@/lib/utils/retry';
import * as gatewayRateLimiter from './gateway-rate-limiter';
import type { ExecutionContext } from './execution-context';
import {
  type CloudCallBundle,
} from '@/lib/mera-protocol/scoring-service';
import type { BatchCall } from '@/lib/llm/types';
import {
  encryptContent,
  type E2EEContext,
} from '@/lib/e2ee/e2ee-service';
import { getJwtToken, invalidateJwtCache } from '@/lib/auth-client';
import { recordAuthFailure } from '@/lib/auth-failure-breaker';
import pako from 'pako';
import { Directory, File, Paths } from 'expo-file-system';
import { INFERENCE_ENDPOINT, DUMP_QUERIES_ENABLED } from '@/lib/config/endpoints';

const TAG = '[submitInferenceJob]';

const JOBS_API = `${INFERENCE_ENDPOINT}/v1/inference/jobs`;

/** Outcome of a single `sendInferenceRequest` call. `throttled` means the
 *  gateway returned 429 — the caller should treat this as a transient,
 *  non-terminal condition (the gateway-rate-limiter has already been told to
 *  back off via `pauseFor`); it is not a permanent failure. */
export type SendInferenceOutcome =
  | { status: 'ok'; requestId: string; capabilityToken: string }
  | { status: 'throttled' }
  | { status: 'failed' };

/**
 * Shared submit primitive: encrypt the bundle's calls end-to-end, gzip the
 * body, POST to /v1/inference/jobs, return the server-issued requestId +
 * capability token. Caller is responsible for persisting whatever job state it
 * needs from the outcome.
 */
export async function sendInferenceRequest(args: {
  bundle: CloudCallBundle;
  ctx: E2EEContext;
  /** Null when the device has no registered Expo push token — the field is
   *  omitted from the request body and the gateway skips the completion push. */
  token: string | null;
  model: string;
  /** Required. Foreground submits use the keychain JWT (only the user's
   *  active device can mint one), falling back to `capabilityToken` if the
   *  keychain is transiently unavailable. Background submits — e.g. a reasons
   *  submit driven from a silent-push wake — use `capabilityToken` ONLY, so
   *  the keychain is never read while the device may be locked. */
  context: ExecutionContext;
  /** Gateway capability token from a previously-completed job (scope
   *  `jobs:submit-followup` covers submitting a NEW job — this is how a
   *  background reasons submit chains off its finished relevance job). The
   *  scoring pipeline persists one per batch and passes the batch's own token
   *  here. Required for background submits; optional JWT fallback in
   *  foreground. */
  capabilityToken?: string | null;
}): Promise<SendInferenceOutcome> {
  const { bundle, ctx, token, model, context, capabilityToken } = args;

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
  //     etc.) AND the caller passed a capability token, fall back to that —
  //     beats failing the whole call.
  //   Background: caller-supplied capability token only. Never read the
  //     keychain from a silent-push wake; the device may be locked and
  //     SecureStore items pinned to AfterFirstUnlock would throw
  //     `keychain-unavailable`.
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
      if (!capabilityToken) {
        throw new Error(
          'sendInferenceRequest: foreground has no JWT and no capability token',
        );
      }
      logger.warn(
        `${TAG} foreground using capability-token fallback (JWT unavailable)`,
      );
      authHeader = `Bearer ${capabilityToken}`;
    }
  } else {
    if (!capabilityToken) {
      throw new Error('sendInferenceRequest: no capability token (background)');
    }
    authHeader = `Bearer ${capabilityToken}`;
  }

  // Serial FIFO gate shared by every inference-gateway HTTP call (submits and
  // polls) — enforces the gateway's per-IP throttle (30 req/60s counting
  // both) well under the limit before we even attempt the POST.
  await gatewayRateLimiter.acquire();

  const doSubmitPost = (bearer: string): Promise<Response> =>
    withRetry(
      async () => {
        const r = await (expoFetch as unknown as typeof globalThis.fetch)(
          JOBS_API,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Content-Encoding': 'gzip',
              Authorization: bearer,
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

  let res: Response;
  try {
    res = await doSubmitPost(authHeader);
  } catch (err) {
    logger.captureException(err, {
      tags: { service: 'submitInferenceJob', status: 'retry-exhausted' },
      extra: { url: JOBS_API },
    });
    return { status: 'failed' };
  }

  // 401/403 recovery — foreground (JWT) only. Mirrors authFetch's idiom
  // (lib/llm/cloudComplete.ts): invalidate the cached JWT, re-mint once, retry
  // the POST once. A background submit has no re-mint path (the keychain is
  // never read in that context — see ExecutionContext) so a stale capability
  // token there is left alone: it says nothing about the Better Auth session,
  // so recordAuthFailure() would be a false signal. Both cases fall through to
  // the standard non-202 handling below, which captures + returns failed.
  if ((res.status === 401 || res.status === 403) && context === 'foreground') {
    logger.warn(`${TAG} ${res.status} on submit — invalidating JWT cache and re-minting once`);
    invalidateJwtCache();
    const freshJwt = await getJwtToken().catch(() => null);
    if (freshJwt) {
      authHeader = `Bearer ${freshJwt}`;
      try {
        res = await doSubmitPost(authHeader);
      } catch (err) {
        logger.captureException(err, {
          tags: { service: 'submitInferenceJob', status: 'retry-exhausted-after-401' },
          extra: { url: JOBS_API },
        });
        return { status: 'failed' };
      }
    }
    if (res.status === 401 || res.status === 403) {
      recordAuthFailure();
    }
  }

  if (res.status === 429) {
    // Transient, non-terminal — the gateway is asking us to back off, not
    // reporting a permanent failure. Don't let withRetry burn attempts on
    // it (it already didn't — only >=500 throws inside the retry closure);
    // instead push the shared rate limiter's next grant out and let the
    // caller decide whether/when to resubmit.
    const retryAfterHeader = res.headers.get('Retry-After');
    const retryAfterSec = retryAfterHeader ? Number(retryAfterHeader) : NaN;
    const retryAfterMs =
      Number.isFinite(retryAfterSec) && retryAfterSec > 0
        ? retryAfterSec * 1000
        : 30_000;
    gatewayRateLimiter.pauseFor(retryAfterMs);
    logger.warn(
      `${TAG} throttled (429) — pausing gateway calls for ${retryAfterMs}ms`,
    );
    return { status: 'throttled' };
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
    return { status: 'failed' };
  }

  const { requestId, capabilityToken: issuedCapabilityToken } =
    (await res.json()) as {
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
    return { status: 'failed' };
  }

  // The gateway-issued capability token is bound to (userId, requestId,
  // exp=24h, scopes={results:read, jobs:submit-followup}); it covers both
  // the /results GET and the phase-2 follow-up POST so neither ever needs
  // the keychain JWT. Storing it is the caller's responsibility.
  if (!issuedCapabilityToken) {
    logger.warn(
      `${TAG} gateway returned no capabilityToken — falling back to JWT auth on subsequent calls`,
    );
  }

  return {
    status: 'ok',
    requestId,
    capabilityToken: issuedCapabilityToken ?? '',
  };
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
