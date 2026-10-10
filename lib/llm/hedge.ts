// hedge — the model-fallback send layer: sequential send with one session-
// fallback retry, and the hedged race of the primary against its fallback.
// Imports gateway-fetch only.

import logger from '../logger';
import {
  fallbackFor,
  reportModelFailure,
  reportModelSlow,
  reportModelSuccess,
  resolveModel,
} from './model-fallback';
import * as gatewayRateLimiter from './gateway-rate-limiter';
import {
  authFetch,
  isAbortLike,
  isCallerAbort,
  UPSTREAM_ALIGNED_TIMEOUT_MS,
  type AuthFetchOptions,
  type CloudCallOptions,
} from './gateway-fetch';

const TAG = '[CloudLLM]';

/** 502/timeout attempt cap for every gateway-bound cloud call. A cold or
 *  stalled NEAR model can exceed even 120s, and retrying the SAME model just
 *  storms; cap at 2 total attempts so a persistent stall surfaces the gateway's
 *  502 in bounded time. The chat model is warmed ahead of the first turn by
 *  prewarmCloudChat() (lib/llm/prewarm). */
export const UPSTREAM_ALIGNED_MAX_TIMEOUT_ATTEMPTS = 2;

/** Apply the gateway-aligned defaults, letting an explicit caller value win. */
export function withUpstreamAlignedDefaults(options: CloudCallOptions): CloudCallOptions {
  return {
    ...options,
    requestTimeoutMs: options.requestTimeoutMs ?? UPSTREAM_ALIGNED_TIMEOUT_MS,
    maxTimeoutAttempts: options.maxTimeoutAttempts ?? UPSTREAM_ALIGNED_MAX_TIMEOUT_ATTEMPTS,
  };
}

/**
 * The single choke point every cloud call goes through, so the session model
 * fallback (lib/llm/model-fallback) is wired in exactly once.
 *
 * Sends the request on the currently-resolved model. If — and only if — it ends
 * in a TIMEOUT-CLASS terminal failure (the client's timeout-attempt budget
 * exhausted, or the gateway's 502 upstream-timeout verdict) it engages the
 * session fallback and retries ONCE against it, so the call that discovered the
 * stall can still succeed. If that retry also fails, the ORIGINAL failure is
 * surfaced — the fallback must never mask the real error. 4xx, auth failures,
 * E2EE/decrypt errors and plain network errors are surfaced untouched and never
 * engage the fallback.
 *
 * `build` MUST construct its payload from scratch on every invocation: E2EE
 * encryption mutates message content in place, and attestation keys are
 * per-model, so the retry needs a fresh plaintext body encrypted for the
 * fallback model.
 */
export async function sendWithModelFallback<C>(
  url: string,
  primaryModel: string,
  build: Build<C>,
  options: CloudCallOptions,
): Promise<Leg<C>> {
  const hedgeAfterMs = options.hedgeAfterMs;
  const hedgeModel = fallbackFor(primaryModel);
  // Hedge only from a still-healthy primary onto a DIFFERENT model. Once the
  // session fallback is engaged there is nothing left to race against, and a
  // caller that didn't opt in stays on the sequential path.
  const canHedge =
    hedgeAfterMs != null &&
    resolveModel(primaryModel) === primaryModel &&
    hedgeModel != null &&
    hedgeModel !== primaryModel;

  if (!canHedge) return sendSequential(url, primaryModel, build, options);
  return sendHedged(url, primaryModel, hedgeModel, build, options, hedgeAfterMs);
}

type Build<C> = (model: string) => Promise<{ init: RequestInit; ctx: C }>;

/** A settled request leg: the response, the E2EE context that decrypts it, and
 *  the model it was sent to. Raced as ONE tuple so ctx always follows the
 *  winner — a response decrypted under the loser's key is garbage. */
interface Leg<C> {
  response: Response;
  ctx: C;
  model: string;
}

/** The caller's stop rides on the request so authFetch's limiter wait, backoff
 *  and abort bridge all see it. */
function withCallerSignal(init: RequestInit, options: { signal?: AbortSignal }): RequestInit {
  return options.signal ? { ...init, signal: options.signal } : init;
}

/** The original (pre-hedge) sequential behavior: one request, and on a
 *  timeout-class failure, engage + retry once on the fallback. */
async function sendSequential<C>(
  url: string,
  primaryModel: string,
  build: Build<C>,
  options: CloudCallOptions,
): Promise<Leg<C>> {
  const model = resolveModel(primaryModel);
  const first = await build(model);

  let originalResponse: Response | null = null;
  let originalError: unknown = null;
  try {
    const response = await authFetch(url, withCallerSignal(first.init, options), options);
    if (response.status !== 502) {
      if (response.ok) reportModelSuccess(primaryModel);
      return { response, ctx: first.ctx, model };
    }
    // 502 = the gateway's own "NEAR never answered" verdict.
    originalResponse = response;
  } catch (err) {
    // A caller abort says nothing about the model — never engage on it.
    if (isCallerAbort(err)) throw err;
    // Only a client timeout/cancellation is model-evidence. Everything else
    // (network down, JSON, auth) is surfaced as-is.
    if (!isAbortLike(err)) throw err;
    originalError = err;
  }

  return engageAndRetry(url, primaryModel, build, options, {
    model,
    ctx: first.ctx,
    response: originalResponse,
    error: originalError,
  });
}

/** The shared timeout-class tail: engage the session fallback and, if that
 *  actually moves us to a different model, retry the call ONCE there. The
 *  original failure is surfaced if the retry doesn't land. */
async function engageAndRetry<C>(
  url: string,
  primaryModel: string,
  build: Build<C>,
  options: CloudCallOptions,
  failed: { model: string; ctx: C; response: Response | null; error: unknown },
): Promise<Leg<C>> {
  reportModelFailure(primaryModel);
  const fallbackModel = resolveModel(primaryModel);
  if (fallbackModel !== failed.model) {
    logger.warn(`${TAG} timeout-class failure — retrying once on session fallback`, {
      url,
      failedModel: failed.model,
      fallbackModel,
    });
    try {
      const retry = await build(fallbackModel);
      // ONE attempt, deliberately: this retry exists so the call that
      // discovered the stall can still succeed, not to open a second budget.
      // Worst case per call stays bounded at (timeout budget + 1) attempts.
      const response = await authFetch(url, withCallerSignal(retry.init, options), {
        ...options,
        maxTimeoutAttempts: 1,
      });
      if (response.status !== 502) {
        return { response, ctx: retry.ctx, model: fallbackModel };
      }
    } catch {
      // Fall through — the original failure is the one worth surfacing.
    }
  }

  if (failed.response) return { response: failed.response, ctx: failed.ctx, model: failed.model };
  throw failed.error;
}

/** How a leg ended. Never a rejection — both legs are tracked, and a loser's
 *  error must not surface as an unhandled rejection or reach the classifier. */
type Settled<C> = { kind: 'leg'; leg: Leg<C> } | { kind: 'error'; err: unknown };

const dropLoserError = () => { /* loser outcome, deliberately dropped */ };

/**
 * Race the primary against its fallback, starting the fallback `hedgeAfterMs`
 * after the primary. The first usable answer wins and the loser is aborted.
 *
 * Both legs get their OWN `build(model)` — E2EE encrypts in place and the
 * attestation key is per-model, so a shared build result would send one leg's
 * ciphertext under the other's key.
 */
async function sendHedged<C>(
  url: string,
  primaryModel: string,
  hedgeModel: string,
  build: Build<C>,
  options: CloudCallOptions,
  hedgeAfterMs: number,
): Promise<Leg<C>> {
  const runLeg = async (
    model: string,
    signal: AbortSignal,
    legOptions: AuthFetchOptions,
  ): Promise<Leg<C>> => {
    const { init, ctx } = await build(model);
    const response = await authFetch(url, { ...init, signal }, legOptions);
    return { response, ctx, model };
  };

  // TAKE THE PRIMARY'S GRANT HERE, not inside authFetch.
  //
  // The hedge timer is armed the moment the primary leg is created. With the
  // limiter in front of authFetch, the primary's bytes leave when the queue
  // permits — so on a busy interactive lane the timer could fire while the
  // primary was still QUEUED, and HEDGE_DELAY_MS would quietly come to mean
  // "10s including queue time" instead of "10s of upstream silence". Taking
  // the grant first re-anchors it on the send. The hedge leg takes its own
  // grant normally; it cannot delay the primary, which was granted ~10s
  // earlier.
  const primaryController = new AbortController();
  const hedgeController = new AbortController();
  // A STOP ABORTS BOTH LEGS. Each leg runs on its own controller (the loser
  // must be abortable alone), so the caller's signal is fanned out to both.
  const stopBoth = () => {
    primaryController.abort();
    hedgeController.abort();
  };
  if (options.signal?.aborted) stopBoth();
  else options.signal?.addEventListener('abort', stopBoth, { once: true });
  await gatewayRateLimiter.acquire(
    options.lane ?? 'background',
    primaryController.signal,
  );
  const primaryRaw = runLeg(primaryModel, primaryController.signal, {
    ...options,
    grantAlreadyHeld: true,
  });
  // `track` attaches handlers immediately, so neither raw promise can ever be
  // an unhandled rejection, and the tagged promise never rejects.
  const primaryP = track('primary', primaryRaw);

  // ─── Phase 1: primary alone, until it settles or the hedge timer fires ──────
  let hedgeTimer: ReturnType<typeof setTimeout> | undefined;
  const timerFired = new Promise<'timer'>((resolve) => {
    hedgeTimer = setTimeout(() => resolve('timer'), hedgeAfterMs);
  });
  const firstUp = await Promise.race([
    primaryP.then(() => 'primary' as const),
    timerFired,
  ]);
  clearTimeout(hedgeTimer);

  if (firstUp === 'primary') {
    // Nothing was hedged — reproduce the sequential semantics exactly,
    // including the engage + retry tail.
    const { settled } = await primaryP;
    if (settled.kind === 'leg' && settled.leg.response.status !== 502) {
      if (settled.leg.response.ok) reportModelSuccess(primaryModel);
      return settled.leg;
    }
    if (settled.kind === 'error') {
      if (isCallerAbort(settled.err)) throw settled.err;
      if (!isAbortLike(settled.err)) throw settled.err;
    }
    return engageAndRetry(url, primaryModel, build, options, {
      model: primaryModel,
      // Only read when a response is being surfaced, which implies `kind: leg`.
      ctx: settled.kind === 'leg' ? settled.leg.ctx : (undefined as unknown as C),
      response: settled.kind === 'leg' ? settled.leg.response : null,
      error: settled.kind === 'error' ? settled.err : null,
    });
  }

  // ─── Phase 2: both legs in flight ──────────────────────────────────────────
  logger.warn(`${TAG} hedge fired`, { primaryModel, hedgeModel });
  // ONE attempt: the hedge exists to answer FAST. A retrying hedge is just a
  // second storm on a second model.
  const hedgeRaw = runLeg(hedgeModel, hedgeController.signal, {
    ...options,
    maxTimeoutAttempts: 1,
  });
  const hedgeP = track('hedge', hedgeRaw);

  // The winner latch: whichever tagged promise `Promise.race` resolves first.
  // Already-settled promises resolve in array order, so a same-tick tie goes to
  // the primary — which is what "the primary stays authoritative" means.
  let pendingPrimary: Promise<Tagged<C>> | null = primaryP;
  let pendingHedge: Promise<Tagged<C>> | null = hedgeP;
  let primaryFailure: { ctx: C; response: Response | null; error: unknown } | null = null;

  const surfacePrimaryFailure = (): Leg<C> => {
    if (primaryFailure!.response) {
      return { response: primaryFailure!.response, ctx: primaryFailure!.ctx, model: primaryModel };
    }
    throw primaryFailure!.error;
  };

  for (;;) {
    const racers: Promise<Tagged<C>>[] = [];
    if (pendingPrimary) racers.push(pendingPrimary);
    if (pendingHedge) racers.push(pendingHedge);
    const out = await Promise.race(racers);

    if (out.who === 'primary') {
      pendingPrimary = null;
      if (out.settled.kind === 'leg' && out.settled.leg.response.status !== 502) {
        // Any non-502 verdict — including a 4xx — is the primary's to give. A
        // fallback response must never mask a real HTTP error.
        hedgeController.abort();
        void hedgeRaw.catch(dropLoserError);
        if (out.settled.leg.response.ok) reportModelSuccess(primaryModel);
        return out.settled.leg;
      }
      if (out.settled.kind === 'leg') {
        primaryFailure = {
          ctx: out.settled.leg.ctx,
          response: out.settled.leg.response,
          error: null,
        };
        reportModelFailure(primaryModel); // 502 = timeout-class
      } else {
        primaryFailure = {
          ctx: undefined as unknown as C, // never read: no response to decrypt
          response: null,
          error: out.settled.err,
        };
        // A caller abort (our own loser-abort included) and plain network
        // errors say nothing about the model.
        if (!isCallerAbort(out.settled.err) && isAbortLike(out.settled.err)) {
          // No sequential retry here — the in-flight hedge IS that retry.
          reportModelFailure(primaryModel);
        }
      }
      if (!pendingHedge) return surfacePrimaryFailure();
      continue; // the hedge is the only remaining hope
    }

    pendingHedge = null;
    if (out.settled.kind === 'leg' && out.settled.leg.response.ok) {
      primaryController.abort();
      void primaryRaw.catch(dropLoserError);
      reportModelSlow(primaryModel);
      logger.warn(`${TAG} hedge won`, { primaryModel, hedgeModel });
      return out.settled.leg;
    }
    // The hedge's own failure is never classified, reported, or budgeted — it
    // is a bonus leg, not evidence.
    if (primaryFailure) return surfacePrimaryFailure();
  }
}

interface Tagged<C> {
  who: 'primary' | 'hedge';
  settled: Settled<C>;
}

function track<C>(who: 'primary' | 'hedge', p: Promise<Leg<C>>): Promise<Tagged<C>> {
  return p.then(
    (leg) => ({ who, settled: { kind: 'leg', leg } as Settled<C> }),
    (err) => ({ who, settled: { kind: 'error', err } as Settled<C> }),
  );
}
