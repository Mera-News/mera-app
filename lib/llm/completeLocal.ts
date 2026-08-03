// completeLocal — standalone local LLM completion.
// Extracted from LocalInferenceEngine.complete() after engine deletion in Phase 5.
// Calls infer() from mera-protocol-toolkit directly.

import { getModelState, infer as localInfer, initBaseModel } from '../mera-protocol-toolkit';
import { useMeraProtocolStore } from '../stores/mera-protocol-store';
import logger from '../logger';

/** Thrown when a thinking-enabled completion ran out of budget mid-reasoning,
 *  so the "output" is really a truncated reasoning trace. Callers must treat
 *  this as a RETRYABLE failure — never as a real (empty) model answer. */
export class LocalTruncatedReasoningError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LocalTruncatedReasoningError';
  }
}

export interface LocalCompleteRequest {
  systemPrompt: string;
  prompt: string;
  maxTokens?: number;
  temperature?: number;
  responseFormat?: 'text' | 'json';
  enableThinking?: boolean;
}

export async function completeLocal(request: LocalCompleteRequest): Promise<string> {
  if (getModelState() === null) {
    const { setModelState } = useMeraProtocolStore.getState();
    setModelState('loading');
    await initBaseModel();
    setModelState('ready');
  }

  const result = await localInfer({
    systemPrompt: request.systemPrompt,
    prompt: request.prompt,
    maxTokens: request.maxTokens ?? 512,
    temperature: request.temperature ?? 0.3,
    responseFormat: request.responseFormat === 'json' ? 'json' : undefined,
    enableThinking: request.enableThinking,
  });

  // Reasoning-trace handling. `enableThinking` makes the model emit a <think>
  // block before its real answer; only the answer may be returned.
  //
  // 1. Strip well-formed <think>…</think> pairs (the normal case).
  let stripped = result.output.replace(/<think>[\s\S]*?<\/think>/g, '');

  // 2. Prefill case: the Qwen3 chat template can inject the OPENING <think> into
  //    the prompt, so a successful generation comes back as `reasoning</think>
  //    answer` — a closer with no opener, which step 1 cannot match. Drop
  //    everything up to and including the last closer; the remainder is the
  //    answer. This is a SUCCESS path, not an error.
  const lastCloser = stripped.lastIndexOf('</think>');
  if (lastCloser !== -1) {
    stripped = stripped.slice(lastCloser + '</think>'.length);
  }

  // 3. An opener with no closer means generation stopped mid-reasoning. Before
  //    this guard the trace fell through as `output`, callers failed to parse it
  //    and reported "no usable topics" — a truncation disguised as an empty
  //    answer. Fail loudly so the caller can retry instead.
  if (stripped.includes('<think>')) {
    throw new LocalTruncatedReasoningError(
      `Local completion ran out of budget mid-reasoning (maxTokens=${request.maxTokens ?? 512}). ` +
        'Raise maxTokens or disable thinking for this call.',
    );
  }

  const output = stripped.trim();

  // 4. Truncated with nothing usable left. llama.rn reports `truncated` when the
  //    n_predict ceiling was hit; combined with an empty answer that is the same
  //    defect as (3) for a template that emits no tags at all.
  if (result.truncated && output.length === 0) {
    throw new LocalTruncatedReasoningError(
      `Local completion hit the token ceiling (maxTokens=${request.maxTokens ?? 512}) ` +
        'and produced no usable output.',
    );
  }

  // Truncated but still substantive: usable, so return it — but make it visible
  // rather than silent, since it is the leading indicator of (3)/(4).
  if (result.truncated) {
    logger.warn('[completeLocal] output truncated at the token ceiling', {
      maxTokens: request.maxTokens ?? 512,
      outputLength: output.length,
      enableThinking: request.enableThinking ?? false,
    });
  }

  return output;
}
