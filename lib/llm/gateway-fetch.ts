// gateway-fetch — the authenticated transport under every cloud LLM call:
// JWT headers, per-attempt timeout, backoff with jitter, 401 re-mint, 429 and
// 502 handling, and the stream handle a streaming body hands to its reader.
// Imports none of cloudComplete / hedge / chat-response.

import { fetch as expoFetch } from 'expo/fetch';
import { getJwtToken, invalidateJwtCache } from '../auth-client';
import logger from '../logger';
import * as gatewayRateLimiter from './gateway-rate-limiter';
import { retryAfterMs } from '../algorithms/retry-after';
import { sleep } from '@/lib/utils/sleep';

const TAG = '[CloudLLM]';

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

/** Build auth headers, fetching a fresh JWT from the auth service. Throws if
 *  no token is available — sending an unauthenticated request just burns the
 *  401 re-mint (see authFetch) and surfaces as a confusing HTTP error
 *  downstream. Failing fast here gives the caller a clear cause. */
export async function getAuthHeaders(): Promise<Record<string, string>> {
  const token = await getJwtToken();
  if (!token) {
    throw new Error('cloudComplete: no JWT token available');
  }
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
  };
}

/** Total attempts for ANY gateway-bound call, the initial one included.
 *
 *  Was 10 RETRIES with an unjittered `BASE_DELAY_MS * 2 ** attempt`, which put
 *  a default caller on 11 requests and 511.5s of pure sleeping before it gave
 *  up — and on the 60s timeout path, ~19.5 minutes for one logical call. An
 *  outage should cost a handful of attempts, not a loop: past the third retry
 *  the gateway is down, not busy, and every extra attempt is budget spent
 *  against the user's own per-user throttle. */
export const MAX_ATTEMPTS = 4;

const BASE_DELAY_MS = 500;

/** Ceiling on the exponential term before jitter is applied. */
const MAX_BACKOFF_MS = 8_000;

/** Longest `Retry-After` we will honour. A gateway asking for more than a
 *  minute is an outage, and the caller is better served by an error it can act
 *  on than by a request held open. */
const MAX_RETRY_AFTER_MS = 60_000;

/** Backoff for a 429 that carries no usable `Retry-After`. Matches
 *  submitInferenceJob and web-search-client, which already back off by this. */
const DEFAULT_THROTTLE_BACKOFF_MS = 30_000;

/**
 * FULL JITTER (AWS "Exponential Backoff and Jitter"): a uniform pick from
 * [0, backoff), not `backoff` itself.
 *
 * The old fixed delay meant every device that saw the same outage retried in
 * the same millisecond, so the gateway got a synchronised wave per retry round
 * — the shape that keeps an overloaded service overloaded. Spreading the
 * attempts is most of the value of capping them.
 */
function backoffWithJitter(attempt: number): number {
  const ceiling = Math.min(MAX_BACKOFF_MS, BASE_DELAY_MS * 2 ** attempt);
  return Math.floor(Math.random() * ceiling);
}

/** Parse a `Retry-After` header (integer seconds) into a clamped ms value.
 *  Falls back to {@link DEFAULT_THROTTLE_BACKOFF_MS} when absent or unusable. */
export function retryAfterMsFrom(headers: Headers | undefined): number {
  return retryAfterMs(headers?.get('Retry-After'), {
    defaultMs: DEFAULT_THROTTLE_BACKOFF_MS,
    maxMs: MAX_RETRY_AFTER_MS,
  });
}

/**
 * The gateway throttled this device and the wait is too long to hold a person's
 * turn open.
 *
 * `statusCode` is a FIELD so the app's 401/HTTP-status rule in
 * `logger.captureException` reads it off the error, and so triage can tell a
 * throttle apart from an outage. NOTE: a chat caller cannot yet act on the
 * TYPE — `useCloudPersonaChat` flattens every error to a string before the UI
 * sees it — so a 429 currently reads to the user as a generic inference error.
 */
export class RateLimitedError extends Error {
  readonly statusCode = 429;
  readonly retryAfterMs: number;
  constructor(retryAfterMs: number) {
    super(`Gateway rate limited: retry after ${retryAfterMs}ms`);
    this.name = 'RateLimitedError';
    this.retryAfterMs = retryAfterMs;
    // Preserve instanceof across the TS/Babel transpile of `extends Error`.
    Object.setPrototypeOf(this, RateLimitedError.prototype);
  }
}

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
   *  {@link MAX_ATTEMPTS}, i.e. the whole attempt budget may be spent on the
   *  cold-upstream family. The chat path caps this at 2 so a persistently-cold model
   *  surfaces the gateway's 502 in bounded time instead of a multi-minute loop.
   *  401 refresh and non-502 5xx retries are unaffected. */
  maxTimeoutAttempts?: number;
  /** Which limiter lane this call belongs on. 'interactive' means a person is
   *  waiting on it (a chat turn, the prewarm, a chat tool); everything else
   *  stays on 'background', which is exactly the pacing every pre-existing
   *  caller had. */
  lane?: gatewayRateLimiter.GatewayLane;
  /** The caller already took a limiter grant for this request's FIRST attempt,
   *  so authFetch must not charge a second one. `sendHedged` sets it (it takes
   *  the primary's grant itself, to keep HEDGE_DELAY_MS anchored on the send
   *  rather than on queue entry); retries inside the loop always take their
   *  own. Mirrors submitInferenceJob's flag of the same name. */
  grantAlreadyHeld?: boolean;
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
  /** The caller's stop. Aborts EVERY leg in flight (both hedge legs), the
   *  limiter wait and the response body. A caller abort says nothing about the
   *  model: it never counts against the timeout budget and never engages the
   *  session fallback. */
  signal?: AbortSignal;
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

/**
 * The SSE stream stalled past its idle window and the reader was cancelled. The
 * cancelled body ends cleanly, so this is the only signal; it is timeout-class
 * evidence about the model exactly like an abort.
 */
export class StreamIdleError extends Error {
  constructor() {
    super('[CloudLLM] chat stream went idle');
    this.name = 'StreamIdleError';
  }
}

/**
 * The provider returned a tool call in CLEAR (`delta.tool_calls` or
 * `message.tool_calls`), outside the E2EE envelope. Nothing proves the model
 * wrote it, so the turn fails closed: never forwarded, never executed, never
 * retried and never model evidence. The message carries no call content.
 */
export class CleartextToolCallError extends Error {
  constructor() {
    super('[CloudLLM] provider returned a cleartext tool call');
    this.name = 'CleartextToolCallError';
  }
}

/** Live per-attempt resources of a response whose body is still being read. */
export interface StreamHandle {
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
  const maxTimeoutAttempts = options.maxTimeoutAttempts ?? MAX_ATTEMPTS;
  const lane = options.lane ?? 'background';
  const lastAttempt = MAX_ATTEMPTS - 1;
  let lastError: Error | null = null;
  // Counts attempts that ended in a 502 or a client timeout/network abort —
  // i.e. the "upstream is cold / unreachable" family the chat path caps.
  let timeoutAttempts = 0;
  // One re-mint, one throttle retry. Latches rather than budget: a 401 that
  // survives a fresh JWT is a dead session, and three honoured Retry-Afters
  // would hold a call open for minutes.
  let reminted = false;
  let throttleRetried = false;

  for (let attempt = 0; attempt <= lastAttempt; attempt++) {
    // The ONLY reliable discriminator between a caller abort and our own
    // per-attempt timeout: the caller's original signal. The combined signal is
    // aborted by both. Checked at the loop top so an aborted leg that is mid
    // backoff exits here (sleep() is deliberately not abort-aware — the extra
    // wait is bounded and never turns into another request).
    if (init.signal?.aborted) {
      throw new CallerAbortError('authFetch: caller aborted', lastError);
    }

    // THE GRANT, PER ATTEMPT. A retry is a request: metering only the first
    // attempt would let one logical call spend MAX_ATTEMPTS slots against a
    // one-slot budget. This single seam covers every path above it — the
    // sequential fallback retry, the hedge leg, the 401 re-mint, and both of
    // cloudChatStream's re-sends.
    //
    // The caller's own signal is passed in so an abandoned waiter (a cancelled
    // turn, a losing hedge leg) is spliced out of the queue instead of holding
    // a position ahead of background callers and burning a grant nobody uses.
    if (!(attempt === 0 && options.grantAlreadyHeld)) {
      try {
        await gatewayRateLimiter.acquire(lane, init.signal ?? undefined);
      } catch (err) {
        // The only rejection acquire() has is the caller's own abort.
        throw new CallerAbortError('authFetch: caller aborted while queued', err);
      }
    }

    // Re-check AFTER the grant wait, which can be long. A caller that went
    // away while queued must not spend a request — and must not reach
    // expoFetch with an already-aborted signal, where the abort has happened
    // before anything is listening for it.
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

      // ONE re-mint, latched. A 401 that survives a fresh JWT is a dead
      // session, and re-minting against it just multiplies the auth breaker's
      // evidence while the user waits.
      if (response.status === 401 && !reminted && attempt < lastAttempt) {
        reminted = true;
        logger.warn(`${TAG} 401 on attempt ${attempt + 1}, refreshing JWT once`);
        invalidateJwtCache();
        const freshHeaders = await getAuthHeaders();
        init = {
          ...init,
          headers: { ...init.headers as Record<string, string>, ...freshHeaders },
        };
        await sleep(backoffWithJitter(attempt));
        continue;
      }

      // 429 — the gateway is throttling THIS USER. Back the whole device off
      // either way; the lanes differ only in whether this call waits it out.
      //
      // Previously absent entirely: a 429 fell through to `return response`,
      // so chat/complete/batch neither paused the limiter nor retried, while
      // every other gateway caller in the app did pause. The user got
      // `E2EE chat failed: 429` and the device kept re-storming.
      if (response.status === 429) {
        const retryAfterMs = retryAfterMsFrom(response.headers);
        gatewayRateLimiter.pauseFor(retryAfterMs);
        const waitable =
          lane === 'background' ||
          retryAfterMs <= gatewayRateLimiter.INTERACTIVE_MAX_PAUSE_MS;
        if (!throttleRetried && waitable && attempt < lastAttempt) {
          throttleRetried = true;
          logger.warn(`${TAG} 429 on attempt ${attempt + 1}, retrying once`, {
            retryAfterMs,
            lane,
          });
          // NO sleep: the next attempt's acquire() waits out the pause we just
          // set. Sleeping here as well would serve the same backoff twice.
          continue;
        }
        // An interactive caller does not sit on a long throttle with a live
        // composer and no way out. The device is paused regardless, so the
        // user's retry lands on an already-paced limiter.
        logger.warn(`${TAG} 429 on attempt ${attempt + 1}, surfacing`, {
          retryAfterMs,
          lane,
          throttleRetried,
        });
        throw new RateLimitedError(retryAfterMs);
      }

      if (response.status === 502) {
        // 502 = the gateway couldn't get a verdict from NEAR within its own
        // UPSTREAM_TIMEOUT_MS (a cold model). Retrying against the SAME cold
        // model just storms, so this counts against the (chat-capped) timeout
        // budget; once exhausted we surface the 502 rather than loop.
        timeoutAttempts += 1;
        if (timeoutAttempts < maxTimeoutAttempts && attempt < lastAttempt) {
          logger.warn(`${TAG} 502 on attempt ${attempt + 1}, retrying`);
          await sleep(backoffWithJitter(attempt));
          continue;
        }
        logger.warn(
          `${TAG} 502 on attempt ${attempt + 1} — timeout budget exhausted (${timeoutAttempts}/${maxTimeoutAttempts}), surfacing`,
        );
        return response;
      }

      if (response.status >= 500 && attempt < lastAttempt) {
        // Non-502 5xx (500/503/504) — transient gateway/app errors, keep the
        // original sane retry budget.
        logger.warn(`${TAG} ${response.status} on attempt ${attempt + 1}, retrying`);
        await sleep(backoffWithJitter(attempt));
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
      // Our own deliberate throttle verdict, raised INSIDE the try. Without
      // this it lands in the network-error path below, which counts it against
      // the cold-upstream budget and retries — re-storming the very gateway
      // that just asked us to stop.
      if (err instanceof RateLimitedError) throw err;
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
      if (attempt < lastAttempt && timeoutAttempts < maxTimeoutAttempts) {
        logger.warn(`${TAG} fetch error on attempt ${attempt + 1}, retrying`, {
          error: lastError.message,
          timedOut: isAbort,
        });
        await sleep(backoffWithJitter(attempt));
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
