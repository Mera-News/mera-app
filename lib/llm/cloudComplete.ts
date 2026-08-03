// cloudComplete — cloud LLM completion, batch completion, and streaming chat.
// Cloud inference is ALWAYS end-to-end encrypted: messages are encrypted
// client-side (see lib/e2ee/e2ee-service) before leaving the device, and
// responses are decrypted locally. There is no plaintext path — if E2EE
// fails, the call fails and the user sees an error.

import { fetch as expoFetch } from 'expo/fetch';
import { getJwtToken, invalidateJwtCache } from '../auth-client';
import {
  decryptContent,
  encryptContent,
  encryptMessages,
  prepareE2EEContext,
  type SigningAlgo,
} from '../e2ee/e2ee-service';
import logger from '../logger';
import { SMALL_MODEL } from './constants';
import {
  fallbackFor,
  reportModelFailure,
  reportModelSlow,
  reportModelSuccess,
  resolveModel,
} from './model-fallback';
import { sseEvents } from './sse';
import { estimateTokens } from './tokens';
import type { BatchCall, ToolDefinition } from './types';
import { INFERENCE_ENDPOINT } from '@/lib/config/endpoints';

const TAG = '[CloudLLM]';

const CHAT_API = `${INFERENCE_ENDPOINT}/v1/chat/completions`;
const BATCH_API = `${INFERENCE_ENDPOINT}/v1/chat/completions/batch`;

/** Per-attempt timeout for EVERY gateway-bound cloud call (chat, single
 *  completion, batch). It must exceed the gateway's own UPSTREAM_TIMEOUT_MS
 *  (120s) so the gateway's verdict — a 200, or the 502 it emits when NEAR never
 *  answered — lands before the client aborts. A client that aborts FIRST never
 *  learns anything and just starts a fresh attempt against a model that is
 *  still warming: that is the retry storm this constant exists to kill.
 *  130s = 120s gateway + 10s slack.
 *
 *  COUPLING (mera-inference-gateway fix C.1): `client 130s > gateway 120s` is
 *  only true once the gateway's deadline is stamped at REQUEST ENTRY and so
 *  bounds queue wait + upstream. Today it starts at slot acquisition, which
 *  makes the real gateway budget `queue wait + 120s` — unbounded under
 *  saturation, and the client still aborts first, just at a bigger number.
 *  This 130s assumption lands together with that gateway change; changing one
 *  without the other silently re-opens the storm. */
export const UPSTREAM_ALIGNED_TIMEOUT_MS = 130_000;

/** 502/timeout attempt cap for every gateway-bound cloud call. A cold or
 *  stalled NEAR model can exceed even 120s, and retrying the SAME model just
 *  storms; cap at 2 total attempts so a persistent stall surfaces the gateway's
 *  502 in bounded time. The chat model is warmed ahead of the first turn by
 *  prewarmCloudChat() (lib/llm/prewarm). */
export const UPSTREAM_ALIGNED_MAX_TIMEOUT_ATTEMPTS = 2;

/** Hedge delay for user-facing calls: after this long with nothing back from
 *  the primary model, the SAME request is fired at its fallback and the two
 *  race. With streaming, response headers ≈ the first token through the
 *  gateway, so this only fires when literally nothing has arrived — a warming
 *  or stalled model — never when a model is simply generating a long answer.
 *
 *  Raised 5s → 10s on 2026-08-03. A hedge WIN switches the whole session to
 *  the fallback, and no fallback matches the primary's quality (see
 *  MODEL_FALLBACKS): at 5s a merely-warming primary lost races it should have
 *  won, and the session paid for it in every later turn. 10s is past a healthy
 *  first token yet far short of the 130s timeout this exists to pre-empt, so
 *  the hedge stays a stall-rescue rather than a latency tuner. */
export const HEDGE_DELAY_MS = 10_000;

/** Max gap BETWEEN CHUNKS of an in-flight SSE body — deliberately not the time
 *  to the FIRST chunk, which stays on {@link UPSTREAM_ALIGNED_TIMEOUT_MS}.
 *
 *  Whether NEAR flushes SSE headers on accept or only with the first token is
 *  unverified (the gateway relays whatever it gets). If headers land on accept,
 *  a single 30s window measured from headers would abort a cold model that the
 *  old buffered path tolerated for 130s — a regression on exactly the path this
 *  is meant to speed up. Two windows make the constant mean what it says under
 *  either upstream behavior. */
export const STREAM_IDLE_TIMEOUT_MS = 30_000;

/** Build auth headers, fetching a fresh JWT from the auth service. Throws if
 *  no token is available — sending an unauthenticated request just produces
 *  10 useless 401 retries (see authFetch) and surfaces as a confusing HTTP
 *  error downstream. Failing fast here gives the caller a clear cause. */
async function getAuthHeaders(): Promise<Record<string, string>> {
  const token = await getJwtToken();
  if (!token) {
    throw new Error('cloudComplete: no JWT token available');
  }
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
  };
}

const MAX_RETRIES = 10;
const BASE_DELAY_MS = 500;

/** Default per-attempt timeout for cloud requests (scoring/batch). Inference can
 *  take a while on a cold model + large prompt, but anything past this is almost
 *  certainly a hung connection and we'd rather surface the error to the caller. */
const REQUEST_TIMEOUT_MS = 60_000;

/** Per-call overrides for {@link authFetch}. Defaults preserve the original
 *  shared behavior for every existing caller (scoring, batch); only the chat
 *  path opts into different values. */
export interface AuthFetchOptions {
  /** Per-attempt timeout (ms). Default {@link REQUEST_TIMEOUT_MS}. The chat path
   *  sets this ABOVE the gateway's own UPSTREAM_TIMEOUT_MS (120s) so the
   *  gateway's verdict (200, or a 502 it decides to emit) arrives before the
   *  client aborts. A client abort earlier than the gateway timeout just
   *  triggers a fresh attempt against a model that is still warming — the storm
   *  this whole change exists to kill. */
  requestTimeoutMs?: number;
  /** Cap on the number of attempts that end in a 502 (the gateway's own
   *  upstream-timeout verdict) or a client timeout/network abort. Default
   *  MAX_RETRIES + 1 (i.e. the original behavior — retry every 5xx/timeout up to
   *  MAX_RETRIES). The chat path caps this at 2 so a persistently-cold model
   *  surfaces the gateway's 502 in bounded time instead of a multi-minute loop.
   *  401 refresh and non-502 5xx retries are unaffected. */
  maxTimeoutAttempts?: number;
  /** Keep the response BODY readable after {@link authFetch} returns. Normally
   *  authFetch tears the attempt down the moment headers arrive — correct when
   *  the caller immediately buffers, wrong for a stream that is only starting.
   *  With this set the abort bridge stays attached and the caller must take the
   *  handle via {@link takeStreamHandle} and release it when the body ends.
   *  Chat streaming is the only caller. */
  streamBody?: boolean;
}

/** Per-call options for the cloud entry points, which additionally choose
 *  whether to hedge. `authFetch` itself never hedges — a hedge is two whole
 *  requests on two different models, which only the model-fallback layer above
 *  it can reason about. */
export interface CloudCallOptions extends AuthFetchOptions {
  /** Fire the same request at the primary's fallback after this many ms and
   *  race them. Omit (the default) to disable hedging entirely. */
  hedgeAfterMs?: number;
}

/**
 * A caller's own signal aborted the request. Distinct from the per-attempt
 * timeout abort, which is indistinguishable by message alone: both surface as
 * "aborted"/"canceled" from expo/fetch. A caller abort is not evidence about
 * the model and must never consume the timeout budget, retry, or engage the
 * session fallback.
 */
export class CallerAbortError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'CallerAbortError';
    if (cause !== undefined) (this as { cause?: unknown }).cause = cause;
  }
}

export function isCallerAbort(err: unknown): boolean {
  return err instanceof CallerAbortError;
}

/** Live per-attempt resources of a response whose body is still being read. */
interface StreamHandle {
  /** Abort the in-flight body (the per-attempt controller). */
  abort: () => void;
  /** Detach the caller-signal bridge. Must run once the body is done. */
  release: () => void;
}

// Keyed by Response so the handle follows whichever leg actually won a hedge
// race, with no plumbing through the return shape every non-stream caller uses.
// A losing leg's handle is simply never taken: the entry dies with its Response,
// and the listener it would have detached sits on that leg's own throwaway
// controller.
const streamHandles = new WeakMap<Response, StreamHandle>();

/** Take (and remove) the stream handle attached to a `streamBody` response. */
export function takeStreamHandle(response: Response): StreamHandle | undefined {
  const handle = streamHandles.get(response);
  if (handle) streamHandles.delete(response);
  return handle;
}

/**
 * Is this error a client-side cancellation (our per-attempt timeout, or a
 * caller abort)? `expo/fetch` words its cancellation "Fetch request has been
 * canceled", which the old `/abort/`-only test missed — so our own 60s timeouts
 * were logged as `timedOut: false` and read as network errors during the
 * 2026-07-31 incident. Matching `cancel` as well makes the log state the truth;
 * the retry budget is unaffected (aborts and network errors already share it).
 */
export function isAbortLike(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.name === 'AbortError') return true;
  const message = err.message.toLowerCase();
  return message.includes('abort') || message.includes('cancel');
}

/**
 * Combine a caller-supplied signal with the per-attempt timeout signal.
 *
 * The previous `init.signal ?? controller.signal` silently DISABLED the timeout
 * for any caller that passed a signal — the request could then hang forever.
 * `AbortSignal.any` is not in React Native's `abort-controller` polyfill, so it
 * is feature-detected and bridged with listeners otherwise. The returned
 * `release` must be called per attempt, or listeners stack up on the caller's
 * (long-lived) signal once per retry.
 */
function combineSignals(
  external: AbortSignal | null | undefined,
  timeout: AbortSignal,
): { signal: AbortSignal; release: () => void } {
  const noop = () => { /* nothing to release */ };
  if (!external) return { signal: timeout, release: noop };

  const anyFn = (AbortSignal as unknown as {
    any?: (signals: AbortSignal[]) => AbortSignal;
  }).any;
  if (typeof anyFn === 'function') {
    return { signal: anyFn.call(AbortSignal, [external, timeout]), release: noop };
  }

  const combined = new AbortController();
  if (external.aborted || timeout.aborted) combined.abort();
  const onAbort = () => combined.abort();
  external.addEventListener('abort', onAbort);
  timeout.addEventListener('abort', onAbort);
  return {
    signal: combined.signal,
    release: () => {
      external.removeEventListener('abort', onAbort);
      timeout.removeEventListener('abort', onAbort);
    },
  };
}

/**
 * Fetch with exponential backoff and a per-attempt timeout.
 * Retries on 401 (refreshes JWT), 5xx, timeout, and network errors.
 *
 * `options` tunes the timeout + the 502/timeout retry budget per call without
 * changing the shared defaults every other caller relies on.
 */
export async function authFetch(
  url: string,
  init: RequestInit,
  options: AuthFetchOptions = {},
): Promise<Response> {
  const requestTimeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
  const maxTimeoutAttempts = options.maxTimeoutAttempts ?? MAX_RETRIES + 1;
  let lastError: Error | null = null;
  // Counts attempts that ended in a 502 or a client timeout/network abort —
  // i.e. the "upstream is cold / unreachable" family the chat path caps.
  let timeoutAttempts = 0;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    // The ONLY reliable discriminator between a caller abort and our own
    // per-attempt timeout: the caller's original signal. The combined signal is
    // aborted by both. Checked at the loop top so an aborted leg that is mid
    // backoff exits here (sleep() is deliberately not abort-aware — the extra
    // wait is bounded and never turns into another request).
    if (init.signal?.aborted) {
      throw new CallerAbortError('authFetch: caller aborted', lastError);
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), requestTimeoutMs);
    // A caller signal must ADD to the timeout, never replace it.
    const { signal, release } = combineSignals(init.signal, controller.signal);
    // Set when the attempt's teardown is handed to the caller (streamBody).
    let handedOff = false;

    try {
      const response = await (expoFetch as unknown as typeof globalThis.fetch)(url, {
        ...init,
        signal,
      });

      if (response.status === 401 && attempt < MAX_RETRIES) {
        logger.warn(`${TAG} 401 on attempt ${attempt + 1}, refreshing JWT`);
        invalidateJwtCache();
        const freshHeaders = await getAuthHeaders();
        init = {
          ...init,
          headers: { ...init.headers as Record<string, string>, ...freshHeaders },
        };
        await sleep(BASE_DELAY_MS * 2 ** attempt);
        continue;
      }

      if (response.status === 502) {
        // 502 = the gateway couldn't get a verdict from NEAR within its own
        // UPSTREAM_TIMEOUT_MS (a cold model). Retrying against the SAME cold
        // model just storms, so this counts against the (chat-capped) timeout
        // budget; once exhausted we surface the 502 rather than loop.
        timeoutAttempts += 1;
        if (timeoutAttempts < maxTimeoutAttempts && attempt < MAX_RETRIES) {
          logger.warn(`${TAG} 502 on attempt ${attempt + 1}, retrying`);
          await sleep(BASE_DELAY_MS * 2 ** attempt);
          continue;
        }
        logger.warn(
          `${TAG} 502 on attempt ${attempt + 1} — timeout budget exhausted (${timeoutAttempts}/${maxTimeoutAttempts}), surfacing`,
        );
        return response;
      }

      if (response.status >= 500 && attempt < MAX_RETRIES) {
        // Non-502 5xx (500/503/504) — transient gateway/app errors, keep the
        // original sane retry budget.
        logger.warn(`${TAG} ${response.status} on attempt ${attempt + 1}, retrying`);
        await sleep(BASE_DELAY_MS * 2 ** attempt);
        continue;
      }

      if (options.streamBody) {
        // Headers are in, the body is not. Drop the 130s header timer but keep
        // the caller-signal bridge attached so an abort still cancels the
        // in-flight body (on the RN polyfill path nothing else would).
        clearTimeout(timeoutId);
        handedOff = true;
        streamHandles.set(response, {
          abort: () => controller.abort(),
          release,
        });
      }
      return response;
    } catch (err) {
      // A caller abort ends the call here: no budget spent, no retry, no sleep.
      if (init.signal?.aborted) {
        throw new CallerAbortError('authFetch: caller aborted', err);
      }
      lastError = err instanceof Error ? err : new Error(String(err));
      const isAbort = isAbortLike(lastError);
      if (isAbort) {
        logger.warn(
          `${TAG} request timed out after ${requestTimeoutMs}ms (attempt ${attempt + 1})`,
          { url },
        );
      }
      // Timeout/network failures share the cold-upstream budget with 502s.
      timeoutAttempts += 1;
      if (attempt < MAX_RETRIES && timeoutAttempts < maxTimeoutAttempts) {
        logger.warn(`${TAG} fetch error on attempt ${attempt + 1}, retrying`, {
          error: lastError.message,
          timedOut: isAbort,
        });
        await sleep(BASE_DELAY_MS * 2 ** attempt);
      } else {
        break;
      }
    } finally {
      if (!handedOff) {
        clearTimeout(timeoutId);
        release();
      }
    }
  }

  throw lastError ?? new Error('authFetch failed after retries');
}

/** Apply the gateway-aligned defaults, letting an explicit caller value win. */
function withUpstreamAlignedDefaults(options: CloudCallOptions): CloudCallOptions {
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
async function sendWithModelFallback<C>(
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

/** The original (pre-hedge) sequential behavior: one request, and on a
 *  timeout-class failure, engage + retry once on the fallback. */
async function sendSequential<C>(
  url: string,
  primaryModel: string,
  build: Build<C>,
  options: AuthFetchOptions,
): Promise<Leg<C>> {
  const model = resolveModel(primaryModel);
  const first = await build(model);

  let originalResponse: Response | null = null;
  let originalError: unknown = null;
  try {
    const response = await authFetch(url, first.init, options);
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
  options: AuthFetchOptions,
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
      const response = await authFetch(url, retry.init, { ...options, maxTimeoutAttempts: 1 });
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

  const primaryController = new AbortController();
  const primaryRaw = runLeg(primaryModel, primaryController.signal, options);
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
  const hedgeController = new AbortController();
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// SSE event types (OpenAI chat completion chunk format)
// ---------------------------------------------------------------------------

export type SseEvent =
  | { type: 'text-delta'; delta: string }
  | { type: 'tool-call-delta'; index: number; id?: string; name?: string; argumentsDelta: string }
  | { type: 'finish'; reason: 'stop' | 'tool_calls' | 'error' }
  | { type: 'error'; message: string };

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

// Canonical home is now lib/news-harness/core/types.ts; re-exported here so
// importers of BatchCompletionResult from this module keep working.
import type { BatchCompletionResult } from '@/lib/news-harness/core/types';
export type { BatchCompletionResult };

export interface CloudCompleteRequest {
  systemPrompt: string;
  prompt: string;
  model?: string;
  maxTokens?: number;
  maxCompletionTokens?: number;
  temperature?: number;
  topP?: number;
  presencePenalty?: number;
  frequencyPenalty?: number;
}

/** Non-streaming chat completion response (used for E2EE path). */
interface ChatCompletionResponse {
  id?: string;
  model?: string;
  choices?: {
    message?: {
      content?: string;
      reasoning_content?: string;
      tool_calls?: {
        id: string;
        type: 'function';
        function: { name: string; arguments: string };
      }[];
    };
    finish_reason?: string;
  }[];
}

/** Single E2EE completion call (used for scoring). */
export async function cloudComplete(
  request: CloudCompleteRequest,
  options: CloudCallOptions = {},
): Promise<string> {
  const temperature = request.temperature ?? 0.3;
  const primary = request.model ?? SMALL_MODEL;
  const model = resolveModel(primary);
  const maxTokens = request.maxTokens ?? request.maxCompletionTokens;

  const systemTokens = estimateTokens(request.systemPrompt);
  const promptTokens = estimateTokens(request.prompt);
  logger.debug('[CloudLLM:complete] Token estimate', {
    systemTokens,
    promptTokens,
    totalInputTokens: systemTokens + promptTokens,
    maxOutputTokens: request.maxTokens ?? request.maxCompletionTokens,
    model,
  });

  const { response, ctx } = await sendWithModelFallback(
    CHAT_API,
    primary,
    // Rebuilt per attempt: encryptMessages encrypts in place and the
    // attestation key is per-model, so a fallback retry needs fresh plaintext.
    async (sendModel) => {
      const messages = [
        { role: 'system', content: request.systemPrompt },
        { role: 'user', content: request.prompt },
      ];
      const attemptCtx = await encryptMessages(messages, sendModel);
      const baseHeaders = await getAuthHeaders();
      return {
        init: {
          method: 'POST',
          headers: { ...baseHeaders, ...attemptCtx.headers },
          body: JSON.stringify({
            messages, stream: false, temperature, model: sendModel,
            chat_template_kwargs: { enable_thinking: false },
            // Honor the caller's output cap — lets the prewarm warmup request a
            // single throwaway token instead of a full completion.
            ...(maxTokens !== undefined && { max_tokens: maxTokens }),
          }),
        } satisfies RequestInit,
        ctx: attemptCtx,
      };
    },
    withUpstreamAlignedDefaults(options),
  );

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    throw new Error(`E2EE completion failed: ${response.status} ${response.statusText} — ${errorText}`);
  }

  const data = await response.json() as ChatCompletionResponse;
  const msg = data.choices?.[0]?.message;
  const encContent = msg?.content || msg?.reasoning_content || '';
  if (!encContent) return '';

  return decryptContent(encContent, ctx.privateKey, ctx.algo).trim();
}

/** E2EE batch completion via /v1/chat/completions/batch. Shares E2EE context across all items. */
export async function cloudBatchComplete(
  calls: BatchCall[],
  model?: string,
  options: CloudCallOptions = {},
): Promise<BatchCompletionResult[]> {
  if (calls.length === 0) return [];
  const primary = model ?? SMALL_MODEL;
  const resolvedModel = resolveModel(primary);

  // Per-call token estimate — helps diagnose empty outputs and context issues.
  let totalSystemTokens = 0;
  let totalPromptTokens = 0;
  for (const call of calls) {
    const systemTokens = estimateTokens(call.system);
    const promptTokens = estimateTokens(call.prompt);
    totalSystemTokens += systemTokens;
    totalPromptTokens += promptTokens;
    logger.debug('[CloudLLM:batch] Token estimate', {
      id: call.id,
      systemTokens,
      promptTokens,
      totalInputTokens: systemTokens + promptTokens,
      maxOutputTokens: call.maxTokens,
      model: resolvedModel,
    });
  }
  logger.debug('[CloudLLM:batch] Token estimate total', {
    callCount: calls.length,
    totalSystemTokens,
    totalPromptTokens,
    totalInputTokens: totalSystemTokens + totalPromptTokens,
    model: resolvedModel,
  });

  const { response, ctx } = await sendWithModelFallback(
    BATCH_API,
    primary,
    // Rebuilt per attempt — a fallback retry needs its own E2EE context and a
    // body encrypted under the fallback model's attestation key.
    async (sendModel) => {
      const attemptCtx = await prepareE2EEContext(sendModel);

      const requests = calls.map((call) => {
        const messages = [
          { role: 'system', content: call.system },
          { role: 'user', content: call.prompt },
        ];
        for (const msg of messages) {
          if (msg.content.length > 0) {
            msg.content = encryptContent(msg.content, attemptCtx);
          }
        }
        return {
          messages,
          stream: false,
          temperature: call.temperature ?? 0.3,
          model: sendModel,
          chat_template_kwargs: { enable_thinking: false },
          ...(call.maxTokens !== undefined && { max_tokens: call.maxTokens }),
        };
      });

      const baseHeaders = await getAuthHeaders();
      return {
        init: {
          method: 'POST',
          headers: { ...baseHeaders, ...attemptCtx.headers },
          body: JSON.stringify({ requests }),
        } satisfies RequestInit,
        ctx: attemptCtx,
      };
    },
    withUpstreamAlignedDefaults(options),
  );

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    throw new Error(`E2EE batch failed: ${response.status} ${response.statusText} — ${errorText}`);
  }

  const data = await response.json() as BatchResponse;
  return mapBatchResults(calls, data, ctx.privateKey, ctx.algo);
}

interface BatchResponse {
  results: {
    index: number;
    response?: ChatCompletionResponse;
    error?: { message: string };
  }[];
}

function mapBatchResults(
  calls: BatchCall[],
  data: BatchResponse,
  privateKey: Uint8Array,
  algo: SigningAlgo,
): BatchCompletionResult[] {
  const resultsByIndex = new Map(data.results.map((r) => [r.index, r]));

  return calls.map((call, i) => {
    const item = resultsByIndex.get(i);
    if (!item) return { id: call.id, output: '', error: 'Missing result from batch' };
    if (item.error) return { id: call.id, output: '', error: item.error.message };

    const choice = item.response?.choices?.[0];
    const msg = choice?.message;
    const encContent = msg?.content || msg?.reasoning_content || '';
    if (!encContent) {
      logger.warn(`${TAG} batch item returned empty content`, {
        id: call.id,
        finishReason: choice?.finish_reason,
        usage: (item.response as { usage?: unknown })?.usage,
        hasMessage: !!msg,
        hasContent: !!msg?.content,
        hasReasoningContent: !!msg?.reasoning_content,
        messageKeys: msg ? Object.keys(msg) : [],
        maxTokensRequested: call.maxTokens,
      });
      return { id: call.id, output: '' };
    }

    try {
      const output = decryptContent(encContent, privateKey, algo).trim();
      if (output.length === 0) {
        logger.warn(`${TAG} batch item decrypted to empty string`, {
          id: call.id,
          finishReason: choice?.finish_reason,
          usage: (item.response as { usage?: unknown })?.usage,
          encContentLength: encContent.length,
          maxTokensRequested: call.maxTokens,
        });
      }
      return { id: call.id, output };
    } catch (err) {
      logger.error(`${TAG} batch decrypt failed id=${call.id}`, err);
      return { id: call.id, output: '', error: err instanceof Error ? err.message : 'Decrypt error' };
    }
  });
}


// ---------------------------------------------------------------------------
// Wire types for OpenAI-format messages
// ---------------------------------------------------------------------------

export interface WireToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export type WireMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; tool_calls?: WireToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };

export interface CloudChatStreamRequest {
  messages: WireMessage[];
  tools?: ToolDefinition[];
  system?: string;
  model?: string;
  toolChoice?: string;
  temperature?: number;
  maxTokens?: number;
  maxCompletionTokens?: number;
  topP?: number;
  n?: number;
  presencePenalty?: number;
  frequencyPenalty?: number;
}

/** One OpenAI streaming chunk. `choices` is optional AND may be empty — the
 *  final usage-only chunk carries `choices: []`. */
interface ChatCompletionChunk {
  choices?: {
    delta?: {
      content?: string | null;
      reasoning_content?: string | null;
      role?: string;
      tool_calls?: {
        index?: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }[];
    };
    finish_reason?: string | null;
  }[];
}

/**
 * E2EE chat: encrypt messages, stream the response, decrypt each delta, emit
 * events. NEAR encrypts every streamed `delta.content` as its OWN self-contained
 * envelope under the same client key, so decryption is per-delta and the user
 * sees text as it is generated (verified against cloud-api.near.ai, 2026-08-03).
 * A non-SSE response (upstream ignoring `stream: true`) falls through to the
 * original buffered handling.
 */
export async function* cloudChatStream(
  request: CloudChatStreamRequest,
): AsyncGenerator<SseEvent> {
  logger.debug(`${TAG} cloudChatStream ENTER`, { messageCount: request.messages.length });

  const primary = request.model ?? SMALL_MODEL;
  const model = resolveModel(primary);

  // Token estimate — parallel to useLocalLLM's [LocalLLM:chat] Token estimate log.
  let totalInputTokens = 0;
  for (const m of request.messages) {
    const content = typeof m.content === 'string' ? m.content : '';
    totalInputTokens += estimateTokens(content);
  }
  logger.debug('[CloudLLM:chat] Token estimate', {
    messageCount: request.messages.length,
    totalInputTokens,
    toolCount: request.tools?.length ?? 0,
    maxOutputTokens: request.maxTokens ?? request.maxCompletionTokens,
    model,
  });

  logger.debug(`${TAG} cloudChatStream POST`, { url: CHAT_API });

  // Rebuilt per attempt/leg: the deep copy must be FRESH, or a fallback retry
  // would re-encrypt already-encrypted content (and under the wrong key).
  const buildChatRequest = async (sendModel: string) => {
    const messages = request.messages.map((m) => ({ ...m }));
    const attemptCtx = await encryptMessages(
      messages as { role: string; content: string;[k: string]: unknown }[],
      sendModel,
    );

    // Dev-only timing: JWT fetch on the first-chat path (cache hit ≈ 0ms, miss
    // = real auth round-trip). getAuthHeaders' only awaited work is getJwtToken.
    const jwtStartMs = Date.now();
    const baseHeaders = await getAuthHeaders();
    logger.debug('[chat-timing] jwt fetch (chat)', { ms: Date.now() - jwtStartMs });

    const body: Record<string, unknown> = {
      messages,
      // Each streamed delta is its own E2EE envelope, so streaming and E2EE
      // coexist — see cloudChatStream's doc comment.
      stream: true,
      model: sendModel,
      chat_template_kwargs: { enable_thinking: true },
    };
    if (request.tools && request.tools.length > 0) {
      body.tools = request.tools;
      body.tool_choice = request.toolChoice ?? 'auto';
    }
    if (request.temperature !== undefined) body.temperature = request.temperature;
    if (request.maxTokens !== undefined) body.max_tokens = request.maxTokens;
    if (request.maxCompletionTokens !== undefined) body.max_completion_tokens = request.maxCompletionTokens;
    if (request.topP !== undefined) body.top_p = request.topP;
    if (request.n !== undefined) body.n = request.n;
    if (request.presencePenalty !== undefined) body.presence_penalty = request.presencePenalty;
    if (request.frequencyPenalty !== undefined) body.frequency_penalty = request.frequencyPenalty;

    return {
      init: {
        method: 'POST',
        headers: { ...baseHeaders, ...attemptCtx.headers },
        body: JSON.stringify(body),
      } satisfies RequestInit,
      ctx: attemptCtx,
    };
  };

  // Dev-only timing: per-request POST→response wall time. Tagged for first-chat
  // latency attribution.
  const postStartMs = Date.now();
  const { response, ctx, model: sentModel } = await sendWithModelFallback(
    CHAT_API,
    primary,
    buildChatRequest,
    // Chat has always used the gateway-aligned budget; every other cloud call
    // now shares it (plan A). Chat is the only user-facing path, so it is also
    // the only one that hedges and the only one that streams its body.
    withUpstreamAlignedDefaults({ hedgeAfterMs: HEDGE_DELAY_MS, streamBody: true }),
  );
  logger.debug('[chat-timing] chat POST→response', {
    ms: Date.now() - postStartMs,
    status: response.status,
  });

  if (!response.ok) {
    takeStreamHandle(response)?.release();
    const errorText = await response.text().catch(() => '');
    logger.error(`${TAG} cloudChatStream HTTP error`, undefined, { status: response.status, errorText });
    throw new Error(`E2EE chat failed: ${response.status} ${response.statusText} — ${errorText}`);
  }

  let textYielded = false;
  try {
    for await (const event of consumeChatResponse(response, ctx.privateKey, ctx.algo)) {
      if (event.type === 'text-delta') textYielded = true;
      yield event;
    }
    return;
  } catch (err) {
    // Text already reached the user: surface the error so the existing
    // failed-turn UX finalizes. Silently re-sending a half-answered prompt
    // would duplicate the answer.
    if (textYielded) throw err;
    // Already on the fallback (session-engaged, or a hedge winner) — there is
    // no healthier model left to try.
    if (sentModel !== primary) throw err;
    // Only an abort-class death (idle stall, cancelled body) is model-evidence.
    // A decrypt failure is NOT: model-fallback.ts is explicit that "4xx, auth,
    // E2EE/decrypt and plain network errors say nothing about the model".
    if (isAbortLike(err) && !isCallerAbort(err)) reportModelFailure(primary);
    logger.warn(`${TAG} stream died before any text — one fresh attempt`, {
      failedModel: sentModel,
      error: String(err),
    });
  }

  // ONE fresh request, on whatever the primary now resolves to. Bounded by
  // construction: this branch is only reachable with zero text yielded, and it
  // never recurses.
  const retry = await buildChatRequest(resolveModel(primary));
  const retryResponse = await authFetch(CHAT_API, retry.init, {
    ...withUpstreamAlignedDefaults({ streamBody: true }),
    maxTimeoutAttempts: 1,
  });
  if (!retryResponse.ok) {
    takeStreamHandle(retryResponse)?.release();
    const errorText = await retryResponse.text().catch(() => '');
    throw new Error(
      `E2EE chat failed: ${retryResponse.status} ${retryResponse.statusText} — ${errorText}`,
    );
  }
  yield* consumeChatResponse(retryResponse, retry.ctx.privateKey, retry.ctx.algo);
}

/** Turn an OK chat response into events, streaming when the gateway relayed
 *  SSE and buffering when it relayed JSON. */
async function* consumeChatResponse(
  response: Response,
  privateKey: Uint8Array,
  algo: SigningAlgo,
): AsyncGenerator<SseEvent> {
  const handle = takeStreamHandle(response);
  const contentType = response.headers?.get('content-type') ?? '';
  if (!response.body || !contentType.includes('text/event-stream')) {
    // The gateway relays NEAR's content-type verbatim, so JSON here means the
    // upstream ignored `stream: true`. Buffered handling, unchanged.
    handle?.release();
    yield* consumeBufferedChat(response, privateKey, algo);
    return;
  }
  yield* consumeSseChat(response, privateKey, algo, handle);
}

/** Streaming path: one E2EE envelope per `delta.content`, decrypted as it lands. */
async function* consumeSseChat(
  response: Response,
  privateKey: Uint8Array,
  algo: SigningAlgo,
  handle: StreamHandle | undefined,
): AsyncGenerator<SseEvent> {
  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let idleTimedOut = false;
  const armIdle = (ms: number) => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      idleTimedOut = true;
      // Abort the in-flight body so the pending read rejects instead of
      // hanging forever behind a silent upstream.
      handle?.abort();
      void reader.cancel().catch(() => { /* already dead */ });
    }, ms);
  };

  let finishReason = 'stop';
  try {
    // authFetch dropped its own 130s header timer at handoff; until the first
    // chunk arrives this reinstates the same budget (a cold model may sit on an
    // open, silent stream). Every chunk after that tightens it.
    armIdle(UPSTREAM_ALIGNED_TIMEOUT_MS);
    for await (const payload of sseEvents(reader, () => armIdle(STREAM_IDLE_TIMEOUT_MS))) {
      if (payload === '[DONE]') break;
      let chunk: ChatCompletionChunk;
      try {
        chunk = JSON.parse(payload) as ChatCompletionChunk;
      } catch {
        logger.debug(`${TAG} unparseable SSE payload (skipped)`, {
          prefix: payload.slice(0, 80),
        });
        continue;
      }
      // The trailing usage chunk carries `choices: []`.
      const choice = chunk.choices?.[0];
      if (!choice) continue;
      if (choice.finish_reason) finishReason = choice.finish_reason;
      const delta = choice.delta;
      if (!delta) continue;

      // `delta.reasoning_content` is chain-of-thought. It arrives as its own
      // field and may itself be an encrypted envelope; it is dropped WITHOUT
      // decrypting, and must never be yielded as assistant text.
      if (delta.content) {
        yield { type: 'text-delta', delta: decryptContent(delta.content, privateKey, algo) };
      }

      // Tool-call arguments arrive as CLEARTEXT fragments (see the E2EE gap
      // note below). Forwarded as they land; the consumer accumulates them.
      for (const tc of delta.tool_calls ?? []) {
        yield {
          type: 'tool-call-delta',
          index: tc.index ?? 0,
          id: tc.id,
          name: tc.function?.name,
          argumentsDelta: tc.function?.arguments ?? '',
        };
      }
    }
    // A cancelled reader ends the loop cleanly, so the flag is the only signal.
    if (idleTimedOut) throw new Error(`${TAG} chat stream went idle`);
  } finally {
    clearTimeout(idleTimer);
    handle?.release();
  }

  yield { type: 'finish', reason: finishReason === 'tool_calls' ? 'tool_calls' : 'stop' };
}

/** Buffered path: a whole non-streaming completion, one envelope for the whole
 *  answer. Reached when the upstream ignores `stream: true`. */
async function* consumeBufferedChat(
  response: Response,
  privateKey: Uint8Array,
  algo: SigningAlgo,
): AsyncGenerator<SseEvent> {
  const data = (await response.json()) as ChatCompletionResponse;
  const choice = data.choices?.[0];
  if (!choice) {
    yield { type: 'finish', reason: 'stop' };
    return;
  }

  // Decrypt content if present
  if (choice.message?.content) {
    const rawContent = choice.message.content;
    logger.debug(`${TAG} E2EE response content`, {
      contentLen: rawContent.length,
      prefix: rawContent.slice(0, 80),
      suffix: rawContent.slice(-40),
      responseId: data.id,
      model: data.model,
      finishReason: choice.finish_reason,
      hasReasoning: !!choice.message.reasoning_content,
    });
    const decrypted = decryptContent(rawContent, privateKey, algo);
    yield { type: 'text-delta', delta: decrypted };
  }

  // Tool calls are NOT encrypted — emit them as-is.
  //
  // E2EE GAP (documented, intentional): the NEAR-v2 envelope only covers
  // `message.content` / `delta.content`, which is decrypted above. Tool-call
  // function arguments are emitted by the gateway in cleartext because the
  // gateway must read/route them. For the persona-update agent these arguments
  // are model-generated structured data derived from the user's conversation
  // (e.g. persona-fact updates), so any user-derived content placed in a
  // tool-call argument is visible to the inference gateway operator and is NOT
  // protected by E2EE. Encrypting tool-call args would require a matching
  // gateway-side change and is only worth it if the gateway is treated as
  // untrusted.
  if (choice.message?.tool_calls) {
    for (const tc of choice.message.tool_calls) {
      yield {
        type: 'tool-call-delta',
        index: 0,
        id: tc.id,
        name: tc.function.name,
        argumentsDelta: tc.function.arguments,
      };
    }
  }

  const reason = choice.finish_reason === 'tool_calls' ? 'tool_calls' : 'stop';
  yield { type: 'finish', reason };
}

