// Inference Engine — On-device LLM inference via llama.rn
// Wraps llama.rn completion API with toolkit's InferParams/InferResult types

import type { InferParams, InferResult } from '../types';
import { _getContext, _updateInferenceSpeed } from './modelManager';

// llama.rn holds ONE context for the whole app and a completion mutates its KV
// cache in place, so two overlapping calls interleave: the second one's prefill
// lands on top of the first one's state. That corrupts the output and makes the
// `timings` this file reports meaningless, which is why any latency measurement
// taken before this lock existed could not be trusted. Every entry point that
// touches the context is serialised through one chain.
let llamaChain: Promise<unknown> = Promise.resolve();

/** Runs `fn` once every earlier llama caller has settled. */
function withLlamaLock<T>(fn: () => Promise<T>): Promise<T> {
  // `.then(fn, fn)` runs fn whether the previous holder resolved OR rejected —
  // one failed completion must not wedge every later one behind it.
  const run = llamaChain.then(fn, fn);
  llamaChain = run.catch(() => {});
  return run;
}

/**
 * Manual acquire for `inferStream`, which spans many awaits and so cannot be
 * expressed as a single promise. Resolves once the lock is held; the caller
 * MUST release it in a `finally`, or every later llama call waits forever.
 *
 * `for await` always calls the generator's `.return()` on break/throw, so the
 * `finally` runs and this is safe for every consumer today. The one shape that
 * would deadlock is a consumer driving `.next()` by hand and abandoning the
 * generator without `.return()`: nothing releases, and since this file is the
 * single chokepoint for all on-device inference, the whole engine goes quiet
 * with no error. Iterate with `for await`.
 */
function acquireLlamaLock(): Promise<() => void> {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const acquired = llamaChain.then(
    () => release,
    () => release,
  );
  llamaChain = acquired.then(() => held);
  return acquired;
}

/** General-purpose on-device LLM inference. */
export function infer(params: InferParams): Promise<InferResult> {
  return withLlamaLock(() => inferExclusive(params));
}

// The context lookup and the timing both belong INSIDE the lock: the context can
// be disposed while a caller queues, and `latencyMs` must measure the completion
// rather than the time spent waiting for the lock.
async function inferExclusive(params: InferParams): Promise<InferResult> {
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
  const release = await acquireLlamaLock();
  try {
    yield* inferStreamExclusive(params);
  } finally {
    release();
  }
}

async function* inferStreamExclusive(
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
