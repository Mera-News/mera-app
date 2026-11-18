import type { LlmTransport } from '@/lib/llm/cloudComplete';
import { gatewayTransport } from '@/lib/llm/gateway-transport';
import { createOpenAiTransport } from '@/lib/llm/openai-transport';
import { ownAiOn, ownAiState } from './own-ai-state';

let memo: { baseUrl: string; model: string; key: string | null; transport: LlmTransport } | null = null;

function ownTransport(): LlmTransport {
  const c = ownAiState.get()!;
  if (!memo || memo.baseUrl !== c.baseUrl || memo.model !== c.model || memo.key !== c.key) {
    memo = { baseUrl: c.baseUrl, model: c.model, key: c.key, transport: createOpenAiTransport({ baseUrl: c.baseUrl, model: c.model, apiKey: c.key ?? undefined }) };
  }
  return memo.transport;
}

// Until the item is read, a call waits and then picks a leg, so nothing reaches the gateway by default.
const pending = async (): Promise<LlmTransport> => {
  await ownAiState.hydrate();
  return ownAiOn() ? ownTransport() : gatewayTransport;
};

// While this is in place usesGateway() reads false, so a prewarm or web search in the first moments after
// a cold start is skipped; hydration finishes before db-ready, so no scheduled task sees it.
const failClosed: LlmTransport = {
  asyncJobs: false,
  complete: async (request, options) => (await pending()).complete(request, options),
  batch: async (calls, route, options) => (await pending()).batch(calls, route, options),
  async *chat(request) {
    yield* (await pending()).chat(request);
  },
};

export function currentTransport(): LlmTransport | undefined {
  if (!ownAiState.isHydrated()) return failClosed;
  return ownAiOn() ? ownTransport() : undefined;
}
