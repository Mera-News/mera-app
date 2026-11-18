import type { LlmTransport } from '@/lib/llm/cloudComplete';
import { gatewayTransport } from '@/lib/llm/gateway-transport';
import { createOpenAiTransport } from '@/lib/llm/openai-transport';
import { withAiHealth } from './ai-health';
import { ownAiOn, ownAiState } from './own-ai-state';
import { podConfig, podState } from './pod-state';

let memo: { baseUrl: string; model: string; key: string | null; transport: LlmTransport } | null = null;

function ownTransport(): LlmTransport {
  const c = ownAiState.get()!;
  if (!memo || memo.baseUrl !== c.baseUrl || memo.model !== c.model || memo.key !== c.key) {
    memo = { baseUrl: c.baseUrl, model: c.model, key: c.key, transport: withAiHealth(createOpenAiTransport({ baseUrl: c.baseUrl, model: c.model, apiKey: c.key ?? undefined })) };
  }
  return memo.transport;
}

let podMemo: { baseUrl: string; token: string; transport: LlmTransport } | null = null;

// The paired server ignores the model name and answers with its own.
function podTransport(): LlmTransport | null {
  const p = podConfig();
  if (!p) {
    // Unpaired: the old token is not kept in memory.
    podMemo = null;
    return null;
  }
  if (!podMemo || podMemo.baseUrl !== p.baseUrl || podMemo.token !== p.token) {
    podMemo = { baseUrl: p.baseUrl, token: p.token, transport: createOpenAiTransport({ baseUrl: `${p.baseUrl}/v1`, model: 'pod', apiKey: p.token }) };
  }
  return podMemo.transport;
}

// Until the item is read, a call waits and then picks a leg, so nothing reaches the gateway by default.
const pending = async (): Promise<LlmTransport> => {
  await Promise.all([ownAiState.hydrate(), podState.hydrate()]);
  return podTransport() ?? (ownAiOn() ? ownTransport() : gatewayTransport);
};

// In place only while the keychain cannot be read: usesGateway() then reads false and nothing goes out.
const failClosed: LlmTransport = {
  asyncJobs: false,
  complete: async (request, options) => (await pending()).complete(request, options),
  batch: async (calls, route, options) => (await pending()).batch(calls, route, options),
  async *chat(request) {
    yield* (await pending()).chat(request);
  },
};

export function currentTransport(): LlmTransport | undefined {
  // Read the mode now if it is not in memory, so the gateway's tools and jobs are offered from the
  // first call. Only a keychain that cannot be read leaves the fail-closed transport in place.
  if (!ownAiState.hydrateSync() || !podState.hydrateSync()) return failClosed;
  return podTransport() ?? (ownAiOn() ? ownTransport() : undefined);
}
