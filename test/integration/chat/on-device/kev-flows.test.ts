/* eslint-disable @typescript-eslint/no-require-imports */
// The three on-device chat flows on "Kev decides, the built-in model writes" (D38-D41), at the
// agent seam: the real agents, executors, stores, database and thread derivation, with Kev and the
// writer as injected ports (the app's are the toolkit's decide and the built-in model). Each turn
// runs the reply's tool calls through executeTool and applies their side effects the way the
// on-device engine does.
import { deriveThreadItems } from '@/components/custom/floating-chat/deriveThreadItems';
import { addFact, getFacts } from '@/lib/database/services/fact-service';
import { ArticleFeedbackOnDeviceAgent } from '@/lib/llm/agents/on-device/ArticleFeedbackOnDeviceAgent';
import { FollowStoryOnDeviceAgent } from '@/lib/llm/agents/on-device/FollowStoryOnDeviceAgent';
import { PersonaOnDeviceAgent } from '@/lib/llm/agents/on-device/PersonaOnDeviceAgent';
import type { OnDeviceAgentOptions } from '@/lib/llm/agents/on-device/run';
import type { OnDeviceAgent } from '@/lib/llm/agents/on-device/types';
import type { ConversationMessage, StagedProposal, ToolCallRecord } from '@/lib/llm/types';
import type { KevPorts, KevTurnResult } from '@/lib/news-harness/on-device/kev';
import { useFloatingChatStore } from '@/lib/stores/floating-chat-store';
import { FIXTURE_ACCOUNT } from '@/test/helpers';
import { installOnDeviceLlm, onDeviceLlmCalls } from '@/test/helpers/on-device-llm';
import { resetFileSystem, setProcessingMode } from '@/test/integration/chat/_helpers';
import { resetAgentWorld, seedFactWithTopics, seedSuggestion } from '@/test/integration/chat/tools/agents/agents-kit';

jest.mock('expo-file-system', () => require('@/test/integration/chat/_helpers/fs').fileSystemModule);
jest.mock('@/modules/mera-on-device-llm', () => require('@/test/helpers/on-device-llm').onDeviceLlmModule);

jest.setTimeout(30_000);

const USER = FIXTURE_ACCOUNT.userId;

// --- Fake Kev and writer ------------------------------------------------------------------------

type Probabilities = Record<string, number>;
interface DecideRequest {
  state: unknown;
  questions: Record<string, { criteria: Record<string, string | null> }>;
}

let decideRequests: DecideRequest[];
let kevScript: Record<string, Probabilities | ((req: DecideRequest) => Probabilities)>;
let writes: { system: string; prompt: string; schema: { properties: Record<string, unknown> } }[];
let writerReply: Record<string, unknown> | Error;

/** Kev answers each question from the script; an unscripted question throws, as a broken Kev would. */
const decide = (async (request: DecideRequest) => {
  decideRequests.push(request);
  const answers: Record<string, unknown> = {};
  for (const id of Object.keys(request.questions)) {
    const entry = kevScript[id];
    if (!entry) throw new Error(`unscripted question ${id}`);
    const probabilities = typeof entry === 'function' ? entry(request) : entry;
    const choice = Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0][0];
    answers[id] = { type: 'choice', choice, probabilities, confidence: 0.5 };
  }
  return { model: 'fake', answers, usage: { input_tokens: 1, output_tokens: 0 } };
}) as unknown as KevPorts['decide'];

const ports: KevPorts = {
  decide,
  write: (async (system: string, prompt: string, schema: never) => {
    writes.push({ system, prompt, schema });
    if (writerReply instanceof Error) throw writerReply;
    return writerReply;
  }) as KevPorts['write'],
  budget: async () => 3000,
  t: (key) => key,
};
const kevRoute: OnDeviceAgentOptions = { route: 'kev', ports };

beforeEach(async () => {
  resetFileSystem();
  await resetAgentWorld();
  await setProcessingMode('on-device');
  installOnDeviceLlm();
  decideRequests = [];
  kevScript = {};
  writes = [];
  writerReply = { reply: 'Written.' };
});

// --- A turn, the way the on-device engine runs it ------------------------------------------------

let seq = 0;
async function turn(agent: OnDeviceAgent, thread: ConversationMessage[], text: string) {
  thread.push({ id: `u-${seq++}`, role: 'user', content: text });
  const out = (await agent.respond(thread, { signal: new AbortController().signal, onText: () => {} })) as KevTurnResult;
  const toolCalls: ToolCallRecord[] = [];
  for (const [i, call] of out.calls.entries()) {
    const { result, sideEffects } = await agent.executeTool(call.name, call.input);
    if (sideEffects?.proposal) useFloatingChatStore.getState().setProposal(sideEffects.proposal);
    if (sideEffects?.proposalResolved) useFloatingChatStore.getState().resolveProposal(sideEffects.proposalResolved);
    toolCalls.push({ id: `tc-${seq}-${i}`, name: call.name, input: call.input, result, status: 'done' });
  }
  thread.push({ id: `a-${seq++}`, role: 'assistant', content: out.reply, toolCalls });
  return { out, toolCalls, names: toolCalls.map((t) => t.name) };
}

const proposal = (): StagedProposal | null => useFloatingChatStore.getState().proposal;
const cards = (thread: ConversationMessage[]) =>
  deriveThreadItems({ live: thread, history: [], introMessage: null, isStreaming: false, earlierConversationLabel: '' }).filter(
    (i) => i.kind === 'fact-card' || i.kind === 'ask-choice-card',
  );
const offeredIntents = (i = 0) => Object.keys(decideRequests[i].questions.intent.criteria);

/** A waiting change, staged the way an executor stages one. */
function stageChange(chooseOne = false): StagedProposal {
  const staged: StagedProposal = {
    id: `p-${seq++}`,
    explanation: 'Add a topic',
    expectedEffects: 'More stories.',
    actions: chooseOne
      ? [
          { type: 'set_topic_weight', topicText: 'a', delta: -0.3 },
          { type: 'retire_topic', topicText: 'a' },
        ]
      : [{ type: 'set_topic_weight', topicText: 'a', delta: 0.3 }],
    ...(chooseOne ? { chooseOne: true } : {}),
  } as StagedProposal;
  useFloatingChatStore.getState().setProposal(staged);
  return staged;
}

// ================================================================================================
// Persona chat
// ================================================================================================

describe('persona chat on Kev', () => {
  const persona = (opts: OnDeviceAgentOptions = kevRoute) => new PersonaOnDeviceAgent(USER, 'CONFIG', opts);

  it('share_new_fact: the writer words the facts, a restated known fact is dropped, the fact card is staged', async () => {
    await addFact('Lives in <town>');
    kevScript = { intent: { share_new_fact: 0.9, question_or_chat: 0.1 } };
    writerReply = {
      reply: 'Is this right?',
      facts: [
        { statement: 'Works as a <job>', attribute: 'profession: job' },
        { statement: 'lives in <town>.', attribute: 'location: residence' },
      ],
    };
    const thread: ConversationMessage[] = [];
    const { out, toolCalls } = await turn(persona(), thread, 'I work as a <job> and live in <town>');

    expect(decideRequests).toHaveLength(1);
    expect(out.reply).toBe('Is this right?');
    expect(toolCalls.map((t) => [t.name, t.input])).toEqual([
      ['saveExtractedFacts', { extracted_user_information: [{ statement: 'Works as a <job>', questionnaire_attribute: 'profession: job' }] }],
    ]);
    expect((toolCalls[0].result as { pendingFacts: { options: string[] }[] }).pendingFacts.map((g) => g.options)).toEqual([
      ['Works as a <job>'],
    ]);
    // Staged only: nothing saved until a tap.
    expect((await getFacts()).map((f) => f.statement)).toEqual(['Lives in <town>']);
    // The writer reads Kev's decision as plain words, never JSON, after the identity line.
    expect(writes[0].system.startsWith('You are Mera, made by Mera.')).toBe(true);
    expect(writes[0].prompt).toContain('What the user wants: shares something new about themselves');
    expect(writes[0].prompt).not.toMatch(/[{}]/);
    expect(Object.keys(writes[0].schema.properties).sort()).toEqual(['facts', 'reply']);
    expect(out.trace).toMatchObject({ intent: 'share_new_fact', source: 'kev', asked: false, wrote: true });
  });

  it('remove_fact: a second Kev question picks the fact; the Remove / Keep card is staged and nothing is deleted', async () => {
    const keep = await addFact('Works as a <job>');
    const gone = await addFact('Follows <sport>');
    const goneKey = (await getFacts())[0].id === gone.id ? 'f1' : 'f2';
    kevScript = {
      intent: { remove_fact: 0.92, correct_fact: 0.05, question_or_chat: 0.03 },
      target: { f1: goneKey === 'f1' ? 0.88 : 0.07, f2: goneKey === 'f2' ? 0.88 : 0.07, none: 0.05 },
    };
    writerReply = { reply: 'Tap Remove to confirm.' };
    const thread: ConversationMessage[] = [];
    const { toolCalls } = await turn(persona(), thread, 'forget the <sport> one');

    expect(decideRequests).toHaveLength(2);
    // f1..fN follow the shown (newest first) order, never the real ids.
    const shown = (await getFacts()).map((f) => f.statement);
    expect(decideRequests[1].questions.target.criteria).toEqual({ f1: shown[0], f2: shown[1], none: 'none of these facts' });
    expect(toolCalls.map((t) => [t.name, t.input])).toEqual([['deleteUserFacts', { fact_ids: [gone.id] }]]);
    expect(toolCalls[0].result).toMatchObject({ pendingFactIds: [gone.id], pendingStatements: ['Follows <sport>'] });
    expect((await getFacts()).map((f) => f.id).sort()).toEqual([keep.id, gone.id].sort());
    expect(cards(thread)).toEqual([
      expect.objectContaining({ kind: 'fact-card', action: 'deletePending', statements: ['Follows <sport>'], pendingDelete: expect.anything() }),
    ]);
    expect(writes[0].prompt).toContain('The fact they mean: "Follows <sport>"');
  });

  it('remove_fact: every fact at or above 0.25 goes on the one card', async () => {
    const a = await addFact('Follows <sport one>');
    const b = await addFact('Follows <sport two>');
    kevScript = { intent: { remove_fact: 0.95, question_or_chat: 0.05 }, target: { f1: 0.48, f2: 0.47, none: 0.05 } };
    const { toolCalls } = await turn(persona(), [], 'remove both sports');
    const shown = (await getFacts()).map((f) => f.id);
    expect(toolCalls[0].input).toEqual({ fact_ids: shown });
    expect(shown.sort()).toEqual([a.id, b.id].sort());
  });

  it('remove_fact with no fact on file that matches: says so, stages nothing', async () => {
    await addFact('Works as a <job>');
    kevScript = { intent: { remove_fact: 0.9, question_or_chat: 0.1 }, target: { f1: 0.05, none: 0.95 } };
    writerReply = { reply: 'I could not find that.' };
    const { out, names } = await turn(persona(), [], 'remove my cat');
    expect(names).toEqual([]);
    expect(out.reply).toBe('I could not find that.');
    expect(writes[0].system).toContain('No saved fact matches');
  });

  it('correct_fact: the new statement replaces the old fact on tap; nothing is removed by the turn', async () => {
    await addFact('Works as a <job>');
    const old = await addFact('Lives in <old town>', undefined, { attribute: 'location: residence' });
    const oldKey = (await getFacts())[0].id === old.id ? 'f1' : 'f2';
    kevScript = {
      intent: { correct_fact: 0.85, share_new_fact: 0.15 },
      target: { f1: oldKey === 'f1' ? 0.9 : 0.05, f2: oldKey === 'f2' ? 0.9 : 0.05, none: 0.05 },
    };
    writerReply = { statement: 'Lives in <new town>', reply: 'Should I update it?' };
    const { toolCalls } = await turn(persona(), [], 'I moved to <new town>');

    expect(toolCalls.map((t) => t.name)).toEqual(['saveExtractedFacts']);
    const entry = (toolCalls[0].input as { extracted_user_information: { statement: string; replaces: string }[] })
      .extracted_user_information[0];
    expect(entry).toMatchObject({ statement: 'Lives in <new town>', replaces: old.id });
    expect((toolCalls[0].result as { pendingFacts: { replaces?: string }[] }).pendingFacts[0].replaces).toBe(old.id);
    expect((await getFacts()).map((f) => f.id)).toContain(old.id);
    expect(Object.keys(writes[0].schema.properties).sort()).toEqual(['reply', 'statement']);
  });

  it('unsure intent: chips for the likeliest readings plus Something else; nothing is staged or applied', async () => {
    await addFact('Lives in <town>');
    kevScript = { intent: { share_new_fact: 0.45, correct_fact: 0.4, question_or_chat: 0.15 } };
    const thread: ConversationMessage[] = [];
    const { out, toolCalls } = await turn(persona(), thread, '<new town>');

    expect(writes).toHaveLength(0);
    expect(out.reply).toBe('kevChat.askIntent');
    expect(toolCalls.map((t) => [t.name, t.result])).toEqual([['ask_choice', { awaiting: 'user' }]]);
    // The third reading has p >= 0.1, so it gets a chip too.
    const options = ['kevChat.persona.share', 'kevChat.persona.correct', 'kevChat.persona.chat'];
    expect(toolCalls[0].input).toMatchObject({ options, readings: ['share_new_fact', 'correct_fact', 'question_or_chat'], somethingElse: true });
    expect(cards(thread)).toEqual([expect.objectContaining({ kind: 'ask-choice-card', options, somethingElse: true, saveAll: null })]);
    expect(out.trace).toMatchObject({ asked: true, intent: 'share_new_fact' });
  });

  it('a chip tap acts on that reading with no new intent question to Kev, and reads the message it asked about', async () => {
    const old = await addFact('Lives in <town>');
    kevScript = { intent: { share_new_fact: 0.45, correct_fact: 0.4, question_or_chat: 0.15 } };
    const thread: ConversationMessage[] = [];
    const agent = persona();
    await turn(agent, thread, '<new town>');

    kevScript = { target: { f1: 0.9, none: 0.1 } };
    writerReply = { statement: 'Lives in <new town>', reply: 'Update it?' };
    const { out, toolCalls } = await turn(agent, thread, 'kevChat.persona.correct');

    expect(decideRequests.map((r) => Object.keys(r.questions))).toEqual([['intent'], ['target']]);
    expect((decideRequests[1].state as { user_message: string }).user_message).toBe('<new town>');
    expect(toolCalls[0].input).toMatchObject({ extracted_user_information: [{ replaces: old.id }] });
    expect(out.trace).toMatchObject({ source: 'tap', intent: 'correct_fact' });
    // The earlier ask is spent once the user answered.
    expect(cards(thread).find((c) => c.kind === 'ask-choice-card')).toMatchObject({ answered: true });
  });

  it('unsure target: fact chips with no Save all, and a fact chip tap stages the delete card without asking Kev again', async () => {
    const a = await addFact('Follows <sport one>');
    await addFact('Follows <sport two>');
    // No fact reaches the card's 0.25 floor and "none" is not sure either: ask.
    kevScript = { intent: { remove_fact: 0.9, question_or_chat: 0.1 }, target: { f1: 0.24, f2: 0.23, none: 0.53 } };
    const thread: ConversationMessage[] = [];
    const agent = persona();
    const asked = await turn(agent, thread, 'I do not do that anymore');

    const shown = (await getFacts()).map((f) => f.statement);
    expect(asked.toolCalls[0].input).toMatchObject({
      question: 'kevChat.askFact',
      options: shown,
      readings: ['remove_fact:f1', 'remove_fact:f2'],
    });
    expect(cards(thread)).toEqual([expect.objectContaining({ kind: 'ask-choice-card', saveAll: null, somethingElse: true })]);
    expect((await getFacts())).toHaveLength(2);

    const tapped = await turn(agent, thread, ' follows <SPORT ONE> ');
    expect(decideRequests).toHaveLength(2);
    expect(tapped.toolCalls.map((t) => [t.name, t.input])).toEqual([['deleteUserFacts', { fact_ids: [a.id] }]]);
    expect((await getFacts())).toHaveLength(2);
  });

  describe('a waiting change', () => {
    it.each(['yes', 'do it', 'go ahead', 'sure', 'apply it'])('"%s" applies it, decided by the rule with no Kev call', async (word) => {
      stageChange();
      const { names, out } = await turn(persona(), [], word);
      expect(decideRequests).toHaveLength(0);
      expect(names).toEqual(['applyProposal']);
      expect(proposal()).toBeNull();
      expect(out.trace).toMatchObject({ intent: 'agree_to_card', source: 'rule' });
    });

    it.each(['ok', 'cool', 'thanks', 'nice'])('"%s" only acknowledges: nothing applied, no Kev call', async (word) => {
      const staged = stageChange();
      const { names, out } = await turn(persona(), [], word);
      expect(decideRequests).toHaveLength(0);
      expect(names).toEqual([]);
      expect(proposal()?.id).toBe(staged.id);
      expect(out.trace).toMatchObject({ intent: 'thanks_or_ack', source: 'rule' });
    });

    it('"no thanks" cancels it', async () => {
      stageChange();
      const { names } = await turn(persona(), [], 'no thanks');
      expect(names).toEqual(['cancelProposal']);
      expect(proposal()).toBeNull();
    });

    it('a longer message goes to Kev, which is offered agree and decline', async () => {
      stageChange();
      kevScript = { intent: { agree_to_card: 0.9, question_or_chat: 0.1 } };
      const { names } = await turn(persona(), [], 'yes, add that one for me');
      expect(offeredIntents()).toEqual(expect.arrayContaining(['agree_to_card', 'decline_card']));
      expect(names).toEqual(['applyProposal']);
    });

    it('a tap-only card is never applied by a typed yes', async () => {
      stageChange(true);
      const { names, out } = await turn(persona(), [], 'yes');
      expect(names).toEqual([]);
      expect(out.reply).toBe('kevChat.reply.pickOnCard');
      expect(proposal()).not.toBeNull();
    });
  });

  it('with no card waiting, agree and decline are not offered; with no facts, neither are remove and correct', async () => {
    kevScript = { intent: { question_or_chat: 0.9, share_new_fact: 0.1 } };
    await turn(persona(), [], 'how does this work?');
    expect(offeredIntents()).toEqual(['share_new_fact', 'question_or_chat', 'thanks_or_ack']);
  });

  it('question or thanks: a reply only, and a close call between the two is not a reason to ask', async () => {
    kevScript = { intent: { thanks_or_ack: 0.5, question_or_chat: 0.4, share_new_fact: 0.1 } };
    writerReply = { reply: 'Anytime!' };
    const { names, out } = await turn(persona(), [], 'thank you so much');
    expect(names).toEqual([]);
    expect(out.reply).toBe('Anytime!');
    expect(out.trace).toMatchObject({ intent: 'thanks_or_ack', asked: false });
  });

  it('a writer refusal falls back to the fixed reply: no error, nothing staged', async () => {
    kevScript = { intent: { share_new_fact: 0.9, question_or_chat: 0.1 } };
    writerReply = new Error('SensitiveContentAnalysis');
    const { names, out } = await turn(persona(), [], 'I am <religion>');
    expect(names).toEqual([]);
    expect(out.reply).toBe('kevChat.reply.saveFailed');
    expect(out.trace.wrote).toBe(false);
  });

  it('when Kev fails, the turn runs the single built-in call instead', async () => {
    installOnDeviceLlm({ reply: JSON.stringify({ reply: 'Single call.', save: [] }) });
    const { out } = await turn(persona({ route: 'kev', ports: { ...ports, decide: (async () => { throw new Error('not downloaded'); }) as never } }), [], 'hello');
    expect(out.reply).toBe('Single call.');
    expect(onDeviceLlmCalls().map((c) => c.kind)).toEqual(['structured']);
  });

  it("route 'single' still works, and its delete is staged too (D40)", async () => {
    const gone = await addFact('Follows <sport>');
    installOnDeviceLlm({ reply: JSON.stringify({ reply: 'Removed?', save: [], delete: [gone.id] }) });
    const thread: ConversationMessage[] = [];
    const { names, toolCalls } = await turn(persona({ route: 'single' }), thread, 'forget the <sport> one');
    expect(decideRequests).toHaveLength(0);
    expect(names).toEqual(['deleteUserFacts']);
    expect(toolCalls[0].result).toMatchObject({ pendingFactIds: [gone.id] });
    expect((await getFacts()).map((f) => f.id)).toEqual([gone.id]);
  });
});

// ================================================================================================
// Article chat
// ================================================================================================

describe('article chat on Kev', () => {
  async function article(opts: OnDeviceAgentOptions = kevRoute, publication = 'The Example Times') {
    const { topics } = await seedFactWithTopics('Lives in <place>', ['<place> local news', '<place> transport']);
    const seeded = await seedSuggestion({ articleId: 'art-1', title_en: 'A <place> headline', publication_name: publication, matchedTopics: topics, relevance: 0.8 });
    return new ArticleFeedbackOnDeviceAgent(USER, { articleId: seeded.articleId, suggestionId: seeded.suggestionId }, null, opts);
  }

  it('see_less: Kev picks the matched topic, not the first one', async () => {
    kevScript = { intent: { see_less: 0.9, answer_question: 0.1 }, topic: { t1: 0.1, t2: 0.9 } };
    writerReply = { reply: 'Here is how far to go.', expected_effects: 'Fewer transport stories.' };
    const { names } = await turn(await article(), [], 'less about transport');
    expect(names).toEqual(['proposeChanges']);
    expect(decideRequests[1].questions.topic.criteria).toEqual({ t1: '<place> local news', t2: '<place> transport' });
    expect(proposal()).toMatchObject({
      expectedEffects: 'Fewer transport stories.',
      chooseOne: true,
      actions: [
        { type: 'set_topic_weight', topicText: '<place> transport', delta: -0.3 },
        { type: 'retire_topic', topicText: '<place> transport' },
      ],
    });
  });

  it('see_more with an unsure topic asks with the topics as chips, and the tap stages the change', async () => {
    kevScript = { intent: { see_more: 0.9, answer_question: 0.1 }, topic: { t1: 0.5, t2: 0.5 } };
    const thread: ConversationMessage[] = [];
    const agent = await article();
    const asked = await turn(agent, thread, 'more like this');
    expect(asked.toolCalls[0].input).toMatchObject({ options: ['<place> local news', '<place> transport'], readings: ['see_more:t1', 'see_more:t2'] });
    expect(proposal()).toBeNull();

    writerReply = { reply: 'More of these?', expected_effects: 'More transport.' };
    await turn(agent, thread, '<place> transport');
    expect(decideRequests).toHaveLength(2);
    expect(proposal()?.actions).toEqual([{ type: 'set_topic_weight', topicText: '<place> transport', delta: 0.3 }]);
  });

  it('follow_story: the writer writes the options and the story card is staged', async () => {
    kevScript = { intent: { follow_story: 0.9, answer_question: 0.1 } };
    writerReply = { reply: 'Pick one below.', options: [{ label: 'The Local Story', search: 'Place story' }, { label: 'The Wider Story', search: 'Region story' }] };
    const { names } = await turn(await article(), [], 'keep me posted');
    expect(names).toEqual(['proposeTrack']);
    expect(writes[0].prompt).toContain('Option rules:');
    expect(proposal()?.actions.map((a) => a.type === 'track_story' && a.label)).toEqual(['The Local Story', 'The Wider Story']);
  });

  it('mute_source: the article publication; a writer failure still stages the card with the fixed reply', async () => {
    kevScript = { intent: { mute_source: 0.9, answer_question: 0.1 } };
    writerReply = new Error('refused');
    const { out } = await turn(await article(), [], 'never show me this paper');
    expect(out.reply).toBe('kevChat.reply.changeCard');
    expect(proposal()?.actions).toEqual([{ type: 'set_publication_pref', publicationId: 'The Example Times', publicationPref: 'mute' }]);
  });

  it('answer_question: a reply only; "ok" on a waiting card only acknowledges', async () => {
    kevScript = { intent: { answer_question: 0.9, see_more: 0.1 } };
    writerReply = { reply: 'It matches where you live.' };
    const agent = await article();
    expect((await turn(agent, [], 'why this?')).names).toEqual([]);
    stageChange();
    const { names } = await turn(agent, [], 'ok');
    expect(names).toEqual([]);
    expect(proposal()).not.toBeNull();
  });

  it('a typed yes applies a waiting change through the executor', async () => {
    const agent = await article();
    stageChange();
    const { names, toolCalls } = await turn(agent, [], 'yes');
    expect(names).toEqual(['applyProposal']);
    expect(toolCalls[0].result).toMatchObject({ applied: expect.any(Number) });
    expect(proposal()).toBeNull();
    expect(decideRequests).toHaveLength(0);
  });

  it('follow_story is not offered once the story is followed', async () => {
    const agent = await article();
    jest.spyOn(require('@/lib/tracking/track-actions'), 'isSubjectTracked').mockResolvedValue(true);
    kevScript = { intent: { answer_question: 1 } };
    await turn(agent, [], 'follow this');
    expect(offeredIntents()).not.toContain('follow_story');
    jest.restoreAllMocks();
  });

  it("route 'single' still works", async () => {
    installOnDeviceLlm({ reply: JSON.stringify({ intent: 'answer', reply: 'Single.' }) });
    const { out } = await turn(await article({ route: 'single' }), [], 'why this?');
    expect(out.reply).toBe('Single.');
    expect(decideRequests).toHaveLength(0);
  });
});

// ================================================================================================
// Follow-story
// ================================================================================================

describe('follow-story on Kev', () => {
  const follow = (opts: OnDeviceAgentOptions = kevRoute) => new FollowStoryOnDeviceAgent(USER, opts);

  it('follow_a_named_story: the existing options schema, staged as the story card', async () => {
    kevScript = { intent: { follow_a_named_story: 0.9, question_or_other: 0.1 } };
    writerReply = { reply: 'Pick one below.', options: [{ label: 'The Narrow Event', search: 'event' }, { label: 'The Broad Story', search: 'story' }] };
    const { names } = await turn(follow(), [], 'the <event> in <town>');
    expect(offeredIntents()).toEqual(['follow_this_story', 'follow_a_named_story', 'question_or_other']);
    expect(names).toEqual(['proposeTrack']);
    expect(proposal()?.chooseOne).toBe(true);
    expect(Object.keys(writes[0].schema.properties).sort()).toEqual(['options', 'reply']);
  });

  it('a close call between the two follow readings is not a reason to ask', async () => {
    kevScript = { intent: { follow_this_story: 0.4, follow_a_named_story: 0.4, question_or_other: 0.2 } };
    writerReply = { reply: 'Which story?', options: [] };
    const { names, out } = await turn(follow(), [], 'that one');
    expect(names).toEqual([]);
    expect(out.trace.asked).toBe(false);
  });

  it('unsure between following and a question: chips, nothing written', async () => {
    kevScript = { intent: { follow_a_named_story: 0.5, question_or_other: 0.45, follow_this_story: 0.05 } };
    const thread: ConversationMessage[] = [];
    const { toolCalls } = await turn(follow(), thread, 'the election');
    expect(writes).toHaveLength(0);
    expect(toolCalls[0].input).toMatchObject({ options: ['kevChat.follow.follow', 'kevChat.follow.other'], somethingElse: true });
  });

  it('question_or_other: a reply only', async () => {
    kevScript = { intent: { question_or_other: 0.9, follow_a_named_story: 0.1 } };
    writerReply = { reply: 'This chat only starts following a story.' };
    const { names, out } = await turn(follow(), [], 'what is the weather?');
    expect(names).toEqual([]);
    expect(out.reply).toBe('This chat only starts following a story.');
  });

  it('a typed yes on the story options (tap only) applies nothing', async () => {
    stageChange(true);
    const { names, out } = await turn(follow(), [], 'yes');
    expect(names).toEqual([]);
    expect(out.reply).toBe('kevChat.reply.pickOnCard');
  });

  it('a writer failure asks which story, never an error', async () => {
    kevScript = { intent: { follow_a_named_story: 0.9, question_or_other: 0.1 } };
    writerReply = new Error('refused');
    const { names, out } = await turn(follow(), [], 'the <event>');
    expect(names).toEqual([]);
    expect(out.reply).toBe('kevChat.reply.followFailed');
  });

  it("route 'single' still works", async () => {
    installOnDeviceLlm({ reply: JSON.stringify({ reply: 'Which story?', options: [] }) });
    const { out } = await turn(follow({ route: 'single' }), [], 'I want to follow a story');
    expect(out.reply).toBe('Which story?');
    expect(decideRequests).toHaveLength(0);
  });
});
