// Shared kit for the E2EE tool-step seam tests. Not a test file (Jest matches *.test.ts only).
//
// Everything runs against the real gateway mock (real E2EE both ways), real auth, the real limiter,
// the real stores and the in-memory DB. A turn is driven the way the app drives it:
// createConversation, attachChatSession, engine.send. "Busy" is the whole-turn signal
// (agentTurnState.turnActive), never `status`: the forced pass outlives `status`.
import { attachChatSession } from '@/lib/chat-session/chat-session';
import { createConversation } from '@/lib/database/services/conversation-service';
import type { SseEvent } from '@/lib/llm/cloudComplete';
import type { IAgent } from '@/lib/llm/types';
import { useCloudChatStore } from '@/lib/stores/cloud-chat-store';

export const cloud = () => useCloudChatStore.getState();
export const busy = (): boolean => cloud().agentTurnState?.turnActive === true;

export async function collect(gen: AsyncGenerator<SseEvent>): Promise<SseEvent[]> {
  const out: SseEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

export const textOf = (events: SseEvent[]): string =>
  events.flatMap((e) => (e.type === 'text-delta' ? [e.delta] : [])).join('');

/** One harmless tool, declared both for the turn and for the forced pass. */
export const NOTE_TOOL = {
  type: 'function' as const,
  function: {
    name: 'recordNote',
    description: 'Records a note. A call with no arguments changes nothing.',
    parameters: { type: 'object' as const, properties: { note: { type: 'string', description: 'The note.' } } },
  },
};

/**
 * A plain IAgent the engine drives through the public API. Its id does not start with `persona-`,
 * so the engine runs it through `runSingleShot` (the only path that owns the single-shot forced
 * pass). Its one tool is a no-op that records every call it is asked to run.
 */
export function forcedPassAgent(executed: { name: string; input: unknown }[]): IAgent {
  return {
    id: 'forced-pass-test-agent',
    buildSystemPrompt: async () => 'You are the forced pass test agent.',
    getToolDefinitions: () => [NOTE_TOOL],
    getForcedExtractionTools: () => [NOTE_TOOL],
    executeTool: async (name, input) => {
      executed.push({ name, input });
      return { result: { recorded: true } };
    },
  };
}

export async function attachCloud(agent: IAgent) {
  const conversationId = await createConversation('CONFIG' as never);
  const engine = attachChatSession({ conversationId, kind: 'cloud', agent, persistedIds: [] });
  return { conversationId, engine };
}

/** For an afterEach: lets the frame renders the engine queued fire inside the test (real timers). */
export const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 100));
