// Persona chat on route 'kev' through the REAL engine, toolkit and chat session: Kev's decide()
// (the llama lock, Kev made resident) and the built-in model's structured call run on the app's own
// ports; only llama.rn (scripted Kev) and the built-in model's native module are faked. Covers what
// the agent-seam tests in on-device/kev-flows cannot: the ask's chip data surviving into the next
// turn and into the stored message, the decide/write calls never nesting the lock, Kev staying
// resident across turns, and the staged delete's Remove tap removing exactly once.
import { confirmPendingDelete } from '@/components/custom/floating-chat/fact-choice-actions';
import { deriveThreadItems } from '@/components/custom/floating-chat/deriveThreadItems';
import { fetchMessagesForConversation } from '@/lib/database/services/conversation-service';
import { addFact, getFacts } from '@/lib/database/services/fact-service';
import { PersonaOnDeviceAgent } from '@/lib/llm/agents/on-device/PersonaOnDeviceAgent';
import { useFloatingChatStore } from '@/lib/stores/floating-chat-store';
import { FIXTURE_ACCOUNT } from '@/test/helpers';
import { decideCalls, installDecide, llamaLoads, llamaReleases, type DecideScript } from '@/test/helpers/llama';
import { installOnDeviceLlm, onDeviceLlmCalls } from '@/test/helpers/on-device-llm';
import { installLlama, resetChatModules, resetFileSystem, setProcessingMode } from '@/test/integration/chat/_helpers';
import { attachLocal, expectNothingLeftTheDevice, lastAssistant, local, settle, turnDone } from './kit';

jest.mock('expo-file-system', () => require('@/test/integration/chat/_helpers/fs').fileSystemModule);
jest.mock('@/modules/mera-on-device-llm', () => require('@/test/helpers/on-device-llm').onDeviceLlmModule);

jest.setTimeout(30_000);

afterEach(settle);

let clock: jest.SpyInstance;
beforeEach(async () => {
  resetChatModules();
  resetFileSystem();
  await setProcessingMode('on-device');
  installLlama(() => ({ tokens: [], error: 'llama.rn completion on Kev' }));
  installOnDeviceLlm({ reply: JSON.stringify({ reply: 'Tap Remove to confirm, or Keep.' }) });
  // Rows written in one millisecond sort by id; a moving clock keeps the stored order real.
  let now = Date.now();
  clock = jest.spyOn(Date, 'now').mockImplementation(() => ++now);
});
afterEach(() => clock.mockRestore());

// The app's ports except `t`: the dictionaries get the kev keys at the Verify splice, so the
// labels here are the keys themselves.
const kevAgent = () => new PersonaOnDeviceAgent(FIXTURE_ACCOUNT.userId, 'CONFIG', { route: 'kev', ports: { t: (k) => k } });

/** Kev's answer per question: an unsure intent, then the fact whose text names the old place. */
function scriptKev(): void {
  installDecide((call): DecideScript => {
    const questions = call.request.questions as Record<string, { criteria: Record<string, string> }>;
    if (questions.intent) return { choices: { intent: { remove_fact: 0.45, correct_fact: 0.4, question_or_chat: 0.15 } } };
    const criteria = questions.target.criteria;
    const key = Object.keys(criteria).find((k) => criteria[k].includes('<old place>'))!;
    return { choices: { target: Object.fromEntries(Object.keys(criteria).map((k) => [k, k === key ? 0.9 : 0.1 / (Object.keys(criteria).length - 1)])) } };
  });
}

it('unsure, the chips, a tap, the staged card and Remove: one decide per turn, Kev loaded once, the fact removed once', async () => {
  const kept = await addFact('Works as a <job>');
  const gone = await addFact('Lives in <old place>');
  scriptKev();
  const { engine, conversationId } = await attachLocal(kevAgent());

  // Turn 1: Kev is unsure, so Mera asks. Nothing is staged, and the built-in model writes nothing.
  engine.send('forget that one');
  await turnDone();
  const ask = lastAssistant()!;
  expect(ask.content).toBe('kevChat.askIntent');
  expect(ask.toolCalls?.map((t) => [t.name, t.status, t.result])).toEqual([['ask_choice', 'done', { awaiting: 'user' }]]);
  expect(ask.toolCalls?.[0].input).toMatchObject({
    options: ['kevChat.persona.remove', 'kevChat.persona.correct', 'kevChat.persona.chat'],
    readings: ['remove_fact', 'correct_fact', 'question_or_chat'],
    somethingElse: true,
  });
  expect(onDeviceLlmCalls()).toHaveLength(0);
  const chips = deriveThreadItems({ live: local().messages, history: [], introMessage: null, isStreaming: false, earlierConversationLabel: '' }).find(
    (i) => i.kind === 'ask-choice-card',
  );
  expect(chips).toMatchObject({ somethingElse: true, saveAll: null });

  // The stored message keeps the readings, so the thread a resume shows can still map a tap.
  await settle();
  const stored = (await fetchMessagesForConversation(conversationId)).find((m) => m.id === ask.id);
  expect(stored?.toolCalls?.[0].input).toMatchObject({ readings: ['remove_fact', 'correct_fact', 'question_or_chat'] });

  // Turn 2: the tap. No second intent question; one target question, then the Remove / Keep card.
  engine.send('kevChat.persona.remove');
  await turnDone();
  expect(decideCalls().map((c) => Object.keys(c.request.questions))).toEqual([['intent'], ['target']]);
  const card = lastAssistant()!;
  expect(card.toolCalls?.map((t) => [t.name, t.status])).toEqual([['deleteUserFacts', 'done']]);
  const staged = card.toolCalls![0].result as Record<string, unknown>;
  expect(staged).toMatchObject({ pendingFactIds: [gone.id], pendingStatements: ['Lives in <old place>'] });
  expect((await getFacts()).map((f) => f.id).sort()).toEqual([kept.id, gone.id].sort());
  // The writer ran once, after Kev, never inside its lock (a nested lock would hang this turn).
  expect(onDeviceLlmCalls()).toHaveLength(1);
  // Kev was loaded once and stayed resident: no swap, no reload.
  expect(llamaLoads()).toEqual(['mera-kev-4b']);
  expect(llamaReleases()).toBe(0);

  // Remove on the card removes exactly the listed fact, and the card turns into "removed".
  const resultKey = `${card.id}::0`;
  await confirmPendingDelete({ resultKey, baseResult: staged, factIds: [gone.id] }, 'remove');
  expect((await getFacts()).map((f) => f.id)).toEqual([kept.id]);
  expect(useFloatingChatStore.getState().toolCallResults[resultKey]).toMatchObject({ deleteOutcome: 'removed', deletedCount: 1 });
  const after = deriveThreadItems({
    live: local().messages,
    history: [],
    introMessage: null,
    isStreaming: false,
    earlierConversationLabel: '',
    toolCallResults: useFloatingChatStore.getState().toolCallResults,
  }).filter((i) => i.kind === 'fact-card');
  expect(after).toEqual([expect.objectContaining({ action: 'deleted' })]);
  expectNothingLeftTheDevice();
});
