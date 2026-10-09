// Shared kit for the cloud chat engine seam tests. Not a test file (Jest matches *.test.ts only).
//
// A turn is driven the way the app drives it: createConversation, attachChatSession, engine.send.
// "Busy" is the whole-turn signal (agentTurnState.turnActive), never `status`.
import { attachChatSession } from '@/lib/chat-session/chat-session';
import { createConversation } from '@/lib/database/services/conversation-service';
import { PersonaUpdateAgent } from '@/lib/llm/agents/PersonaUpdateAgent';
import type { IAgent } from '@/lib/llm/types';
import { ArticleFeedbackAgent } from '@/lib/llm/agents/ArticleFeedbackAgent';
import { activeHolds } from '@/lib/app-restart';
import { useCloudChatStore } from '@/lib/stores/cloud-chat-store';
import { useFloatingChatStore } from '@/lib/stores/floating-chat-store';
import { FIXTURE_ACCOUNT } from '@/test/helpers';
import { until } from '@/test/integration/chat/_helpers';

export const cloud = () => useCloudChatStore.getState();
export const busy = (): boolean => cloud().agentTurnState?.turnActive === true;
export const idle = (): boolean => !busy() && cloud().status === 'idle';

export const personaAgent = () => new PersonaUpdateAgent(FIXTURE_ACCOUNT.userId, 'CONFIG');
/** Built the way agent-registry builds it for an `article-suggestion` context. */
export const articleAgent = () => new ArticleFeedbackAgent(FIXTURE_ACCOUNT.userId, { articleId: 'art-1', suggestionId: 'sug-1' }, null);

export async function attachCloud(agent: IAgent = personaAgent(), persistedIds: string[] = []) {
  const conversationId = await createConversation('CONFIG' as never);
  const engine = attachChatSession({ conversationId, kind: 'cloud', agent, persistedIds });
  return { conversationId, engine };
}

/** Waits for the whole turn (not just the text) to end. `engine.send` marks the turn busy
 *  synchronously, so call this right after it. */
export async function turnDone(ms = 30_000): Promise<void> {
  await until(idle, ms, 'turn end');
}

export const assistantTexts = () =>
  cloud()
    .messages.filter((m) => m.role === 'assistant')
    .map((m) => [m.id, m.content] as const);

/** Everything the chat session mirrors, sampled on every cloud-store change (the session's own
 *  subscriber is registered first, so each sample is taken after the session synced). */
export function sampleSession() {
  const samples: { generating: boolean; busy: boolean; streaming: boolean; held: number; ack: string }[] = [];
  const unsub = useCloudChatStore.subscribe((s) =>
    samples.push({
      generating: useFloatingChatStore.getState().isGenerating,
      busy: s.agentTurnState?.turnActive === true,
      streaming: s.status === 'streaming',
      held: activeHolds().filter((h) => h === 'chat-stream').length,
      ack: s.messages.find((m) => m.id.endsWith('-ack'))?.content ?? '',
    }),
  );
  return { samples, stop: unsub };
}

export const streamHolds = (): number => activeHolds().filter((h) => h === 'chat-stream').length;

/** For an afterEach: lets the frame renders the engine queued (rAF is a 0ms timeout) fire inside the test. */
export const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 100));
