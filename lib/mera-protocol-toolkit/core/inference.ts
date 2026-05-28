// Inference Engine — On-device LLM inference via llama.rn
// Wraps llama.rn completion API with toolkit's InferParams/InferResult types

import type { InferParams, InferResult } from '../types';
import { _getContext, _updateInferenceSpeed } from './modelManager';

/** General-purpose on-device LLM inference. */
export async function infer(params: InferParams): Promise<InferResult> {
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
    ...(params.responseFormat === 'json' && {
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

  return {
    output: result.text,
    tokensUsed: result.tokens_predicted + result.tokens_evaluated,
    latencyMs,
    truncated: result.truncated,
  };
}

/** Streaming variant of infer(). Yields tokens as they are generated. */
export async function* inferStream(
  params: InferParams,
): AsyncGenerator<string> {
  const context = _getContext();
  if (!context) {
    throw new Error('No model loaded. Call initBaseModel() first.');
  }

  // Use a queue to bridge the callback-based API with the async generator
  const tokenQueue: string[] = [];
  let done = false;
  let resolveWait: (() => void) | null = null;
  let rejectWait: ((err: Error) => void) | null = null;

  const messages: Array<{ role: string; content: string }> = [];
  if (params.systemPrompt) {
    messages.push({ role: 'system', content: params.systemPrompt });
  }
  messages.push({ role: 'user', content: params.prompt });

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
        ...(params.responseFormat === 'json' && {
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
      rejectWait?.(error);
      rejectWait = null;
    });

  // Yield tokens as they arrive
  while (true) {
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

  // Ensure the completion promise has settled
  await completionPromise;
}
