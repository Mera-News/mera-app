// cloudComplete — cloud LLM completion, batch completion, and streaming chat.
// Cloud inference is ALWAYS end-to-end encrypted: messages are encrypted
// client-side (see lib/e2ee/e2ee-service) before leaving the device, and
// responses are decrypted locally. There is no plaintext path — if E2EE
// fails, the call fails and the user sees an error.

import { assertCloudAllowed } from './on-device-gate';
import {
  decryptContent,
  encryptContent,
  encryptMessages,
  prepareE2EEContext,
  type SigningAlgo,
} from '../e2ee/e2ee-service';
import { getCachedAttestation, invalidateCachedAttestation } from '../e2ee/e2ee-cache';
import logger from '../logger';
import { CHAT_REASONING_HEADROOM_TOKENS, SMALL_MODEL } from './constants';
import { stripLeakedReasoning } from '../algorithms/reasoning-leak';
import {
  APP_TOOL_FORMAT,
  assertNoCleartextToolFields,
  toTextToolMessages,
  type TextToolDefinition,
} from './text-tool-protocol';
import { reportModelFailure, resolveModel } from './model-fallback';
import * as gatewayRateLimiter from './gateway-rate-limiter';
import { estimateTokens } from '../algorithms/estimate-tokens';
import type { BatchCall, ToolDefinition } from './types';
import { INFERENCE_ENDPOINT } from '@/lib/config/endpoints';
import type { PhaseSignal } from '@/lib/services/chat-phase';
import {
  authFetch,
  CallerAbortError,
  CleartextToolCallError,
  getAuthHeaders,
  isAbortLike,
  isCallerAbort,
  StreamIdleError,
  takeStreamHandle,
  type CloudCallOptions,
} from './gateway-fetch';
import { sendWithModelFallback, withUpstreamAlignedDefaults } from './hedge';
import {
  consumeChatResponse,
  type ChatCompletionResponse,
  type SseEvent,
} from './chat-response';

// Everything that moved out is re-exported, so this module's export list is unchanged.
export {
  authFetch,
  CallerAbortError,
  CleartextToolCallError,
  isAbortLike,
  isCallerAbort,
  MAX_ATTEMPTS,
  RateLimitedError,
  retryAfterMsFrom,
  StreamIdleError,
  takeStreamHandle,
  UPSTREAM_ALIGNED_TIMEOUT_MS,
  type AuthFetchOptions,
  type CloudCallOptions,
} from './gateway-fetch';
export { UPSTREAM_ALIGNED_MAX_TIMEOUT_ATTEMPTS } from './hedge';
export { STREAM_IDLE_TIMEOUT_MS, type SseEvent } from './chat-response';

const TAG = '[CloudLLM]';

const CHAT_API = `${INFERENCE_ENDPOINT}/v1/chat/completions`;
const BATCH_API = `${INFERENCE_ENDPOINT}/v1/chat/completions/batch`;

/** NEAR's own verdict when the serving TEE cannot open our request envelope,
 *  surfaced as `400 {"error":{"message":"Provider failed for model '<id>':
 *  Decryption failed"}}`. The text is UPSTREAM's, not the gateway's — the
 *  gateway is a pure proxy and this string appears nowhere in it — so matching
 *  on it is matching on NEAR's contract. Kept loose (case-insensitive, no model
 *  id) because only the failure mode is load-bearing. */
const DECRYPT_FAILURE_RE = /decryption failed/i;


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
/**
 * Below this, the interactive lane's wait is not worth a line of its own.
 *
 * Under half a second the queue phase would be gone before it could be read
 * and would only push the phase that matters back by its minimum dwell. The
 * waits this is for are the 1-3s ones behind prewarm's own interactive calls.
 */
const QUEUE_PHASE_FLOOR_MS = 400;

export const HEDGE_DELAY_MS = 10_000;

/** The hedge for a BUFFERED call (`stream: false`). Its headers arrive only
 *  when the whole answer is done, so 10s of "silence" is an ordinary tool leg
 *  (corpus p95 ~2.3s, max ~35s), not a stall: hedging there would bill twice
 *  and could engage the session fallback on a healthy primary. */
export const BUFFERED_HEDGE_DELAY_MS = 30_000;

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

/** Single E2EE completion call (used for scoring). */
export async function cloudComplete(
  request: CloudCompleteRequest,
  options: CloudCallOptions = {},
): Promise<string> {
  await assertCloudAllowed();
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
      const attemptCtx = await encryptMessages(messages, sendModel, options.lane);
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
    // statusCode as a FIELD so retry.ts and the logger's 401 rule can see it; the
    // message text stays as it was (job-defer.ts reads it).
    throw Object.assign(new Error(`E2EE completion failed: ${response.status} ${response.statusText} — ${errorText}`), {
      statusCode: response.status,
      responseBody: errorText,
    });
  }

  const data = await response.json() as ChatCompletionResponse;
  const msg = data.choices?.[0]?.message;
  // Fail loud, like the batch path: a trace that exhausts max_tokens leaves
  // `content` empty, and handing `reasoning_content` back as the answer made
  // callers parse prose as JSON.
  if (!msg?.content && msg?.reasoning_content) {
    logger.warn(`${TAG} completion returned only a reasoning trace`, {
      finishReason: data.choices?.[0]?.finish_reason,
      reasoningLength: msg.reasoning_content.length,
      maxTokensRequested: maxTokens,
    });
    throw new Error(`${TAG} reasoning-overran-budget`);
  }
  const encContent = msg?.content || '';
  if (!encContent) return '';

  // Thinking is OFF here, and on GLM that can leak the trace INTO content as
  // `trace</think>answer` (lib/algorithms/reasoning-leak). Strip before the caller
  // parses it as JSON or shows it as prose.
  return stripLeakedReasoning(decryptContent(encContent, ctx.privateKey, ctx.algo)).trim();
}

/** E2EE batch completion via /v1/chat/completions/batch. Shares E2EE context across all items. */
export async function cloudBatchComplete(
  calls: BatchCall[],
  model?: string,
  options: CloudCallOptions = {},
): Promise<BatchCompletionResult[]> {
  if (calls.length === 0) return [];
  await assertCloudAllowed();
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
      const attemptCtx = await prepareE2EEContext(sendModel, options.lane);

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
          // Honour the per-call flag, mirroring the async path
          // (submitInferenceJob.ts). DEFAULT FALSE: every existing batch caller
          // (relevance scoring, reason generation, noise generation) passes no
          // `enableThinking` and therefore keeps exactly the behaviour it had
          // when this was hardcoded. Only callers that opt in change.
          chat_template_kwargs: { enable_thinking: call.enableThinking ?? false },
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
    // statusCode as a FIELD so retry.ts and the logger's 401 rule can see it; the
    // message text stays as it was (job-defer.ts reads it).
    throw Object.assign(new Error(`E2EE batch failed: ${response.status} ${response.statusText} — ${errorText}`), {
      statusCode: response.status,
      responseBody: errorText,
    });
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

    // Fail loud instead of substituting the reasoning trace for the answer.
    // With thinking enabled, a trace that exhausts max_tokens leaves `content`
    // empty — and the `||` below used to hand `reasoning_content` back AS the
    // output. Callers then failed to parse prose as JSON and reported a benign
    // "no usable result", hiding a pure budget problem. Surfacing an error
    // instead makes it retryable and countable (topic generation already routes
    // result.error into topicGenError, so the UI settles on a retryable state).
    if (!msg?.content && msg?.reasoning_content) {
      logger.warn(`${TAG} batch item returned only a reasoning trace`, {
        id: call.id,
        finishReason: choice?.finish_reason,
        reasoningLength: msg.reasoning_content.length,
        maxTokensRequested: call.maxTokens,
      });
      return {
        id: call.id,
        output: '',
        error: 'reasoning-overran-budget',
      };
    }

    const encContent = msg?.content || '';
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
      // Same thinking-off leak guard as cloudComplete — see lib/algorithms/reasoning-leak.
      const output = stripLeakedReasoning(decryptContent(encContent, privateKey, algo)).trim();
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
  /** Defaults to TRUE, which is what every pre-existing caller gets. The agent
   *  loop passes false: measured, the trace buys nothing on a tool-routing leg
   *  and costs the whole budget on the topic path. */
  enableThinking?: boolean;
  /** Defaults to TRUE. FALSE for a step nobody watches arrive: the answer is
   *  then ONE envelope, one decrypt, instead of one ECDH per token. Tool calls
   *  travel inside the content now, so a streamed tool step decrypts every
   *  token of its arguments, which native tool calls never cost. */
  stream?: boolean;
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
  /**
   * Progress for the chat wait line. Optional, so every existing caller is
   * byte-identical and `prewarm` stays silent by simply not passing it.
   *
   * NOT AN `SseEvent`, AND IT CANNOT BE ONE. Every phase worth naming happens
   * before this generator's first yield, inside `buildChatRequest` ->
   * `sendWithModelFallback` -> `sendHedged`, none of which can yield here.
   * In-band events would have to be buffered and flushed in a burst at the
   * exact moment they stopped being true, which is worse than no line at all.
   *
   * PER REQUEST, never a module-level emitter: prewarm, the background lane
   * and a 429 pause all drive this file, and a bus would let any of them
   * narrate a turn a person is watching.
   */
  onPhase?: (signal: PhaseSignal) => void;
  /** The caller's stop (the Stop button). Aborts the request on both hedge
   *  legs and cancels the body mid-stream; surfaces as a CallerAbortError. */
  signal?: AbortSignal;
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
  await assertCloudAllowed();

  // ONE CALL, ONE MARK. An agent turn is a loop of up to MAX_AGENT_LEGS
  // sequential calls and each genuinely re-encrypts and re-sends, so the wait
  // line's high-water mark is bounded here rather than by the turn. This
  // clears the mark and deliberately does NOT clear the line, or every pair of
  // legs shows a blank frame between them.
  const phase = request.onPhase ?? (() => {});
  phase('reset');

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

  if (request.signal?.aborted) throw new CallerAbortError('cloudChatStream: stopped before send');

  logger.debug(`${TAG} cloudChatStream POST`, { url: CHAT_API });

  // Rebuilt per attempt/leg: the deep copy must be FRESH, or a fallback retry
  // would re-encrypt already-encrypted content (and under the wrong key).
  // Counts entries into the builder, which is what distinguishes a first
  // attempt from the 10s hedge leg, the model fallback and both stream
  // retries. Those all re-encrypt, so without this they would report
  // `securing` again and walk the reader back to "encrypting" at the moment
  // they have been waiting longest.
  let buildAttempts = 0;
  const textTools = (request.tools ?? []) as TextToolDefinition[];

  const buildChatRequest = async (sendModel: string) => {
    buildAttempts += 1;
    if (buildAttempts > 1) {
      phase('retrying');
    } else {
      // A cache hit makes the key fetch free, so `attesting` would be a line
      // about work that is not happening. A miss means a second interactive
      // grant 1000ms behind the one just spent, plus the attestation round
      // trip: on a cold launch this is the phase, and it is why the first
      // message of a session feels different from the tenth.
      phase(getCachedAttestation(sendModel) ? 'securing' : 'attesting');
    }
    // NO TOOL FIELD LEAVES THE DEVICE. The schema joins the system prompt,
    // replayed calls and results become text, and all of it is encrypted with
    // the rest of the content (text-tool-protocol). Rebuilt per attempt, so a
    // fallback retry never re-encrypts already-encrypted content.
    const messages = toTextToolMessages(
      request.messages,
      request.tools as TextToolDefinition[] | undefined,
      request.toolChoice,
      APP_TOOL_FORMAT,
    );
    // INTERACTIVE all the way down: a cold attestation cache makes this a real
    // gateway request on the critical path of a user's turn.
    const attemptCtx = await encryptMessages(messages, sendModel, 'interactive');

    // Dev-only timing: JWT fetch on the first-chat path (cache hit ≈ 0ms, miss
    // = real auth round-trip). getAuthHeaders' only awaited work is getJwtToken.
    const jwtStartMs = Date.now();
    const baseHeaders = await getAuthHeaders();
    logger.debug('[chat-timing] jwt fetch (chat)', { ms: Date.now() - jwtStartMs });

    const body: Record<string, unknown> = {
      messages,
      // Each streamed delta is its own E2EE envelope, so streaming and E2EE
      // coexist — see cloudChatStream's doc comment. A step nobody watches is
      // buffered: one envelope (see `stream` on the request).
      stream: request.stream ?? true,
      model: sendModel,
      chat_template_kwargs: { enable_thinking: request.enableThinking ?? true },
    };
    if (request.temperature !== undefined) body.temperature = request.temperature;
    // Thinking is ON above, and on a reasoning model the trace is billed and
    // capped inside the same max_tokens as the visible answer. The caller's
    // budget is for the answer; the headroom is for the trace — see
    // CHAT_REASONING_HEADROOM_TOKENS for the measurement behind the number.
    if (request.maxTokens !== undefined) {
      body.max_tokens = request.maxTokens + CHAT_REASONING_HEADROOM_TOKENS;
    }
    if (request.maxCompletionTokens !== undefined) body.max_completion_tokens = request.maxCompletionTokens;
    if (request.topP !== undefined) body.top_p = request.topP;
    if (request.n !== undefined) body.n = request.n;
    if (request.presencePenalty !== undefined) body.presence_penalty = request.presencePenalty;
    if (request.frequencyPenalty !== undefined) body.frequency_penalty = request.frequencyPenalty;
    // FAIL CLOSED: a tool field in clear is a privacy breach, never a request.
    assertNoCleartextToolFields(body);

    return {
      init: {
        method: 'POST',
        headers: { ...baseHeaders, ...attemptCtx.headers },
        body: JSON.stringify(body),
        ...(request.signal ? { signal: request.signal } : {}),
      } satisfies RequestInit,
      ctx: attemptCtx,
    };
  };

  // Dev-only timing: per-request POST→response wall time. Tagged for first-chat
  // latency attribution.
  const postStartMs = Date.now();
  // The grant is taken inside `sendHedged`, before the builder runs, so this
  // is the only point at which the queueing can be named. Only when the lane
  // genuinely has to wait: on a warm, idle device this is 0 and the phase is
  // skipped entirely rather than shown for its minimum dwell over nothing.
  if (gatewayRateLimiter.interactiveWaitMs() > QUEUE_PHASE_FLOOR_MS) phase('queued');
  const { response, ctx, model: sentModel } = await sendWithModelFallback(
    CHAT_API,
    primary,
    buildChatRequest,
    // Chat has always used the gateway-aligned budget; every other cloud call
    // now shares it (plan A). Chat is the only user-facing path, so it is also
    // the only one that hedges and the only one that streams its body.
    // `lane: 'interactive'` is hardcoded, not a caller option: cloudChatStream
    // is the only user-facing streaming path in the app.
    withUpstreamAlignedDefaults({
      hedgeAfterMs: request.stream === false ? BUFFERED_HEDGE_DELAY_MS : HEDGE_DELAY_MS,
      streamBody: true,
      lane: 'interactive',
      signal: request.signal,
    }),
  );
  logger.debug('[chat-timing] chat POST→response', {
    ms: Date.now() - postStartMs,
    status: response.status,
  });

  // ONE shared latch for BOTH of this generator's retry paths — the
  // decrypt-failure retry below and the stream-died-before-any-text retry at the
  // end. Each is independently bounded, but they sit on the same call path: a
  // decrypt retry that reconnects and then dies mid-stream would otherwise fall
  // into the second retry and issue a THIRD request. One latch, set by whichever
  // fires first, keeps the worst case at two.
  let retried = false;

  if (!response.ok) {
    takeStreamHandle(response)?.release();
    const errorText = await response.text().catch(() => '');
    // BREADCRUMB, not a capture. This throw is always caught and reported by
    // useCloudPersonaChat's `sendMessage failed` handler, so a capture here
    // filed the SAME failure a second time under a different title — one HTTP
    // error became MERA-APP-72 and MERA-APP-73, same trace, same three events.
    // The diagnostics ride along on the breadcrumb, so the surviving event
    // still carries the status and body.
    //
    // `algo` and the model-key prefix are here because MERA-APP-72 could not be
    // root-caused without them: a "Decryption failed" event carried no record of
    // which curve built the envelope, and the two candidate causes (a wrong
    // ecdsa wire format vs. a node/key mismatch at NEAR) point at different
    // repos. The model key is public data and only its first 8 hex chars are
    // kept — enough to tell two keys apart, not a secret.
    logger.addBreadcrumb(
      `${TAG} cloudChatStream HTTP error`,
      'cloud-chat',
      {
        status: response.status,
        errorText,
        model: sentModel,
        algo: ctx.algo,
        modelKeyFp: ctx.modelPubKeyHex?.slice(0, 8),
      },
      'error',
    );

    // NEAR could not decrypt the envelope built from the key NEAR itself had
    // just attested. Re-attesting is the only client-side lever, and it is worth
    // exactly ONE attempt: `buildChatRequest` mints a fresh client keypair and a
    // fresh model key, which re-rolls the serving node and (since the fleet
    // load-balances curves) possibly the algo family too.
    //
    // NOT a model failure: invariant — "4xx, auth, E2EE/decrypt and plain
    // network errors say nothing about the model" — so this never calls
    // reportModelFailure and never engages the session fallback.
    //
    // authFetch directly, NEVER sendWithModelFallback: chat passes
    // `hedgeAfterMs`, so re-entering that helper would re-enter sendHedged and
    // turn "one more request" into two plus a possible fallback engagement on a
    // 4xx.
    if (!retried && response.status === 400 && DECRYPT_FAILURE_RE.test(errorText)) {
      retried = true;
      invalidateCachedAttestation(sentModel);
      logger.warn(`${TAG} upstream could not decrypt — re-attesting once`, {
        model: sentModel,
        algo: ctx.algo,
      });
      const fresh = await buildChatRequest(sentModel);
      const freshResponse = await authFetch(CHAT_API, fresh.init, {
        ...withUpstreamAlignedDefaults({ streamBody: true, lane: 'interactive' }),
        maxTimeoutAttempts: 1,
      });
      if (freshResponse.ok) {
        yield* consumeChatResponse(freshResponse, fresh.ctx.privateKey, fresh.ctx.algo, textTools, request.signal);
        return;
      }
      takeStreamHandle(freshResponse)?.release();
      const freshErrorText = await freshResponse.text().catch(() => '');
      logger.addBreadcrumb(
        `${TAG} cloudChatStream HTTP error (after re-attest)`,
        'cloud-chat',
        {
          status: freshResponse.status,
          errorText: freshErrorText,
          model: sentModel,
          algo: fresh.ctx.algo,
          modelKeyFp: fresh.ctx.modelPubKeyHex?.slice(0, 8),
        },
        'error',
      );
      throw Object.assign(new Error(`E2EE chat failed: ${freshResponse.status}`), {
        statusCode: freshResponse.status,
        responseBody: freshErrorText,
      });
    }

    // statusCode as a FIELD so the 401 rule in logger.captureException can see
    // it — a chat call made on a dead session is the auth breaker's story, not
    // its own issue.
    //
    // The body is deliberately NOT interpolated into the message. This string
    // reaches the user: useCloudPersonaChat wraps it and ChatSessionView used to
    // render it verbatim, so a provider's raw JSON was shown on screen, in
    // English, to users in every locale (MERA-APP-72). It rides on
    // `responseBody` and on the breadcrumb above instead, where triage still has
    // it. The `E2EE chat failed: <status>` prefix is preserved verbatim — the
    // existing specs match on it.
    throw Object.assign(new Error(`E2EE chat failed: ${response.status}`), {
      statusCode: response.status,
      responseBody: errorText,
    });
  }

  // Headers are in and nothing visible has arrived: this is model
  // time-to-first-token, 3-8s median and the single longest phase of the wait.
  // It MUST fire here and not only on the `reasoning` event, because the
  // persona loop sends `enable_thinking: false` on every leg and so emits no
  // reasoning at all. Gating on that event froze the line on "encrypted" for
  // the whole window, which is the failure this line exists to remove.
  phase('thinking');

  let textYielded = false;
  try {
    for await (const event of consumeChatResponse(response, ctx.privateKey, ctx.algo, textTools, request.signal)) {
      if (event.type === 'text-delta') textYielded = true;
      yield event;
    }
    return;
  } catch (err) {
    // Text already reached the user: surface the error so the existing
    // failed-turn UX finalizes. Silently re-sending a half-answered prompt
    // would duplicate the answer.
    // A stop is final: no retry, no model verdict.
    if (isCallerAbort(err) || request.signal?.aborted) throw err;
    // A cleartext tool call is a privacy failure, not model evidence: no retry.
    if (err instanceof CleartextToolCallError) throw err;
    if (textYielded) throw err;
    // Already on the fallback (session-engaged, or a hedge winner) — there is
    // no healthier model left to try.
    if (sentModel !== primary) throw err;
    // Only an abort-class death (idle stall, cancelled body) is model-evidence.
    // A decrypt failure is NOT: model-fallback.ts is explicit that "4xx, auth,
    // E2EE/decrypt and plain network errors say nothing about the model".
    if ((isAbortLike(err) || err instanceof StreamIdleError) && !isCallerAbort(err)) reportModelFailure(primary);
    // The decrypt-failure path above already spent this generator's one retry.
    // Without this check a re-attested request that then died mid-stream would
    // issue a THIRD upstream call for a single user turn.
    if (retried) throw err;
    logger.warn(`${TAG} stream died before any text — one fresh attempt`, {
      failedModel: sentModel,
      error: String(err),
    });
  }

  // ONE fresh request, on whatever the primary now resolves to. Bounded by
  // construction: this branch is only reachable with zero text yielded, with the
  // shared `retried` latch unset, and it never recurses.
  retried = true;
  const retryModel = resolveModel(primary);
  const retry = await buildChatRequest(retryModel);
  const retryResponse = await authFetch(CHAT_API, retry.init, {
    ...withUpstreamAlignedDefaults({ streamBody: true, lane: 'interactive' }),
    maxTimeoutAttempts: 1,
  });
  if (!retryResponse.ok) {
    takeStreamHandle(retryResponse)?.release();
    const errorText = await retryResponse.text().catch(() => '');
    // Same reasoning as the first throw: the body rides on a field and a
    // breadcrumb, never in the message that reaches the user's screen.
    logger.addBreadcrumb(
      `${TAG} cloudChatStream HTTP error (after stream-death retry)`,
      'cloud-chat',
      {
        status: retryResponse.status,
        errorText,
        model: retryModel,
        algo: retry.ctx.algo,
        modelKeyFp: retry.ctx.modelPubKeyHex?.slice(0, 8),
      },
      'error',
    );
    throw Object.assign(new Error(`E2EE chat failed: ${retryResponse.status}`), {
      statusCode: retryResponse.status,
      responseBody: errorText,
    });
  }
  yield* consumeChatResponse(retryResponse, retry.ctx.privateKey, retry.ctx.algo, textTools, request.signal);
}
