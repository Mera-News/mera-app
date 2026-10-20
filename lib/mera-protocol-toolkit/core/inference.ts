// Inference Engine: on-device inference.
//   infer / inferStream  text, on the phone's built-in model ('afm' Apple
//                        Foundation Models, 'nano' Gemini Nano) through
//                        mera-on-device-llm
//   inferStructured      a JSON value fitting a schema, on the same model
//   decide               Kev decisions on the RELEVANCE model (llama.rn)
// Each takes the llama lock (llama-lock.ts) once. The built-in model runs out of
// process and loads nothing, but stays on the same chain so calls never overlap;
// `decide` makes Kev resident inside it (modelManager._ensureLoaded), and Kev
// stays resident (D37: llama.rn holds Kev only, nothing is swapped).

import type { DecisionRequest, DecisionResult } from 'llama.rn';
import { AppState } from 'react-native';
import type { InferParams, InferResult } from '../types';
import { holdRestart } from '../../app-restart';
import { recordCompletion, recordRefusal } from './inference-stats';
import { acquireLlamaLock, withLlamaLock } from './llama-lock';
import { RELEVANCE_MODEL } from './model-catalog';
import { _assertOnDeviceMode, _ensureLoaded, _getContext, _releaseModel } from './modelManager';
import { readStructured, type JsonSchema } from './structured-json';
import type { TextEngine } from './text-engine';
import {
  contextSize as nativeContextSize,
  isOnDeviceLlmRefusal,
  respond as nativeRespond,
  respondStructured as nativeRespondStructured,
  stream as nativeStream,
  type OnDeviceLlmOptions,
} from '@/modules/mera-on-device-llm';

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

// The timing belongs INSIDE the lock: `latencyMs` must measure the completion
// rather than the time spent waiting for the lock.
async function inferNative(params: InferParams): Promise<InferResult> {
  _assertOnDeviceMode();
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

/** General-purpose on-device LLM inference. */
export function infer(params: InferParams): Promise<InferResult> {
  return withLlamaLock(async () => {
    // A JS reload under a running native completion hands its callbacks a
    // torn-down runtime. Every return from background reloads the app, so a
    // completion holds the restart for its own duration (chat streaming holds
    // it separately, in ChatSessionView).
    const release = holdRestart('local-inference');
    try {
      return await inferNative(params);
    } finally {
      release();
    }
  });
}

/**
 * Streaming variant of infer(). Yields tokens as they are generated. An abort
 * cancels the native stream and ends the generator.
 */
export async function* inferStream(
  params: InferParams,
  signal?: AbortSignal,
): AsyncGenerator<string> {
  if (signal?.aborted) return;
  const release = await acquireLlamaLock();
  try {
    // The abort may have landed while this call queued for the lock.
    if (signal?.aborted) return;
    yield* inferStreamNative(params, signal);
  } finally {
    release();
  }
}

export type StructuredParams = {
  system: string;
  prompt: string;
  /** The reply's shape. Its root is an object or an array. */
  schema: JsonSchema;
  temperature?: number;
  maxTokens?: number;
  /** The engine the prompt was built for; a phone only ever has one. */
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
async function structuredOnce(params: StructuredParams, prompt: string): Promise<string> {
  _assertOnDeviceMode();
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
 * A JSON value fitting `schema`, from the built-in model's `respondStructured`.
 * Every reply is read
 * tolerantly (code fences and prose skipped) and checked against the schema; a
 * miss is retried once with a short reminder, then throws StructuredOutputError.
 * Engine errors (busy, unavailable, refusal) are never retried here: they reach
 * the caller as they are, so a queue job can defer.
 */
export function inferStructured<T = unknown>(params: StructuredParams): Promise<T> {
  return withLlamaLock(async () => {
    const release = holdRestart('local-inference');
    try {
      for (const prompt of [params.prompt, `${params.prompt}\n\n${JSON_REMINDER}`]) {
        const value = readStructured(await structuredOnce(params, prompt), params.schema);
        if (value !== undefined) return value as T;
      }
      throw new StructuredOutputError();
    } finally {
      release();
    }
  });
}

/**
 * The built-in model's token budget, so a flow can size its prompt. Not the same
 * measure on both: Apple reports the whole window, input plus output; Gemini Nano
 * reports its INPUT limit (~4000). Size a prompt as `contextSize - maxTokens`,
 * which is safe on both. Null when the built-in model cannot say. `_engine` is
 * the caller's engine; a phone only ever has one.
 */
export async function contextSize(_engine?: TextEngine): Promise<number | null> {
  return nativeContextSize();
}

/**
 * Kev could not run now: the app is in the background, or the GPU failed twice.
 * Carries the built-in model's busy code, so the queue defers it (job-defer.ts)
 * and the relevance pass leaves its rows unscored for the next pass.
 */
export class KevBusyError extends Error {
  readonly code = 'ERR_AFM_BUSY';
  constructor(message: string) {
    super(message);
    this.name = 'KevBusyError';
  }
}

/** llama_decode's -3: ggml-metal failed a command buffer (iOS refuses GPU work
 *  from the background). ggml-metal keeps that error: every later decode on the
 *  context fails the same way until the context is recreated. */
const GPU_FAILED = /\(error -3\)/;

/** `=== 'background'`, never `!== 'active'`: iOS reports `inactive` for the app
 *  switcher and Control Center, where the GPU still runs (app-restart.ts). */
const inBackground = () => AppState.currentState === 'background';

/**
 * One Kev decision (`context.decide()`, the TypeSafe `/v1/systemone` shape) on
 * the RELEVANCE model. The lock is taken per request, so a chat turn can step in
 * between two articles; Kev stays resident, so it costs no reload.
 *
 * In the background it refuses (KevBusyError) without touching the GPU. A GPU
 * failure releases the context, because it would fail every later call; in the
 * foreground Kev is reloaded and the request asked once more.
 */
export function decide<R extends DecisionRequest>(request: R): Promise<DecisionResult<R['questions']>> {
  return withLlamaLock(async () => {
    const release = holdRestart('local-inference');
    try {
      for (let attempt = 1; ; attempt++) {
        if (inBackground()) throw new KevBusyError('Kev does not run in the background');
        await _ensureLoaded(RELEVANCE_MODEL.modelId);
        const context = _getContext();
        if (!context) throw new Error('No model loaded.');
        const startTime = Date.now();
        try {
          const result = await context.decide(request);
          recordCompletion({ label: 'relevance', latencyMs: Date.now() - startTime });
          return result as DecisionResult<R['questions']>;
        } catch (error) {
          if (!(error instanceof Error) || !GPU_FAILED.test(error.message)) throw error;
          await _releaseModel();
          if (attempt > 1) throw new KevBusyError('Kev failed on the GPU twice');
        }
      }
    } finally {
      release();
    }
  });
}
