// Inference Engine: on-device inference via llama.rn.
//   infer / inferStream  completions on the TEXT model
//   decide               Kev decisions on the RELEVANCE model
// Each takes the llama lock (llama-lock.ts) once and makes its model resident
// inside it (modelManager._ensureLoaded), swapping out the other model if needed.

import type { DecisionRequest, DecisionResult } from 'llama.rn';
import type { InferParams, InferResult } from '../types';
import { holdRestart } from '../../app-restart';
import { recordCompletion } from './inference-stats';
import { acquireLlamaLock, withLlamaLock } from './llama-lock';
import { RELEVANCE_MODEL, supportsJsonGrammar, TEXT_MODEL } from './model-catalog';
import { _ensureLoaded, _getContext, _updateInferenceSpeed, getModelState } from './modelManager';

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
async function inferExclusive(params: InferParams): Promise<InferResult> {
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
    ...(wantsJsonGrammar(params) && {
      response_format: { type: 'json_object' as const },
    }),
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
