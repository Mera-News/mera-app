// cloudComplete — cloud LLM completion, batch completion, and streaming chat.
// Cloud inference is ALWAYS end-to-end encrypted: messages are encrypted
// client-side (see lib/e2ee/e2ee-service) before leaving the device, and
// responses are decrypted locally. There is no plaintext path — if E2EE
// fails, the call fails and the user sees an error.

import { departureMark, whenForeground } from '../app-restart';
import { AppState } from 'react-native';
import { assertCloudAllowed, OnDeviceModeError, type CloudPurpose } from './on-device-gate';
import {
  decryptContent,
  encryptContent,
  openField,
  type E2EEContext,
  type SigningAlgo,
} from '../e2ee/e2ee-service';
import { getCachedAttestation, invalidateCachedAttestation } from '../e2ee/e2ee-cache';
import logger from '../logger';
import { CHAT_REASONING_HEADROOM_TOKENS } from './constants';
import { stripLeakedReasoning } from '../algorithms/reasoning-leak';
import {
  APP_TOOL_FORMAT,
  assertNoCleartextToolFields,
  toTextToolMessages,
  type TextToolDefinition,
} from './text-tool-protocol';
import * as gatewayRateLimiter from './gateway-rate-limiter';
import { estimateTokens } from '../algorithms/estimate-tokens';
import type { BatchCall, ToolDefinition } from './types';
import { INFERENCE_ENDPOINT } from '@/lib/config/endpoints';
import type { PhaseSignal } from '@/lib/services/chat-phase';
import {
  AppLeftError,
  CallerAbortError,
  cancelTurn,
  CleartextToolCallError,
  EmptyReplyError,
  getAuthHeaders,
  isCallerAbort,
  newChatTurn,
  RateLimitedError,
  takeStreamHandle,
  type ChatTurn,
  type CloudCallOptions,
} from './gateway-fetch';
import type { Profile } from './profiles';
import { attestationCacheKey, prepareForProfile, sealMessages } from './provider-e2ee';
import { attemptOnProfile, chainFor, sendOnLane, sendToProfile, type Attempt, type Build, type Leg } from './routed-send';
import {
  failureClassOf,
  reportLaneExhausted,
  refreshRoutingSoon,
  LaneExhaustedError,
  reportProfileFailure,
  reportProfileSuccess,
  type FailureClass,
  type Lane,
} from './router';
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


/**
 * Below this, the interactive lane's wait is not worth a line of its own.
 *
 * Under half a second the queue phase would be gone before it could be read
 * and would only push the phase that matters back by its minimum dwell. The
 * waits this is for are the 1-3s ones behind prewarm's own interactive calls.
 */
const QUEUE_PHASE_FLOOR_MS = 400;

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
  /** Which lane's profiles serve this call. Default 'background'. */
  route?: Lane;
  maxTokens?: number;
  maxCompletionTokens?: number;
  temperature?: number;
  topP?: number;
  presencePenalty?: number;
  frequencyPenalty?: number;
  /** 'chat' only for a call made inside a chat (quick fact check, readiness ping):
   *  it then runs on device while cloud chat is on. Omitted means background. */
  purpose?: CloudPurpose;
}

/** Single E2EE completion call. Served by `request.route`'s profiles, in the router's order. */
export async function cloudComplete(
  request: CloudCompleteRequest,
  options: CloudCallOptions = {},
): Promise<string> {
  await assertCloudAllowed(request.purpose);
  const temperature = request.temperature ?? 0.3;
  // A chat-purpose call (the readiness ping, the quick check) is a chat lane: it runs while chat is in the cloud.
  const lane = request.route ?? (request.purpose === 'chat' ? 'chat-tools' : 'background');
  const maxTokens = request.maxTokens ?? request.maxCompletionTokens;

  const systemTokens = estimateTokens(request.systemPrompt);
  const promptTokens = estimateTokens(request.prompt);
  logger.debug('[CloudLLM:complete] Token estimate', {
    systemTokens,
    promptTokens,
    totalInputTokens: systemTokens + promptTokens,
    maxOutputTokens: request.maxTokens ?? request.maxCompletionTokens,
    lane,
  });

  const { build, read } = completeCall(
    { system: request.systemPrompt, prompt: request.prompt, temperature, maxTokens, enableThinking: false },
    options,
    request.purpose,
  );
  return sendOnLane(CHAT_API, lane, build, read, options);
}

/** One sealed buffered completion: the request body per profile, and how its answer is read. */
function completeCall(
  call: Pick<BatchCall, 'system' | 'prompt' | 'temperature' | 'maxTokens' | 'enableThinking'>,
  options: CloudCallOptions,
  purpose?: CloudPurpose,
): { build: Build<E2EEContext>; read: (leg: Leg<E2EEContext>) => Promise<string> } {
  const temperature = call.temperature ?? 0.3;
  const maxTokens = call.maxTokens;
  return {
    // Rebuilt per profile: sealing encrypts in place and every profile has its own key.
    build: async (profile) => {
      const messages = [
        { role: 'system', content: call.system },
        { role: 'user', content: call.prompt },
      ];
      const attemptCtx = await sealMessages(messages, profile, options.lane, purpose);
      const baseHeaders = await getAuthHeaders();
      return {
        init: {
          method: 'POST',
          headers: { ...baseHeaders, ...attemptCtx.headers },
          body: JSON.stringify({
            messages, stream: false, temperature, model: profile.model,
            chat_template_kwargs: { enable_thinking: call.enableThinking ?? false },
            // Honor the caller's output cap: lets the readiness ping ask for one
            // word instead of a full completion.
            ...(maxTokens !== undefined && { max_tokens: maxTokens }),
          }),
        } satisfies RequestInit,
        ctx: attemptCtx,
      };
    },
    // Read inside the chain, so an empty 2xx moves to the next profile too.
    read: async ({ response, ctx }) => {
      if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        // statusCode as a FIELD so retry.ts and the logger's 401 rule can see it; the
        // message text stays as it was (job-defer.ts reads it).
        throw Object.assign(new Error(`E2EE completion failed: ${response.status} ${response.statusText} — ${errorText}`), {
          statusCode: response.status,
          responseBody: errorText,
        });
      }

      // Same guard as consumeBufferedChat: an empty 2xx is EmptyReplyError, not a SyntaxError.
      const raw = await response.text();
      if (!raw.trim()) throw new EmptyReplyError();
      const data = JSON.parse(raw) as ChatCompletionResponse;
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
      return stripLeakedReasoning(openField(encContent, ctx, 'choices.0.message.content', data.id ?? '')).trim();
    },
  };
}

/** How many of a batch's items go to a sync-only profile at once. */
const PER_REQUEST_CONCURRENCY = 4;

/** An item error that ends the whole batch rather than that item: the session, a throttle, a stop, the app leaving. */
function endsTheBatch(err: unknown): boolean {
  const status = (err as { statusCode?: unknown } | null)?.statusCode;
  return status === 401 || status === 403 || err instanceof RateLimitedError || err instanceof AppLeftError || isCallerAbort(err) || err instanceof OnDeviceModeError;
}

/**
 * A batch on a profile that cannot take one (RedPill: a fresh nonce and timestamp per request):
 * each item is its own sealed sync completion, at most PER_REQUEST_CONCURRENCY at a time, results
 * in item order. A model-class failure stops it and settles as that profile's failure, as does
 * the app leaving (no RedPill request starts in the background); an item's own error stays on
 * its row, as the batch route reports it.
 */
async function batchPerRequest(
  calls: BatchCall[],
  lane: Lane,
  profile: Profile,
  options: CloudCallOptions,
): Promise<Attempt<BatchCompletionResult[]>> {
  const results: BatchCompletionResult[] = new Array(calls.length);
  let stop: Extract<Attempt<unknown>, { error: unknown }> | null = null;
  let next = 0;
  const worker = async (): Promise<void> => {
    while (!stop && next < calls.length) {
      if (AppState.currentState !== 'active') {
        stop = { error: new AppLeftError(), failure: null };
        return;
      }
      const i = next++;
      const { build, read } = completeCall(calls[i], options);
      const a = await attemptOnProfile(CHAT_API, lane, profile, build, read, options);
      if ('out' in a) results[i] = { id: calls[i].id, output: a.out };
      else if (a.failure || endsTheBatch(a.error)) stop ??= a;
      else results[i] = { id: calls[i].id, output: '', error: a.error instanceof Error ? a.error.message : String(a.error) };
    }
  };
  await Promise.all(Array.from({ length: Math.min(PER_REQUEST_CONCURRENCY, calls.length) }, worker));
  return stop ?? { out: results };
}

/** E2EE batch completion via /v1/chat/completions/batch. Shares one E2EE context across all items. */
export async function cloudBatchComplete(
  calls: BatchCall[],
  route: Lane = 'background',
  options: CloudCallOptions = {},
): Promise<BatchCompletionResult[]> {
  if (calls.length === 0) return [];
  await assertCloudAllowed();

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
      lane: route,
    });
  }
  logger.debug('[CloudLLM:batch] Token estimate total', {
    callCount: calls.length,
    totalSystemTokens,
    totalPromptTokens,
    totalInputTokens: totalSystemTokens + totalPromptTokens,
    lane: route,
  });

  return sendOnLane(
    BATCH_API,
    route,
    // Rebuilt per profile: its own E2EE context and a body encrypted under its key.
    async (profile) => {
      const attemptCtx = await prepareForProfile(profile, options.lane);

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
          model: profile.model,
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
    async ({ response, ctx }) => {
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
    },
    options,
    // One header set for many requests: only a provider that accepts that (not RedPill).
    { batch: true },
    (profile) => batchPerRequest(calls, route, profile, options),
  );
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
  /** Defaults to FALSE (owner decision 2026-10-22, every chat call). Measured:
   *  thinking off kept the single-shot pass rate on Qwen3.8 (30/32 vs 30/32) and
   *  cut article-chat turns from p50 15s to 2.4s. A caller that needs the trace
   *  passes true and gets CHAT_REASONING_HEADROOM_TOKENS on top. */
  enableThinking?: boolean;
  /** Defaults to TRUE. FALSE for a step nobody watches arrive: the answer is
   *  then ONE envelope, one decrypt, instead of one ECDH per token. Tool calls
   *  travel inside the content now, so a streamed tool step decrypts every
   *  token of its arguments, which native tool calls never cost. */
  stream?: boolean;
  tools?: ToolDefinition[];
  system?: string;
  /** Which lane's profiles serve this call. Default 'chat-tools'. */
  route?: Lane;
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
   * `sendToProfile`, neither of which can yield here.
   * In-band events would have to be buffered and flushed in a burst at the
   * exact moment they stopped being true, which is worse than no line at all.
   *
   * PER REQUEST, never a module-level emitter: prewarm, the background lane
   * and a 429 pause all drive this file, and a bus would let any of them
   * narrate a turn a person is watching.
   */
  onPhase?: (signal: PhaseSignal) => void;
  /** The caller's stop (the Stop button). Aborts the request in flight and
   *  cancels the body mid-stream; surfaces as a CallerAbortError. */
  signal?: AbortSignal;
}

/** One request's key and turn. `build` makes one per profile tried and per re-send. */
interface ChatAttempt {
  turn: ChatTurn;
  ctx: E2EEContext;
}

/** Was this failure the app leaving? An HTTP answer, a stop and a privacy
 *  refusal are verdicts that stand whether or not the reader stayed. */
function failedByLeaving(err: unknown, left: () => boolean, signal?: AbortSignal): boolean {
  return (
    left() &&
    !signal?.aborted &&
    !isCallerAbort(err) &&
    !(err instanceof CleartextToolCallError) &&
    (err as { statusCode?: unknown }).statusCode === undefined
  );
}

/** Passes `events` on, noting when any of the reply reached the caller. */
async function* noting(events: AsyncGenerator<SseEvent>, seen: { reply: boolean }): AsyncGenerator<SseEvent> {
  for await (const event of events) {
    if (event.type === 'text-delta' || event.type === 'tool-call-delta') seen.reply = true;
    yield event;
  }
}

/**
 * E2EE chat: encrypt messages, stream the response, decrypt each delta, emit
 * events. NEAR encrypts every streamed `delta.content` as its OWN self-contained
 * envelope under the same client key, so decryption is per-delta and the user
 * sees text as it is generated (verified against cloud-api.near.ai, 2026-08-03).
 * A non-SSE response (upstream ignoring `stream: true`) falls through to the
 * original buffered handling.
 *
 * THE APP LEAVING. No leg opens while away. A leg cut off by a departure is
 * read back from the gateway's turn store when the store has it (mid-stream the
 * reader does that below the parser, see chat-turn), and otherwise re-sent once.
 * A re-send after visible output emits `restart`. None of it is evidence about
 * the model. Only the leg retries: a leg's tools run after its stream has ended,
 * so no tool can run twice.
 */
export async function* cloudChatStream(
  request: CloudChatStreamRequest,
): AsyncGenerator<SseEvent> {
  logger.debug(`${TAG} cloudChatStream ENTER`, { messageCount: request.messages.length });
  // Always chat: the stream's only callers are chat turns.
  await assertCloudAllowed('chat');

  const { signal } = request;
  const stopped = () => new CallerAbortError('cloudChatStream: stopped');
  for (let resent = false; ; resent = true) {
    await whenForeground(signal);
    const attempts: ChatAttempt[] = [];
    const left = departureMark();
    // Per send: a re-send after returning is a first attempt, not a retry.
    const counter = { builds: 0 };
    const seen = { reply: false };
    let failure: unknown;
    try {
      yield* noting(playChatLeg(request, attempts, left, counter), seen);
      return;
    } catch (err) {
      if (!failedByLeaving(err, left, signal)) {
        // A stall or a stop leaves a detached turn running and paid. An HTTP
        // answer means there is none.
        if ((err as { statusCode?: unknown }).statusCode === undefined) attempts.forEach((a) => cancelTurn(a.turn));
        throw err;
      }
      failure = err;
    }

    await whenForeground(signal);
    if (signal?.aborted) {
      attempts.forEach((a) => cancelTurn(a.turn));
      throw stopped();
    }
    // Mid-stream the reader already tried the store. This is the attempt that
    // never got as far as a reader.
    const unread = seen.reply ? undefined : attempts.find((a) => a.turn.id && a.turn.bytes === 0 && !a.turn.polled);
    attempts.forEach((a) => {
      if (a !== unread) cancelTurn(a.turn);
    });
    if (unread) {
      try {
        request.onPhase?.('thinking');
        const resume = { turn: unread.turn, left, streamed: request.stream !== false };
        const textTools = (request.tools ?? []) as TextToolDefinition[];
        yield* noting(consumeChatResponse(null, unread.ctx, textTools, signal, resume), seen);
        return;
      } catch (err) {
        cancelTurn(unread.turn);
        if (signal?.aborted) throw stopped();
        logger.debug(`${TAG} no stored reply`, { error: String(err) });
      }
    }
    if (resent) throw failure;
    if (seen.reply) yield { type: 'restart' };
    logger.warn(`${TAG} the app left during a leg, sending it again`);
  }
}

/** A built chat request's context: the key that opens the reply and the attempt's turn. */
type ChatCtx = E2EEContext & { turn: ChatTurn };

/**
 * One full send of a leg, profile by profile down its lane (lib/llm/router). A model-class
 * failure before any text, at the headers or in the stream, moves to the next profile at once.
 * A failure that `left()` explains is not handled here: it goes to `cloudChatStream`.
 */
async function* playChatLeg(
  request: CloudChatStreamRequest,
  attempts: ChatAttempt[],
  left: () => boolean,
  counter: { builds: number },
): AsyncGenerator<SseEvent> {
  // ONE CALL, ONE MARK. An agent turn is a loop of up to MAX_AGENT_LEGS
  // sequential calls and each genuinely re-encrypts and re-sends, so the wait
  // line's high-water mark is bounded here rather than by the turn. This
  // clears the mark and deliberately does NOT clear the line, or every pair of
  // legs shows a blank frame between them.
  const phase = request.onPhase ?? (() => {});
  phase('reset');

  const lane = request.route ?? 'chat-tools';
  const chain = chainFor(lane);

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
    lane,
  });

  if (request.signal?.aborted) throw new CallerAbortError('cloudChatStream: stopped before send');

  logger.debug(`${TAG} cloudChatStream POST`, { url: CHAT_API });

  // Rebuilt per attempt: the deep copy must be FRESH, or the next profile would
  // re-encrypt already-encrypted content (and under the wrong key). Counts
  // entries into the builder, which is what distinguishes a first attempt from
  // the next profile and the decrypt retry. Those all re-encrypt, so without
  // this they would report `securing` again and walk the reader back to
  // "encrypting" at the moment they have been waiting longest.
  const textTools = (request.tools ?? []) as TextToolDefinition[];
  const resumeOf = (turn: ChatTurn) => ({ turn, left, streamed: request.stream !== false });

  const buildChatRequest = async (profile: Profile) => {
    // A LOCAL copy: the counter is shared by every attempt of this send.
    const attempt = ++counter.builds;
    // A cache hit makes the key fetch free, so `attesting` would be a line
    // about work that is not happening. A miss means a second interactive
    // grant 1000ms behind the one just spent, plus the attestation round
    // trip: on a cold launch this is the phase, and it is why the first
    // message of a session feels different from the tenth.
    const cold = attempt === 1 && !getCachedAttestation(attestationCacheKey(profile));
    if (attempt > 1 && !left()) phase('retrying');
    else phase(cold ? 'attesting' : 'securing');
    // NO TOOL FIELD LEAVES THE DEVICE. The schema joins the system prompt,
    // replayed calls and results become text, and all of it is encrypted with
    // the rest of the content (text-tool-protocol). Rebuilt per attempt, so the
    // next profile never re-encrypts already-encrypted content.
    const messages = toTextToolMessages(
      request.messages,
      request.tools as TextToolDefinition[] | undefined,
      request.toolChoice,
      APP_TOOL_FORMAT,
    );
    // INTERACTIVE all the way down: a cold attestation cache makes this a real
    // gateway request on the critical path of a user's turn.
    const attemptCtx = await sealMessages(messages, profile, 'interactive', 'chat');
    // The fetched key has just sealed the message: a cold first build shows
    // both steps, never only the key fetch.
    if (cold) phase('securing');

    // Dev-only timing: JWT fetch on the first-chat path (cache hit ≈ 0ms, miss
    // = real auth round-trip). getAuthHeaders' only awaited work is getJwtToken.
    const jwtStartMs = Date.now();
    const baseHeaders = await getAuthHeaders();
    logger.debug('[chat-timing] jwt fetch (chat)', { ms: Date.now() - jwtStartMs });

    // A harness that cannot think is never asked to: Qwen3.6 truncated tool turns with it on.
    const thinking = (request.enableThinking ?? false) && profile.params.thinking;
    const body: Record<string, unknown> = {
      messages,
      // Each streamed delta is its own E2EE envelope, so streaming and E2EE
      // coexist — see cloudChatStream's doc comment. A step nobody watches is
      // buffered: one envelope (see `stream` on the request).
      stream: request.stream ?? true,
      model: profile.model,
      chat_template_kwargs: { enable_thinking: thinking },
    };
    if (request.temperature !== undefined) body.temperature = request.temperature;
    // With thinking on, the trace is billed and capped inside the same
    // max_tokens as the visible answer, so the caller's budget gets headroom
    // for it (see CHAT_REASONING_HEADROOM_TOKENS). With it off there is no trace.
    if (request.maxTokens !== undefined) {
      body.max_tokens = request.maxTokens + (thinking ? CHAT_REASONING_HEADROOM_TOKENS : 0);
    }
    if (request.maxCompletionTokens !== undefined) body.max_completion_tokens = request.maxCompletionTokens;
    if (request.topP !== undefined) body.top_p = request.topP;
    if (request.n !== undefined) body.n = request.n;
    if (request.presencePenalty !== undefined) body.presence_penalty = request.presencePenalty;
    if (request.frequencyPenalty !== undefined) body.frequency_penalty = request.frequencyPenalty;
    // FAIL CLOSED: a tool field in clear is a privacy breach, never a request.
    assertNoCleartextToolFields(body);

    const turn = newChatTurn();
    attempts.push({ turn, ctx: attemptCtx });
    return {
      init: {
        method: 'POST',
        headers: { ...baseHeaders, ...attemptCtx.headers },
        body: JSON.stringify(body),
      } satisfies RequestInit,
      ctx: { ...attemptCtx, turn } as ChatCtx,
      turn,
    };
  };

  // The grant is taken inside authFetch, after the builder runs, so this is
  // the only point at which the queueing can be named. Only when the lane
  // genuinely has to wait: on a warm, idle device this is 0 and the phase is
  // skipped entirely rather than shown for its minimum dwell over nothing.
  if (gatewayRateLimiter.interactiveWaitMs() > QUEUE_PHASE_FLOOR_MS) phase('queued');
  // A BUFFERED answer's headers arrive only once the whole answer is done, so
  // the headers route below would hold the line on `securing` for the model's
  // entire think time. It says `thinking` once the request is built instead,
  // which can lead the send by up to one grant wait.
  let sendAnnounced = false;
  const buildAndAnnounce = async (profile: Profile) => {
    const built = await buildChatRequest(profile);
    if (request.stream === false && !sendAnnounced) {
      sendAnnounced = true;
      phase('thinking');
    }
    return built;
  };
  // `lane: 'interactive'` is hardcoded, not a caller option: cloudChatStream
  // is the only user-facing streaming path in the app.
  const sendOptions: CloudCallOptions = { streamBody: true, lane: 'interactive', signal: request.signal };

  // The head's failure is what surfaces when every profile failed: a later one must not mask it.
  let first: { leg?: Leg<ChatCtx>; error?: unknown } | null = null;
  let last: { profile: Profile; failure: FailureClass } | null = null;
  // One fresh send on the SAME profile, once per leg, for a stream that died before any text in a
  // way that says nothing about the model (a dropped connection, a corrupt chunk).
  let resentSame = false;
  // `thinking` once per leg: a resend after it ranks below `retrying` and could not render anyway.
  let thought = false;
  for (let i = 0; i < chain.length; i++) {
    const profile = chain[i];
    // Dev-only timing: per-request POST→response wall time.
    const postStartMs = Date.now();
    let leg: Leg<ChatCtx>;
    try {
      const sent = await sendToProfile(CHAT_API, lane, profile, buildAndAnnounce, sendOptions);
      leg = sent.leg;
      if (sent.failure && !left()) {
        chatHttpBreadcrumb('cloudChatStream HTTP error (next profile)', leg, '');
        reportProfileFailure(profile, lane, sent.failure);
        first ??= { leg };
        last = { profile, failure: sent.failure };
        continue;
      }
    } catch (err) {
      const failure = left() ? null : failureClassOf(err);
      if (!failure) throw err;
      reportProfileFailure(profile, lane, failure);
      first ??= { error: err };
      last = { profile, failure };
      logger.warn(`${TAG} model failure before the reply, next profile`, { profile: profile.id, failure });
      continue;
    }
    // An earlier profile's detached turn keeps running upstream: nobody will read it.
    attempts.forEach((a) => {
      if (a.turn !== leg.ctx.turn) cancelTurn(a.turn);
    });
    logger.debug('[chat-timing] chat POST→response', {
      ms: Date.now() - postStartMs,
      status: leg.response.status,
    });

    if (!leg.response.ok) {
      yield* failedChatResponse(leg);
      return;
    }

    // Headers are in and nothing visible has arrived: this is model
    // time-to-first-token, 3-8s median and the single longest phase of the wait.
    // It MUST fire here and not only on the `reasoning` event, because the
    // persona loop sends `enable_thinking: false` on every leg and so emits no
    // reasoning at all. Gating on that event froze the line on "encrypted" for
    // the whole window, which is the failure this line exists to remove.
    // A buffered request already said it when it was sent.
    if (request.stream !== false && !thought) phase('thinking');
    thought = true;

    let textYielded = false;
    try {
      for await (const event of consumeChatResponse(leg.response, leg.ctx, textTools, request.signal, resumeOf(leg.ctx.turn))) {
        if (event.type === 'text-delta') textYielded = true;
        yield event;
      }
      reportProfileSuccess(profile, lane);
      return;
    } catch (err) {
      // A stop is final: no retry, no model verdict.
      if (isCallerAbort(err) || request.signal?.aborted) throw err;
      // A cleartext tool call is a privacy failure, not model evidence: no retry.
      if (err instanceof CleartextToolCallError) throw err;
      // The app left: an overdue timer proves nothing, and the caller recovers.
      if (left()) throw err;
      // Text already reached the user: surface the error so the existing
      // failed-turn UX finalizes. Re-sending a half-answered prompt would
      // duplicate the answer.
      if (textYielded) throw err;
      // An idle stall, a cancelled body or an empty 2xx is model evidence; a decrypt failure is not.
      const failure = failureClassOf(err);
      cancelTurn(leg.ctx.turn);
      if (!failure) {
        if (resentSame) throw err;
        resentSame = true;
        logger.warn(`${TAG} stream died before any text — one fresh attempt`, { profile: profile.id, error: String(err) });
        i -= 1;
        continue;
      }
      reportProfileFailure(profile, lane, failure);
      first ??= { error: err };
      last = { profile, failure };
      logger.warn(`${TAG} stream died before any text, next profile`, { profile: profile.id, failure });
    }
  }

  if (!first || !last) {
    // The table left nothing to try: no call was made.
    refreshRoutingSoon();
    reportLaneExhausted(lane, null, 'model_unavailable');
    throw new LaneExhaustedError(lane);
  }
  reportLaneExhausted(lane, last.profile, last.failure);
  if (first.leg) {
    yield* failedChatResponse(first!.leg);
    return;
  }
  throw first.error;

  /** The diagnostics of a failed answer. `algo` and the model-key prefix are here because
   *  MERA-APP-72 could not be root-caused without them; the key is public data and only its
   *  first 8 hex chars are kept. */
  function chatHttpBreadcrumb(message: string, l: Leg<ChatCtx>, errorText: string): void {
    logger.addBreadcrumb(
      `${TAG} ${message}`,
      'cloud-chat',
      {
        status: l.response.status,
        errorText,
        model: l.profile.model,
        profile: l.profile.id,
        algo: l.ctx.algo,
        modelKeyFp: l.ctx.modelPubKeyHex?.slice(0, 8),
      },
      'error',
    );
  }

  /** A non-2xx answer the router does not move on from: one re-attest on a decrypt failure, else the error. */
  async function* failedChatResponse(l: Leg<ChatCtx>): AsyncGenerator<SseEvent> {
    takeStreamHandle(l.response)?.release();
    const errorText = await l.response.text().catch(() => '');
    // BREADCRUMB, not a capture. This throw is always caught and reported by
    // useCloudPersonaChat's `sendMessage failed` handler, so a capture here
    // filed the SAME failure a second time under a different title — one HTTP
    // error became MERA-APP-72 and MERA-APP-73, same trace, same three events.
    chatHttpBreadcrumb('cloudChatStream HTTP error', l, errorText);

    // The provider could not decrypt the envelope built from the key it had
    // just attested. Re-attesting is the only client-side lever, and it is worth
    // exactly ONE attempt on the same profile: `buildChatRequest` mints a fresh
    // client keypair and a fresh model key, which re-rolls the serving node and
    // possibly the algo family too. NOT a model failure.
    // One latch with the stream-death resend: a leg is at most two sends on one profile.
    if (!resentSame && l.response.status === 400 && DECRYPT_FAILURE_RE.test(errorText)) {
      resentSame = true;
      invalidateCachedAttestation(attestationCacheKey(l.profile));
      logger.warn(`${TAG} upstream could not decrypt — re-attesting once`, {
        model: l.profile.model,
        algo: l.ctx.algo,
      });
      const { leg: fresh } = await sendToProfile(CHAT_API, lane, l.profile, buildChatRequest, sendOptions);
      if (fresh.response.ok) {
        yield* consumeChatResponse(fresh.response, fresh.ctx, textTools, request.signal, resumeOf(fresh.ctx.turn));
        return;
      }
      takeStreamHandle(fresh.response)?.release();
      const freshErrorText = await fresh.response.text().catch(() => '');
      chatHttpBreadcrumb('cloudChatStream HTTP error (after re-attest)', fresh, freshErrorText);
      throw Object.assign(new Error(`E2EE chat failed: ${fresh.response.status}`), {
        statusCode: fresh.response.status,
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
    throw Object.assign(new Error(`E2EE chat failed: ${l.response.status}`), {
      statusCode: l.response.status,
      responseBody: errorText,
    });
  }
}
