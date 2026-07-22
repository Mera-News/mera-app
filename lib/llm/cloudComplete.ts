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
import { estimateTokens } from './tokens';
import type { BatchCall, ToolDefinition } from './types';
import { INFERENCE_ENDPOINT } from '@/lib/config/endpoints';

const TAG = '[CloudLLM]';

const CHAT_API = `${INFERENCE_ENDPOINT}/v1/chat/completions`;
const BATCH_API = `${INFERENCE_ENDPOINT}/v1/chat/completions/batch`;

/** Chat per-attempt timeout — must exceed the gateway's UPSTREAM_TIMEOUT_MS
 *  (120s) so the gateway's own 200/502 verdict lands before the client aborts.
 *  130s = 120s gateway + 10s slack. */
const CHAT_REQUEST_TIMEOUT_MS = 130_000;

/** Chat 502/timeout attempt cap. A cold NEAR model can exceed even 120s, and
 *  retrying the SAME cold model storms; cap at 2 total attempts so a persistent
 *  cold model surfaces the gateway 502 in bounded time. The model is warmed
 *  ahead of the first turn by prewarmCloudChat() (lib/llm/prewarm). */
const CHAT_MAX_TIMEOUT_ATTEMPTS = 2;

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
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), requestTimeoutMs);

    try {
      const response = await (expoFetch as unknown as typeof globalThis.fetch)(url, {
        ...init,
        signal: init.signal ?? controller.signal,
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

      return response;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      const isAbort =
        lastError.name === 'AbortError' ||
        lastError.message.toLowerCase().includes('abort');
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
      clearTimeout(timeoutId);
    }
  }

  throw lastError ?? new Error('authFetch failed after retries');
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
export async function cloudComplete(request: CloudCompleteRequest): Promise<string> {
  const messages = [
    { role: 'system', content: request.systemPrompt },
    { role: 'user', content: request.prompt },
  ];
  const temperature = request.temperature ?? 0.3;
  const model = request.model ?? SMALL_MODEL;

  const systemTokens = estimateTokens(request.systemPrompt);
  const promptTokens = estimateTokens(request.prompt);
  logger.debug('[CloudLLM:complete] Token estimate', {
    systemTokens,
    promptTokens,
    totalInputTokens: systemTokens + promptTokens,
    maxOutputTokens: request.maxTokens ?? request.maxCompletionTokens,
    model,
  });

  const ctx = await encryptMessages(messages, model);

  const baseHeaders = await getAuthHeaders();
  const allHeaders = { ...baseHeaders, ...ctx.headers };
  const maxTokens = request.maxTokens ?? request.maxCompletionTokens;
  const response = await authFetch(CHAT_API, {
    method: 'POST',
    headers: allHeaders,
    body: JSON.stringify({
      messages, stream: false, temperature, model,
      chat_template_kwargs: { enable_thinking: false },
      // Honor the caller's output cap — lets the prewarm warmup request a single
      // throwaway token instead of a full completion.
      ...(maxTokens !== undefined && { max_tokens: maxTokens }),
    }),
  });

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
): Promise<BatchCompletionResult[]> {
  if (calls.length === 0) return [];
  const resolvedModel = model ?? SMALL_MODEL;

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

  const ctx = await prepareE2EEContext(resolvedModel);

  const requests = calls.map((call) => {
    const messages = [
      { role: 'system', content: call.system },
      { role: 'user', content: call.prompt },
    ];
    for (const msg of messages) {
      if (msg.content.length > 0) {
        msg.content = encryptContent(msg.content, ctx);
      }
    }
    return {
      messages,
      stream: false,
      temperature: call.temperature ?? 0.3,
      model: resolvedModel,
      chat_template_kwargs: { enable_thinking: false },
      ...(call.maxTokens !== undefined && { max_tokens: call.maxTokens }),
    };
  });

  const baseHeaders = await getAuthHeaders();
  const allHeaders = { ...baseHeaders, ...ctx.headers };

  const response = await authFetch(BATCH_API, {
    method: 'POST',
    headers: allHeaders,
    body: JSON.stringify({ requests }),
  });

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

/** E2EE chat: encrypt messages, send non-streaming, decrypt, emit synthetic events. */
export async function* cloudChatStream(
  request: CloudChatStreamRequest,
): AsyncGenerator<SseEvent> {
  logger.debug(`${TAG} cloudChatStream ENTER`, { messageCount: request.messages.length });

  // Deep-copy messages so encryption doesn't mutate the caller's array
  const messages = request.messages.map((m) => ({ ...m }));
  const model = request.model ?? SMALL_MODEL;

  // Token estimate — parallel to useLocalLLM's [LocalLLM:chat] Token estimate log.
  let totalInputTokens = 0;
  for (const m of messages) {
    const content = typeof m.content === 'string' ? m.content : '';
    totalInputTokens += estimateTokens(content);
  }
  logger.debug('[CloudLLM:chat] Token estimate', {
    messageCount: messages.length,
    totalInputTokens,
    toolCount: request.tools?.length ?? 0,
    maxOutputTokens: request.maxTokens ?? request.maxCompletionTokens,
    model,
  });
  const ctx = await encryptMessages(
    messages as { role: string; content: string;[k: string]: unknown }[],
    model,
  );

  // Dev-only timing: JWT fetch on the first-chat path (cache hit ≈ 0ms, miss =
  // real auth round-trip). getAuthHeaders' only awaited work is getJwtToken.
  const jwtStartMs = Date.now();
  const baseHeaders = await getAuthHeaders();
  logger.debug('[chat-timing] jwt fetch (chat)', { ms: Date.now() - jwtStartMs });
  const allHeaders = { ...baseHeaders, ...ctx.headers };

  const body: Record<string, unknown> = {
    messages,
    stream: false, // E2EE requires complete response for decryption
    model,
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

  logger.debug(`${TAG} cloudChatStream POST`, { url: CHAT_API });

  // Dev-only timing: per-request POST→response wall time (includes model time +
  // the non-streaming double-turn when a tool fires). Tagged for first-chat
  // latency attribution.
  const postStartMs = Date.now();
  const response = await authFetch(
    CHAT_API,
    {
      method: 'POST',
      headers: allHeaders,
      body: JSON.stringify(body),
    },
    {
      // Outlast the gateway's 120s upstream timeout and stop the 502/timeout
      // storm on a cold model (see the constants above).
      requestTimeoutMs: CHAT_REQUEST_TIMEOUT_MS,
      maxTimeoutAttempts: CHAT_MAX_TIMEOUT_ATTEMPTS,
    },
  );
  logger.debug('[chat-timing] chat POST→response', {
    ms: Date.now() - postStartMs,
    status: response.status,
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    logger.error(`${TAG} cloudChatStream HTTP error`, undefined, { status: response.status, errorText });
    throw new Error(`E2EE chat failed: ${response.status} ${response.statusText} — ${errorText}`);
  }

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
    const decrypted = decryptContent(rawContent, ctx.privateKey, ctx.algo);
    yield { type: 'text-delta', delta: decrypted };
  }

  // Tool calls are NOT encrypted — emit them as-is.
  //
  // E2EE GAP (documented, intentional): the NEAR-v2 envelope only covers
  // `message.content`, which is decrypted above. Tool-call function arguments
  // are emitted by the gateway in cleartext because the gateway must read/route
  // them. For the persona-update agent these arguments are model-generated
  // structured data derived from the user's conversation (e.g. persona-fact
  // updates), so any user-derived content placed in a tool-call argument is
  // visible to the inference gateway operator and is NOT protected by E2EE.
  // See SECURITY.md ("What E2EE does and does not cover") for the threat-model
  // boundary. Encrypting tool-call args would require a matching gateway-side
  // change and is only worth it if the gateway is treated as untrusted.
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

