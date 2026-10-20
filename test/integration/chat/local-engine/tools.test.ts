// The on-device tool phase: a structured persona reply mapped to the executors, the tool call
// record's life, reasoning tags on the streamed flow, and the prompt the model reads. All through
// the real engine, toolkit (Qwen path: llama.rn under a json_schema grammar) and chat session.
import { fetchMessagesForConversation } from '@/lib/database/services/conversation-service';
import { addFact, getFacts } from '@/lib/database/services/fact-service';
import { useFloatingChatStore } from '@/lib/stores/floating-chat-store';
import '@/test/helpers';
import {
  installLlama,
  llamaCalls,
  resetChatModules,
  resetFileSystem,
  setProcessingMode,
} from '@/test/integration/chat/_helpers';
import {
  attachLocal,
  expectNothingLeftTheDevice,
  lastAssistant,
  local,
  personaAgent,
  personaReply,
  sampleLocal,
  saveFactReply,
  settle,
  turnDone,
} from './kit';

// Hoisted above the imports by babel-jest.
jest.mock('expo-file-system', () => require('@/test/integration/chat/_helpers/fs').fileSystemModule);

jest.setTimeout(30_000);

afterEach(settle);

beforeEach(async () => {
  resetChatModules();
  resetFileSystem();
  await setProcessingMode('on-device');
});

const stagedFacts = () => {
  const tc = lastAssistant()?.toolCalls?.find((t) => t.name === 'saveExtractedFacts');
  return (tc?.result as { pendingFacts?: { options: string[] }[] } | undefined)?.pendingFacts;
};
const schemaOf = (i: number) =>
  (llamaCalls()[i].params.response_format as { json_schema: { schema: { properties: Record<string, unknown> } } })
    .json_schema.schema;

describe('a structured persona turn', () => {
  beforeEach(() => installLlama([saveFactReply()]));

  it('status goes idle before the tool runs while turnBusy stays true; the record goes pending then done as a fresh object', async () => {
    const { engine } = await attachLocal(personaAgent());
    const watch = sampleLocal();

    engine.send('I live somewhere new');
    await turnDone();
    watch.stop();

    const toolPhase = watch.samples.find((s) => s.status === 'idle' && s.busy);
    expect(toolPhase).toBeDefined();
    expect(toolPhase!.tools.map((t) => t.status)).toEqual(['pending']);
    for (const s of watch.samples) {
      if (s.busy) expect(s.generating).toBe(true);
    }
    expect(watch.samples.filter((s) => s.busy).every((s) => s.held === 1)).toBe(true);

    const records = watch.samples.flatMap((s) => s.tools);
    const pending = records.find((t) => t.status === 'pending')!;
    const done = records.find((t) => t.status === 'done')!;
    expect(done.record).not.toBe(pending.record);
    expect(watch.samples.at(-1)).toMatchObject({ status: 'idle', busy: false, generating: false, held: 0 });
    expectNothingLeftTheDevice();
  });

  it('shows the reply whole and stages the fact on saveExtractedFacts: nothing written to the facts table', async () => {
    const { engine, conversationId } = await attachLocal(personaAgent());
    engine.send('I live somewhere new');
    await turnDone();
    await settle();

    // One structured completion under the persona schema; no <tool_call> text anywhere.
    expect(llamaCalls()).toHaveLength(1);
    expect(Object.keys(schemaOf(0).properties)).toEqual(['reply', 'save', 'delete', 'confirm', 'cancel']);
    expect(llamaCalls()[0].messages[0].content).not.toContain('<tool_call>');

    expect(lastAssistant()?.content).toBe('Did I get that right?');
    expect(lastAssistant()?.toolCalls?.map((t) => [t.name, t.status])).toEqual([['saveExtractedFacts', 'done']]);
    expect(lastAssistant()?.toolCalls?.[0].input).toEqual({
      extracted_user_information: [{ statement: 'Lives in <place>', questionnaire_attribute: 'location: residence' }],
    });
    expect(stagedFacts()?.[0].options).toEqual(['Lives in <place>']);
    expect(await getFacts()).toEqual([]);
    // The reply and its tool record are written once, as on cloud.
    const rows = await fetchMessagesForConversation(conversationId);
    expect(rows.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(rows[1].content).toBe('Did I get that right?');
  });
});

describe('the persona fields to the executors', () => {
  it('deletes only fact ids the context showed; an invented id is dropped', async () => {
    const kept = await addFact('Works as a <job>');
    const gone = await addFact('Lives in <old place>');
    installLlama([personaReply({ reply: 'Removed.', delete: [gone.id, 'invented-id'] })]);
    const { engine } = await attachLocal(personaAgent());

    engine.send('I moved, forget the old place');
    await turnDone();

    expect(llamaCalls()[0].messages[1].content).toContain(`[${gone.id}] Lives in <old place>`);
    expect(lastAssistant()?.toolCalls?.map((t) => [t.name, t.input])).toEqual([
      ['deleteUserFacts', { fact_ids: [gone.id] }],
    ]);
    expect((await getFacts()).map((f) => f.id)).toEqual([kept.id]);
  });

  it('with nothing waiting, confirm and cancel do nothing; cancel discards a waiting change', async () => {
    installLlama([personaReply({ confirm: true, cancel: true })]);
    const { engine } = await attachLocal(personaAgent());
    engine.send('yes');
    await turnDone();
    expect(lastAssistant()?.toolCalls).toEqual([]);

    useFloatingChatStore.getState().setProposal({
      id: 'p1',
      explanation: 'Hide <topic>.',
      expectedEffects: 'Less of it.',
      actions: [{ type: 'add_suppression', pattern: '<topic>', strength: 0.9 } as never],
    });
    installLlama([personaReply({ cancel: true })]);
    engine.send('no thanks');
    await turnDone();
    expect(llamaCalls()[0].messages[1].content).toContain("A change is waiting for the user's yes or no: Hide <topic>.");
    expect(lastAssistant()?.toolCalls?.map((t) => t.name)).toEqual(['cancelProposal']);
    expect(useFloatingChatStore.getState().proposal).toBeNull();
  });

  it('onboarding has no delete field, and its context carries the questions to ask', async () => {
    installLlama([personaReply({ reply: 'Where do you live?' })]);
    const { engine } = await attachLocal(personaAgent('ONBOARDING'));
    engine.send('hi');
    await turnDone();

    expect(Object.keys(schemaOf(0).properties)).toEqual(['reply', 'save', 'confirm', 'cancel']);
    expect(llamaCalls()[0].messages[1].content).toContain('Questions you can ask');
    expect(lastAssistant()?.content).toBe('Where do you live?');
  });

  it('a reply that never fits the schema fails the turn after one retry; nothing runs', async () => {
    installLlama(['Sure, I can help with that.']);
    const { engine } = await attachLocal(personaAgent());
    engine.send('hi');
    await turnDone();

    expect(llamaCalls()).toHaveLength(2);
    expect(local().error).toBe('Inference failed: On-device reply did not match its schema');
    expect(lastAssistant()?.toolCalls ?? []).toEqual([]);
    expect(local().turnBusy).toBe(false);
  });
});

describe('reasoning tags on the streamed flow', () => {
  it('a <think> block never shows', async () => {
    installLlama(['<thi', 'nk>planning</th', 'ink>The ', 'guide ', 'explains it.']);
    const { engine } = await attachLocal();
    const watch = sampleLocal();

    engine.send('what is this card?');
    await turnDone();
    watch.stop();

    expect(lastAssistant()?.content).toBe('The guide explains it.');
    expect(watch.samples.every((s) => !s.text.includes('think') && !s.text.includes('planning'))).toBe(true);
  });

  it('a stray </think> does not swallow the reply', async () => {
    installLlama(['It is the ', 'feed.</think>', ' It updates hourly.']);
    const { engine } = await attachLocal();

    engine.send('what is this?');
    await turnDone();

    expect(lastAssistant()?.content).toBe('It is the feed. It updates hourly.');
  });
});

describe('the prompt', () => {
  it('renders the history as User:/Mera: lines after the context, ending on the last user turn', async () => {
    installLlama((call) =>
      llamaCalls().indexOf(call) === 0 ? [saveFactReply()] : [personaReply({ reply: 'Anything else?' })],
    );
    const { engine } = await attachLocal(personaAgent());

    engine.send('I live somewhere new');
    await turnDone();
    engine.send('thanks');
    await turnDone();

    const prompt = llamaCalls()[1].messages[1].content;
    const conversation = prompt.slice(prompt.indexOf('Conversation:\n') + 'Conversation:\n'.length).split('\n');
    expect(conversation).toEqual(['User: I live somewhere new', 'Mera: Did I get that right?', 'User: thanks']);
    expect(prompt.indexOf('Known facts:')).toBeLessThan(prompt.indexOf('Conversation:'));
  });

  it('a hidden turn is a user turn to the model and never shown or written', async () => {
    installLlama(['Understood.']);
    const { engine, conversationId } = await attachLocal();

    engine.sendHidden('The reader discarded the topics.');
    await turnDone();
    await settle();

    const prompt = llamaCalls()[0].messages[1].content;
    expect(prompt.endsWith('User: The reader discarded the topics.')).toBe(true);
    expect(local().messages[0]).toMatchObject({ role: 'user', hidden: true });
    const rows = await fetchMessagesForConversation(conversationId);
    expect(rows.map((m) => m.role)).toEqual(['assistant']);
  });
});
