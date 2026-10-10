// chat-response — turns an OK gateway chat response into SseEvents: SSE
// streaming (one E2EE envelope per delta) or the buffered JSON fallback, with
// think-stripping and text-tool-call parsing applied once for every consumer.
// Imports gateway-fetch only.

import { decryptContent, type SigningAlgo } from '../e2ee/e2ee-service';
import logger from '../logger';
import { createThinkStripper } from './think-strip';
import {
  APP_TOOL_FORMAT,
  createToolCallStreamParser,
  type TextToolDefinition,
} from './text-tool-protocol';
import { sseEvents } from './sse';
import {
  CallerAbortError,
  CleartextToolCallError,
  isCallerAbort,
  StreamIdleError,
  takeStreamHandle,
  UPSTREAM_ALIGNED_TIMEOUT_MS,
  type StreamHandle,
} from './gateway-fetch';

const TAG = '[CloudLLM]';

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

// ---------------------------------------------------------------------------
// SSE event types (OpenAI chat completion chunk format)
// ---------------------------------------------------------------------------

export type SseEvent =
  | { type: 'text-delta'; delta: string }
  /** The model has started a reasoning trace and nothing visible has arrived
   *  yet. Emitted ONCE per stream, with no payload: the trace is dropped
   *  undecrypted and must never reach the UI. It exists so the typing bubble
   *  can say the wait is thinking, not a stall. */
  | { type: 'reasoning' }
  | { type: 'tool-call-delta'; index: number; id?: string; name?: string; argumentsDelta: string }
  | { type: 'finish'; reason: 'stop' | 'tool_calls' | 'length' | 'error' }
  | { type: 'error'; message: string };

/** Non-streaming chat completion response (used for E2EE path). */
export interface ChatCompletionResponse {
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

/** Turn an OK chat response into events, streaming when the gateway relayed
 *  SSE and buffering when it relayed JSON.
 *
 *  Think tags are stripped HERE, once, for every cloud chat consumer (the
 *  persona loop, single-shot and article chat): a reply rendered
 *  "... Bhopal. </think>". A tag split across deltas is held until it resolves,
 *  and an all-reasoning delta yields nothing rather than an empty delta.
 *
 *  Tool calls are parsed HERE too, after the think stripper (a call inside a
 *  think block must never run): they arrive as text inside the encrypted
 *  content (text-tool-protocol) and leave as the same `tool-call-delta` events
 *  a native call used to produce, one whole call per event. */
export async function* consumeChatResponse(
  response: Response,
  privateKey: Uint8Array,
  algo: SigningAlgo,
  tools: TextToolDefinition[],
  signal?: AbortSignal,
): AsyncGenerator<SseEvent> {
  const think = createThinkStripper();
  const calls = createToolCallStreamParser(tools, APP_TOOL_FORMAT);
  let callIndex = 0;
  const stamp = Date.now().toString(36);
  function* emit(r: { text: string; calls: { name: string; argumentsRaw: string }[] }): Generator<SseEvent> {
    if (r.text) yield { type: 'text-delta', delta: r.text };
    for (const c of r.calls) {
      const index = callIndex++;
      yield { type: 'tool-call-delta', index, id: `call_${stamp}_${index}`, name: c.name, argumentsDelta: c.argumentsRaw };
    }
  }
  for await (const event of consumeChatResponseRaw(response, privateKey, algo, signal)) {
    if (event.type === 'text-delta') {
      const delta = think.push(event.delta);
      if (delta) yield* emit(calls.push(delta));
      continue;
    }
    if (event.type === 'tool-call-delta') {
      // A provider that lifted a call out of the content sent it in CLEAR: it
      // never passed the envelope, so nothing proves the model wrote it. Report
      // it once (never its content) and fail the turn closed; nothing is
      // forwarded, so nothing runs.
      logger.captureMessage(`${TAG} provider returned a cleartext tool call`, {
        level: 'error',
        fingerprint: ['e2ee-cleartext-tool-call'],
        tags: { component: 'cloudComplete' },
      });
      throw new CleartextToolCallError();
    }
    if (event.type === 'finish') {
      const tail = think.flush();
      if (tail) yield* emit(calls.push(tail));
      const last = calls.flush();
      yield* emit(last);
      if (callIndex > 0 && event.reason === 'stop') {
        yield { type: 'finish', reason: 'tool_calls' };
        continue;
      }
    }
    yield event;
  }
}

async function* consumeChatResponseRaw(
  response: Response,
  privateKey: Uint8Array,
  algo: SigningAlgo,
  signal?: AbortSignal,
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
  yield* consumeSseChat(response, privateKey, algo, handle, signal);
}

/** Streaming path: one E2EE envelope per `delta.content`, decrypted as it lands. */
/** The provider's finish_reason as the client reports it. `length` is kept so a
 *  caller can tell a token-capped answer from a finished one; anything else
 *  the client does not act on is a plain stop. */
function finishReasonOf(raw: string | null | undefined): 'stop' | 'tool_calls' | 'length' {
  return raw === 'tool_calls' || raw === 'length' ? raw : 'stop';
}

async function* consumeSseChat(
  response: Response,
  privateKey: Uint8Array,
  algo: SigningAlgo,
  handle: StreamHandle | undefined,
  signal?: AbortSignal,
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

  // A stop cancels the body at once instead of waiting for the next chunk.
  const onStop = () => {
    handle?.abort();
    void reader.cancel().catch(() => { /* already dead */ });
  };
  if (signal?.aborted) onStop();
  else signal?.addEventListener('abort', onStop, { once: true });

  let finishReason = 'stop';
  try {
    // authFetch dropped its own 130s header timer at handoff; until the first
    // chunk arrives this reinstates the same budget (a cold model may sit on an
    // open, silent stream). Every chunk after that tightens it.
    armIdle(UPSTREAM_ALIGNED_TIMEOUT_MS);
    let reasoningSignalled = false;
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
      // decrypting, and must never be yielded as assistant text. Its ARRIVAL
      // is signalled once, so the bubble can show "Thinking…" — on the BIG
      // primary the trace runs 3-12s before the first visible token.
      if (delta.reasoning_content && !reasoningSignalled) {
        reasoningSignalled = true;
        yield { type: 'reasoning' };
      }
      if (delta.content) {
        yield { type: 'text-delta', delta: decryptContent(delta.content, privateKey, algo) };
      }

      // The app never sends a tools field, so a native `delta.tool_calls` here
      // means the provider lifted a call out of the content, in CLEAR.
      // consumeChatResponse reports it and fails the turn closed.
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
    if (signal?.aborted) throw new CallerAbortError('cloudChatStream: stopped');
    if (idleTimedOut) throw new StreamIdleError();
  } catch (err) {
    // The cancelled body rejects with a plain abort error: re-type it, so it is
    // never read as evidence about the model.
    if (signal?.aborted && !isCallerAbort(err)) throw new CallerAbortError('cloudChatStream: stopped', err);
    throw err;
  } finally {
    clearTimeout(idleTimer);
    signal?.removeEventListener('abort', onStop);
    handle?.release();
  }

  yield { type: 'finish', reason: finishReasonOf(finishReason) };
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

  // Never expected: the app sends no tools field (see consumeSseChat).
  if (choice.message?.tool_calls) {
    for (const [index, tc] of choice.message.tool_calls.entries()) {
      yield {
        type: 'tool-call-delta',
        index,
        id: tc.id,
        name: tc.function.name,
        argumentsDelta: tc.function.arguments,
      };
    }
  }

  yield { type: 'finish', reason: finishReasonOf(choice.finish_reason) };
}

