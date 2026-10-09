// Shared kit for the on-device chat engine seam tests. Not a test file (Jest matches *.test.ts only).
//
// A turn is driven the way the app drives it: createConversation, attachChatSession, engine.send,
// against the REAL toolkit, inference lock and inference queue with only llama.rn (scripted) and
// expo-file-system (in-memory) faked. "Busy" is the whole-turn signal (`turnBusy`), never `status`.
import { activeHolds } from '@/lib/app-restart';
import { attachChatSession } from '@/lib/chat-session/chat-session';
import { useLocalChatStore } from '@/lib/chat-session/local-chat-store';
import { createConversation } from '@/lib/database/services/conversation-service';
import { PersonaUpdateAgent } from '@/lib/llm/agents/PersonaUpdateAgent';
import { attestationRequests, FIXTURE_ACCOUNT, gatewayCalls } from '@/test/helpers';
import { useChatPhaseStore } from '@/lib/llm/chat-phase-store';
import { useFloatingChatStore } from '@/lib/stores/floating-chat-store';
import { until } from '@/test/integration/chat/_helpers';

export const local = () => useLocalChatStore.getState();
export const personaAgent = () => new PersonaUpdateAgent(FIXTURE_ACCOUNT.userId, 'CONFIG');

export async function attachLocal(agent = personaAgent(), persistedIds: string[] = []) {
  const conversationId = await createConversation('CONFIG' as never);
  const engine = attachChatSession({ conversationId, kind: 'local', agent, persistedIds });
  return { conversationId, engine };
}

/** Waits for the whole turn (stream AND tools) to end. `engine.send` marks the turn busy
 *  synchronously, so call this right after it. */
export async function turnDone(ms = 15_000): Promise<void> {
  await until(() => !local().turnBusy, ms, 'turn end');
}

/** One tool call in the on-device wire format: JSON inside <tool_call> tags. */
export const localToolCall = (name: string, args: Record<string, unknown> = {}): string =>
  `<tool_call>${JSON.stringify({ name, arguments: args })}</tool_call>`;

/** Splits text into tokens of `size` characters, so a tag lands across several tokens. */
export function tokensOf(text: string, size = 3): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

export const saveFactsCall = (statement = 'Lives in Porto') =>
  localToolCall('saveExtractedFacts', { extracted_user_information: [{ statement }] });

export const streamHolds = (): number => activeHolds().filter((h) => h === 'chat-stream').length;

/** On-device mode never reaches the cloud model: no gateway call, no attestation fetch. */
export function expectNothingLeftTheDevice(): void {
  expect(gatewayCalls()).toHaveLength(0);
  expect(attestationRequests()).toBe(0);
}

/** For an afterEach: lets any queued write (message rows, the session's persistence) land. */
export const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 50));

/** The assistant bubble of the turn in flight (or the last one). */
export const lastAssistant = () => local().messages.filter((m) => m.role === 'assistant').at(-1);

export interface LocalSample {
  status: string;
  busy: boolean;
  generating: boolean;
  held: number;
  text: string;
  /** Tool call records on the assistant bubble, in order. */
  tools: { status: string; record: object }[];
}

/** Everything the chat session mirrors, sampled on every on-device store change (the session's
 *  own subscriber is registered first, so each sample is taken after the session synced). */
export function sampleLocal() {
  const samples: LocalSample[] = [];
  const unsub = useLocalChatStore.subscribe((s) => {
    const last = s.messages.filter((m) => m.role === 'assistant').at(-1);
    samples.push({
      status: s.status,
      busy: s.turnBusy,
      generating: useFloatingChatStore.getState().isGenerating,
      held: streamHolds(),
      text: last?.content ?? '',
      tools: (last?.toolCalls ?? []).map((t) => ({ status: t.status, record: t })),
    });
  });
  return { samples, stop: unsub };
}

/** The wait line's views in order, repeats collapsed: `deviceLoading`, ..., `released`. */
export function samplePhases() {
  const seen: string[] = [];
  const unsub = useChatPhaseStore.subscribe((s) => {
    const label = s.view.kind === 'phase' ? s.view.id : s.view.kind;
    if (seen.at(-1) !== label) seen.push(label);
  });
  return { seen, stop: unsub };
}
