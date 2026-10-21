// completeLocal: standalone local LLM completion on the phone's built-in model
// (Apple Intelligence, Gemini Nano). Calls infer() from mera-protocol-toolkit.
// The built-in models emit no reasoning trace and never report a truncated
// reply, so the reply is the answer.

import { infer as localInfer, inferStructured, type JsonSchema, type TextEngine } from '../mera-protocol-toolkit';
import type { InferenceLabel } from '../mera-protocol-toolkit/core/inference-stats';

export interface LocalCompleteRequest {
  systemPrompt: string;
  prompt: string;
  maxTokens?: number;
  temperature?: number;
  responseFormat?: 'text' | 'json';
  /** Ignored by the built-in models; callers shared with the cloud path still pass it. */
  enableThinking?: boolean;
  /** Tags the call for the in-memory speed readout in Mera Protocol settings. */
  label?: InferenceLabel;
  /** The engine the prompt was built for; a phone only ever has one. */
  engine?: TextEngine;
}

export async function completeLocal(request: LocalCompleteRequest): Promise<string> {
  const result = await localInfer({
    systemPrompt: request.systemPrompt,
    prompt: request.prompt,
    maxTokens: request.maxTokens ?? 512,
    temperature: request.temperature ?? 0.3,
    responseFormat: request.responseFormat === 'json' ? 'json' : undefined,
    label: request.label,
    engine: request.engine,
  });
  return result.output.trim();
}

export interface LocalStructuredRequest {
  systemPrompt: string;
  prompt: string;
  /** The reply's shape; its root is an object or an array. */
  schema: JsonSchema;
  maxTokens?: number;
  temperature?: number;
  label?: InferenceLabel;
  /** The engine the prompt was built for; a phone only ever has one. */
  engine?: TextEngine;
}

/**
 * A JSON value fitting `schema`, from the on-device text engine: the entry point
 * for every on-device flow that needs structured output. Throws
 * StructuredOutputError when no reply fits after one retry, and passes engine
 * errors (busy, unavailable) through untouched so a queue job can defer.
 */
export function completeLocalStructured<T = unknown>(request: LocalStructuredRequest): Promise<T> {
  return inferStructured<T>({
    system: request.systemPrompt,
    prompt: request.prompt,
    schema: request.schema,
    maxTokens: request.maxTokens ?? 512,
    temperature: request.temperature ?? 0.3,
    label: request.label,
    engine: request.engine,
  });
}
