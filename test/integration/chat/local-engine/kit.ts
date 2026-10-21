// Shared kit for the on-device chat engine seam tests. Not a test file (Jest matches *.test.ts only).
//
// A turn is driven the way the app drives it: createConversation, attachChatSession, engine.send,
// against the REAL toolkit, inference lock and inference queue with only llama.rn (scripted) and
// expo-file-system (in-memory) faked. "Busy" is the whole-turn signal (`turnBusy`), never `status`.
//
// The default agent is on-device tutorial help, the one flow that streams plain text, so the
// engine's streaming, stop and lifecycle behaviour is observed token by token. Persona turns are
// structured: the scripted completion answers with the JSON the schema asks for.
import { activeHolds } from '@/lib/app-restart';
import { attachChatSession } from '@/lib/chat-session/chat-session';
import { useLocalChatStore } from '@/lib/chat-session/local-chat-store';
import { createConversation } from '@/lib/database/services/conversation-service';
import { PersonaOnDeviceAgent } from '@/lib/llm/agents/on-device/PersonaOnDeviceAgent';
import { TutorialHelpOnDeviceAgent } from '@/lib/llm/agents/on-device/TutorialHelpOnDeviceAgent';
import type { OnDeviceAgent } from '@/lib/llm/agents/on-device/types';
import { attestationRequests, FIXTURE_ACCOUNT, gatewayCalls } from '@/test/helpers';
import { useChatPhaseStore } from '@/lib/llm/chat-phase-store';
import { useFloatingChatStore } from '@/lib/stores/floating-chat-store';
import { until } from '@/test/integration/chat/_helpers';

export const local = () => useLocalChatStore.getState();
export const tutorialAgent = () => new TutorialHelpOnDeviceAgent(FIXTURE_ACCOUNT.userId, null);
/** The single built-in call (route 'single'): these suites script its one structured reply. Kev turns are in on-device/kev-flows. */
export const personaAgent = (surface: 'ONBOARDING' | 'CONFIG' = 'CONFIG') =>
  new PersonaOnDeviceAgent(FIXTURE_ACCOUNT.userId, surface, { route: 'single' });

export async function attachLocal(agent: OnDeviceAgent = tutorialAgent(), persistedIds: string[] = []) {
  const conversationId = await createConversation('CONFIG' as never);
  const engine = attachChatSession({ conversationId, kind: 'local', agent, persistedIds });
  return { conversationId, engine };
}

/** Waits for the whole turn (model AND tools) to end. `engine.send` marks the turn busy
 *  synchronously, so call this right after it. */
export async function turnDone(ms = 15_000): Promise<void> {
  await until(() => !local().turnBusy, ms, 'turn end');
}

/** A persona reply as the structured completion returns it (the persona-chat schema). */
export const personaReply = (fields: {
  reply?: string;
  save?: { statement: string; attribute: string }[];
  delete?: string[];
  confirm?: boolean;
  cancel?: boolean;
}): string => JSON.stringify({ reply: 'Got it.', save: [], ...fields });

/** A persona reply offering one fact. */
export const saveFactReply = (statement = 'Lives in <place>') =>
  personaReply({ reply: 'Did I get that right?', save: [{ statement, attribute: 'location: residence' }] });

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
