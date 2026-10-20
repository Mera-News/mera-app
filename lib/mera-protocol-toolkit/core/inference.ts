// Inference Engine: on-device inference.
//   infer / inferStream  text, on the TEXT ENGINE (text-engine.ts, or the one the
//                        caller names): 'qwen' through llama.rn, or the
//                        platform's built-in model ('afm' Apple Foundation
//                        Models, 'nano' Gemini Nano) through mera-on-device-llm
//   inferStructured      a JSON value fitting a schema, on the same engines
//   decide               Kev decisions on the RELEVANCE model (llama.rn)
// Each takes the llama lock (llama-lock.ts) once. A llama.rn call makes its
// model resident inside it (modelManager._ensureLoaded), swapping out the other
// model if needed; the native engine runs out of process and loads nothing, but
// stays on the same chain so calls never overlap.

import type { DecisionRequest, DecisionResult } from 'llama.rn';
import type { InferParams, InferResult } from '../types';
import { holdRestart } from '../../app-restart';
import { recordCompletion, recordRefusal } from './inference-stats';
import { acquireLlamaLock, withLlamaLock } from './llama-lock';
import { LOCAL_CONTEXT_TOKENS } from './context-size';
import { RELEVANCE_MODEL, supportsJsonGrammar, TEXT_MODEL } from './model-catalog';
import {
  _assertOnDeviceMode,
  _ensureLoaded,
  _getContext,
  _releaseTextModel,
  _updateInferenceSpeed,
  getModelState,
} from './modelManager';
import { readStructured, type JsonSchema } from './structured-json';
import { getTextEngine, isBuiltInEngine, type TextEngine } from './text-engine';
import {
  contextSize as nativeContextSize,
  isOnDeviceLlmRefusal,
  respond as nativeRespond,
  respondStructured as nativeRespondStructured,
  stream as nativeStream,
  type OnDeviceLlmOptions,
} from '@/modules/mera-on-device-llm';

/** The engine a call runs on: the one the caller built its prompt for, else the one in force. */
async function engineFor(params: { engine?: TextEngine }): Promise<TextEngine> {
  return params.engine ?? (await getTextEngine());
}

/** What the native engine takes. It has no stop sequences, no grammar and no
 *  thinking switch: the JSON jobs carry the format in words and are parsed from
 *  the text, and no caller passes stop sequences. */
function nativeOptions(params: InferParams): OnDeviceLlmOptions {
  return { temperature: params.temperature ?? 0.3, maxTokens: params.maxTokens ?? 512 };
}

/** A guardrail or refusal is a failed call, counted in the speed readout. */
function countRefusal(error: unknown): never {
  if (isOnDeviceLlmRefusal(error)) recordRefusal();
  throw error;
}

async function inferNative(params: InferParams): Promise<InferResult> {
  _assertOnDeviceMode();
  // The downloaded text model is idle while the native engine writes; give its memory back.
  await _releaseTextModel();
  const startTime = Date.now();
  const output = await nativeRespond(params.systemPrompt ?? '', params.prompt, nativeOptions(params)).catch(
    countRefusal,
  );
  const latencyMs = Date.now() - startTime;
  recordCompletion({ label: params.label, latencyMs });
  return { output, tokensUsed: 0, latencyMs, truncated: false };
}

async function* inferStreamNative(params: InferParams, signal?: AbortSignal): AsyncGenerator<string> {
  _assertOnDeviceMode();
  await _releaseTextModel();
  if (signal?.aborted) return;

  const queue: string[] = [];
  let done = false;
  let failure: Error | null = null;
  let wake: (() => void) | null = null;
  const notify = () => {
    wake?.();
    wake = null;
  };
  const handle = nativeStream(params.systemPrompt ?? '', params.prompt, nativeOptions(params), {
    onToken: (delta) => {
      queue.push(delta);
      notify();
    },
    onDone: () => {
      done = true;
      notify();
    },
    onError: (error) => {
      done = true;
      if (error.code !== 'ERR_AFM_CANCELLED') failure = error;
      notify();
    },
  });
  const onAbort = () => {
    handle.cancel();
    notify();
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    while (true) {
      if (signal?.aborted) return;
      if (queue.length > 0) {
        yield queue.shift()!;
      } else if (done) {
        break;
      } else {
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    }
    if (failure) countRefusal(failure);
  } finally {
    signal?.removeEventListener('abort', onAbort);
    // The consumer left early (Stop, or any throw): stop the native stream.
    if (!done) handle.cancel();
  }
}

/**
 * The JSON grammar is applied only for a model whose tokenizer supports it
 * (see `jsonGrammar` in model-catalog.ts). Elsewhere the prompt's own
 * instruction carries the format.
 */
function wantsJsonGrammar(params: InferParams): boolean {
  return params.responseFormat === 'json' && supportsJsonGrammar(getModelState()?.modelId);
}

/** General-purpose on-device LLM inference. */
export function infer(params: InferParams): Promise<InferResult> {
  return withLlamaLock(async () => {
    // A JS reload under a running native completion hands its callbacks a
    // torn-down runtime. Every return from background reloads the app, so a
    // completion holds the restart for its own duration (chat streaming holds
    // it separately, in ChatSessionView).
    const release = holdRestart('local-inference');
    try {
      return await inferExclusive(params);
    } finally {
      release();
    }
  });
}

// The context lookup and the timing both belong INSIDE the lock: the context can
// be disposed while a caller queues, and `latencyMs` must measure the completion
// rather than the time spent waiting for the lock.
async function inferExclusive(params: InferParams, schema?: JsonSchema): Promise<InferResult> {
  if (isBuiltInEngine(await engineFor(params))) return inferNative(params);
  await _ensureLoaded(TEXT_MODEL.modelId);
  const context = _getContext();
  if (!context) {
    throw new Error('No model loaded. Call initBaseModel() first.');
  }

  const startTime = Date.now();

  const messages: Array<{ role: string; content: string }> = [];
  if (params.systemPrompt) {
    messages.push({ role: 'system', content: params.systemPrompt });
  }
  messages.push({ role: 'user', content: params.prompt });

  const result = await context.completion({
    messages,
    n_predict: params.maxTokens ?? 512,
    temperature: params.temperature ?? 0.3,
    top_p: 0.9,
    top_k: 40,
    stop: params.stopSequences,
    enable_thinking: params.enableThinking ?? false,
    ...(schema
      ? { response_format: { type: 'json_schema' as const, json_schema: { schema } } }
      : wantsJsonGrammar(params) && { response_format: { type: 'json_object' as const } }),
  });

  const latencyMs = Date.now() - startTime;

  // Update inference speed in model state
  if (result.timings?.predicted_per_second) {
    _updateInferenceSpeed(
      Math.round(result.timings.predicted_per_second),
    );
  }
  recordCompletion({
    label: params.label,
    latencyMs,
    promptTokPerSec: result.timings?.prompt_per_second,
    genTokPerSec: result.timings?.predicted_per_second,
  });

  return {
    output: result.text,
    tokensUsed: result.tokens_predicted + result.tokens_evaluated,
    latencyMs,
    truncated: result.truncated,
  };
}

/**
 * Streaming variant of infer(). Yields tokens as they are generated. An abort
 * stops the completion and ends the generator; the lock is still released only
 * after llama has unwound.
 */
export async function* inferStream(
  params: InferParams,
  signal?: AbortSignal,
): AsyncGenerator<string> {
  if (signal?.aborted) return;
  const release = await acquireLlamaLock();
  try {
    yield* inferStreamExclusive(params, signal);
  } finally {
    release();
  }
}

async function* inferStreamExclusive(
  params: InferParams,
  signal?: AbortSignal,
): AsyncGenerator<string> {
  // The abort may have landed while this call queued for the lock.
  if (signal?.aborted) return;
  if (isBuiltInEngine(await engineFor(params))) {
    yield* inferStreamNative(params, signal);
    return;
  }
  await _ensureLoaded(TEXT_MODEL.modelId);
  // ...or while the text model loaded, which can take seconds after a swap.
  if (signal?.aborted) return;
  const context = _getContext();
  if (!context) {
    throw new Error('No model loaded. Call initBaseModel() first.');
  }

  // Use a queue to bridge the callback-based API with the async generator
  const tokenQueue: string[] = [];
  let done = false;
  let failure: Error | null = null;
  let aborted = false;
  let resolveWait: (() => void) | null = null;
  let rejectWait: ((err: Error) => void) | null = null;

  const messages: Array<{ role: string; content: string }> = [];
  if (params.systemPrompt) {
    messages.push({ role: 'system', content: params.systemPrompt });
  }
  messages.push({ role: 'user', content: params.prompt });

  // The restart stays held until llama has unwound, which can be after the
  // consumer (and the chat turn's own hold) is gone: a JS reload under a running
  // native completion hands its callbacks a torn-down runtime.
  const releaseRestart = holdRestart('local-inference');

  // Start completion in background — tokens arrive via callback
  const completionPromise = context
    .completion(
      {
        messages,
        n_predict: params.maxTokens ?? 512,
        temperature: params.temperature ?? 0.3,
        top_p: 0.9,
        top_k: 40,
        stop: params.stopSequences,
        enable_thinking: false,
        ...(wantsJsonGrammar(params) && {
          response_format: { type: 'json_object' as const },
        }),
      },
      (data) => {
        if (data.token) {
          tokenQueue.push(data.token);
          resolveWait?.();
          resolveWait = null;
        }
      },
    )
    .then(() => {
      done = true;
      resolveWait?.();
      resolveWait = null;
    })
    .catch((err: unknown) => {
      done = true;
      const error =
        err instanceof Error ? err : new Error(String(err));
      failure = error;
      rejectWait?.(error);
      rejectWait = null;
    })
    .finally(releaseRestart);

  const onAbort = () => {
    aborted = true;
    void (async () => {
      try {
        await context.stopCompletion();
      } catch {
        /* already finished */
      }
    })();
    resolveWait?.();
    resolveWait = null;
    rejectWait = null;
  };
  signal?.addEventListener('abort', onAbort, { once: true });

  try {
    // Yield tokens as they arrive
    while (true) {
      if (aborted) return;
      if (tokenQueue.length > 0) {
        yield tokenQueue.shift()!;
      } else if (done) {
        break;
      } else {
        // Wait for next token or completion
        await new Promise<void>((resolve, reject) => {
          resolveWait = resolve;
          rejectWait = reject;
        });
      }
    }

    // Drain any remaining tokens
    while (tokenQueue.length > 0) {
      yield tokenQueue.shift()!;
    }

    // A rejection that landed while the reader was busy with queued tokens
    // found no waiter to reject; report it here instead of a finished half reply.
    if (failure) throw failure;
  } finally {
    signal?.removeEventListener('abort', onAbort);
    // The consumer left early (Stop, or any throw): halt llama before the lock
    // is released, or the next completion would interleave with this one in
    // the shared KV cache. `done` is set by the completion's own settle.
    if (!done) {
      try {
        await context.stopCompletion();
      } catch {
        /* already finished or never started */
      }
      // Never release the lock while llama is still unwinding.
      await completionPromise;
    }
  }

  // Ensure the completion promise has settled
  await completionPromise;
}

export type StructuredParams = {
  system: string;
  prompt: string;
  /** The reply's shape. Its root is an object or an array. */
  schema: JsonSchema;
  temperature?: number;
  maxTokens?: number;
  /** The engine the prompt was built for; the one in force when omitted. */
  engine?: TextEngine;
  label?: InferParams['label'];
};

/** A structured reply that never fit its schema, after the retry. Not deferrable: the model answered. */
export class StructuredOutputError extends Error {
  readonly code = 'ERR_STRUCTURED_OUTPUT';
  constructor() {
    super('On-device reply did not match its schema');
    this.name = 'StructuredOutputError';
  }
}

const JSON_REMINDER = 'Reply with only JSON that matches the schema. No other text.';

/** One structured attempt, as text. Unlocked: call only inside the llama lock. */
async function structuredOnce(engine: TextEngine, params: StructuredParams, prompt: string): Promise<string> {
  if (!isBuiltInEngine(engine)) {
    const result = await inferExclusive(
      {
        systemPrompt: params.system,
        prompt,
        maxTokens: params.maxTokens,
        temperature: params.temperature,
        label: params.label,
        engine,
      },
      params.schema,
    );
    return result.output;
  }
  _assertOnDeviceMode();
  await _releaseTextModel();
  const startTime = Date.now();
  const output = await nativeRespondStructured(
    params.system,
    prompt,
    JSON.stringify(params.schema),
    nativeOptions({ prompt, temperature: params.temperature, maxTokens: params.maxTokens }),
  ).catch(countRefusal);
  recordCompletion({ label: params.label, latencyMs: Date.now() - startTime });
  return output;
}

/**
 * A JSON value fitting `schema`. Qwen runs under a llama.rn json_schema grammar;
 * the built-in models answer through `respondStructured`. Every reply is read
 * tolerantly (code fences and prose skipped) and checked against the schema; a
 * miss is retried once with a short reminder, then throws StructuredOutputError.
 * Engine errors (busy, unavailable, refusal) are never retried here: they reach
 * the caller as they are, so a queue job can defer.
 */
export function inferStructured<T = unknown>(params: StructuredParams): Promise<T> {
  return withLlamaLock(async () => {
    const release = holdRestart('local-inference');
    try {
      const engine = await engineFor(params);
      for (const prompt of [params.prompt, `${params.prompt}\n\n${JSON_REMINDER}`]) {
        const value = readStructured(await structuredOnce(engine, params, prompt), params.schema);
        if (value !== undefined) return value as T;
      }
      throw new StructuredOutputError();
    } finally {
      release();
    }
  });
}

/**
 * The text engine's context window in tokens, input plus output, so a flow can
 * size its prompt. The built-in model reports its own (null when it cannot say);
 * Qwen runs at LOCAL_CONTEXT_TOKENS.
 */
export async function contextSize(engine?: TextEngine): Promise<number | null> {
  const e = engine ?? (await getTextEngine());
  return isBuiltInEngine(e) ? nativeContextSize() : LOCAL_CONTEXT_TOKENS;
}

/**
 * One Kev decision (`context.decide()`, the TypeSafe `/v1/systemone` shape) on
 * the RELEVANCE model. The lock is taken per request, so a chat turn can step in
 * between two articles; the cost is a model swap each way.
 */
export function decide<R extends DecisionRequest>(request: R): Promise<DecisionResult<R['questions']>> {
  return withLlamaLock(async () => {
    const release = holdRestart('local-inference');
    try {
      await _ensureLoaded(RELEVANCE_MODEL.modelId);
      const context = _getContext();
      if (!context) throw new Error('No model loaded.');
      const startTime = Date.now();
      const result = await context.decide(request);
      recordCompletion({ label: 'relevance', latencyMs: Date.now() - startTime });
      return result as DecisionResult<R['questions']>;
    } finally {
      release();
    }
  });
}
