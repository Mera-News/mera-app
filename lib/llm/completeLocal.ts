// completeLocal — standalone local LLM completion.
// Extracted from LocalInferenceEngine.complete() after engine deletion in Phase 5.
// Calls infer() from mera-protocol-toolkit directly.

import { getModelState, infer as localInfer, initBaseModel } from '../mera-protocol-toolkit';
import { useMeraProtocolStore } from '../stores/mera-protocol-store';

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

  const output = result.output.replace(/<think>[\s\S]*?<\/think>/g, '').trim();

  return output;
}
