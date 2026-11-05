// An interest with no stake is a story to follow: `has_stake` on facts/interest
// legs takes the entry out of the save, and one forced leg on the follow skill
// stages the card. Code owns the handover, never the model.
import { createAgentState, runAgentTurn, withImpactQuestion, type AgentPersona } from '@/lib/mera-harness/core/core';
import { toolsForLeg } from '@/lib/mera-harness/core/tool-contracts';
import { isUsableSubject } from '@/lib/mera-harness/core/stake-handover';
import type { AgentDeps, AgentModelRequest, AgentModelResult } from '@/lib/mera-harness/core/types';

function res(over: Partial<AgentModelResult> = {}): AgentModelResult {
  return {
    content: '', toolCalls: [], finishReason: 'stop', truncated: false,
    usage: null, modelSent: 'fake', latencyMs: 1, error: null, ...over,
  };
}
const tc = (name: string, args: unknown = {}) => ({ name, argumentsRaw: JSON.stringify(args) });
const SKILLS: Record<string, string> = {
  'conversation/follow-story': 'FOLLOW BODY',
  'facts/interest': 'INTEREST BODY',
  'facts/residence': 'RESIDENCE BODY',
  'topics/interest': 'TOPICS',
};
const PERSONA: AgentPersona = { surface: 'CONFIG', languageName: 'English', facts: [] };
const KEY = 'topics: general interests';
const NO_STAKE = { statement: 'Follows Rally Finland', questionnaire_attribute: KEY, has_stake: false, story_subject: 'Rally Finland' };
const STAKE = { statement: 'Marshals at Rally Finland', questionnaire_attribute: KEY, has_stake: true, story_subject: 'Rally Finland' };
const MODEL_OPTIONS = {
  options: [
    { label: 'Rally Finland Results', search: 'Rally Finland stage results' },
    { label: 'World Rally Championship', search: 'World Rally Championship' },
  ],
};
const route = (id = 'facts/interest') => res({ content: 'Nice.', toolCalls: [tc('load_skill', { id })] });
const save = (...entries: unknown[]) => res({ content: 'Noted.', toolCalls: [tc('saveExtractedFacts', { extracted_user_information: entries })] });
const card = (options: unknown = MODEL_OPTIONS.options) =>
  res({ content: 'Rally Finland is a good one to follow. Tick what you want and tap Follow.', toolCalls: [tc('proposeTrack', { options })] });

function harness(script: AgentModelResult[], tools: Partial<AgentDeps['tools']> = {}) {
  const requests: AgentModelRequest[] = [];
  const port = {
    saveExtractedFacts: jest.fn(async (a: Record<string, unknown>) => ({
      staged: true, factsSaved: 0, groupResolutions: {},
      pendingFacts: (a.extracted_user_information as unknown[]),
    })),
    proposeTrack: jest.fn(async (a: Record<string, unknown>) => ({ staged: true, proposalId: 'track-1', options: a.options })),
    searchNews: jest.fn(async (a: { query: string }) => ({ query: a.query, results: [] })),
  };
  let i = 0;
  const deps: AgentDeps = {
    callModel: async (req) => {
      requests.push(req);
      return script[Math.min(i++, script.length - 1)];
    },
    tools: {
      findSimilarFacts: async () => ({ candidates: [] }),
      lookupPlace: async () => ({ status: 'no_match', query: '' }) as never,
      deleteUserFacts: async () => ({ deleted: [] }),
      ...port,
      ...tools,
    },
    loadSkill: (id) => SKILLS[id] ?? null,
    skillIds: () => Object.keys(SKILLS),
    now: () => 0,
  };
  return { deps, requests, port };
}
const names = (req: AgentModelRequest) => ((req.tools ?? []) as { function: { name: string } }[]).map((t) => t.function.name);
const interestSchema = (tools: unknown[]) => {
  const save = (tools as { function: { name: string; parameters: { properties: { extracted_user_information: { items: { properties: Record<string, unknown>; required: string[] } } } } } }[])
    .find((t) => t.function.name === 'saveExtractedFacts');
  return save!.function.parameters.properties.extracted_user_information.items;
};
const stagedTrack = (out: { legs: { toolResults: { name: string; result: unknown }[] }[] }) =>
  out.legs.flatMap((l) => l.toolResults).find((r) => r.name === 'proposeTrack')?.result as Record<string, unknown>;

describe('the has_stake slot', () => {
  it('only facts/interest carries it, as required slots, and only when the device can stage a follow card', () => {
    const on = { skillLoaded: 'facts/interest', skillTools: ['saveExtractedFacts'], tracks: true };
    expect(interestSchema(toolsForLeg(on)).required).toEqual(expect.arrayContaining(['has_stake', 'story_subject']));
    expect(interestSchema(toolsForLeg({ ...on, forcingProposal: true })).required).toContain('has_stake');
    expect(interestSchema(toolsForLeg({ ...on, tracks: false })).properties).not.toHaveProperty('has_stake');
    expect(interestSchema(toolsForLeg({ ...on, skillLoaded: 'facts/residence' })).properties).not.toHaveProperty('has_stake');
  });
});

describe('the handover', () => {
  it('false ends on a follow card and saves nothing, with the subject first', async () => {
    const h = harness([route(), save(NO_STAKE), card()]);
    const state = createAgentState(PERSONA);
    const out = await runAgentTurn({ state, userMessage: "I'm into rally finland", deps: h.deps });

    expect(h.port.saveExtractedFacts).not.toHaveBeenCalled();
    const sent = h.port.proposeTrack.mock.calls[0][0] as { options: { label: string; search: string }[]; storySubjects: string[] };
    expect(sent.options[0]).toEqual({ label: 'Rally Finland', search: 'Rally Finland' });
    expect(sent.options.map((o) => o.label)).toEqual(['Rally Finland', 'Rally Finland Results', 'World Rally Championship']);
    expect(sent.storySubjects).toEqual(['Rally Finland']);
    expect(out.terminalReason).toBe('awaiting-user');
    expect(out.reply).toContain('good one to follow');
    expect(out.stagedSomething).toBe(true);
    expect(out.closingLegFired).toBe(false);
    expect(state.turn.lastCard?.skill).toBe('conversation/follow-story');
  });

  it('the follow leg runs the follow skill with proposeTrack alone, on auto so it writes the sentence, and reads today', async () => {
    const h = harness([route(), save(NO_STAKE), card()]);
    await runAgentTurn({ state: createAgentState(PERSONA), userMessage: "I'm into rally finland", deps: h.deps });
    const leg = h.requests[2];
    expect(leg.systemPrompt).toContain('FOLLOW BODY');
    expect(leg.toolChoice).toBe('auto');
    expect(names(leg)).toEqual(['proposeTrack']);
    expect(leg.messages.map((m) => m.content).join('\n')).toContain('Today:');
    expect(leg.messages[leg.messages.length - 1].content).toContain('Rally Finland');
  });

  it('the loop searches the subject itself, once, and the leg reads the result', async () => {
    const searchNews = jest.fn(async (a: { query: string }) => ({ query: a.query, headlines: ['Rally Finland stage two'] }));
    const h = harness([route(), save(NO_STAKE), card()], { searchNews });
    const out = await runAgentTurn({ state: createAgentState(PERSONA), userMessage: "I'm into rally finland", deps: h.deps });
    expect(searchNews.mock.calls).toEqual([[{ query: 'Rally Finland' }]]);
    expect(h.requests[2].messages.map((m) => m.content).join('\n')).toContain('Rally Finland stage two');
    expect(out.legs[1].toolCalls.map((c) => c.name)).toEqual(['saveExtractedFacts', 'searchNews']);
    expect(out.legs[1].toolResults.map((c) => c.name)).toEqual(['saveExtractedFacts', 'searchNews']);
  });

  it('a search that throws still ends on the card', async () => {
    const h = harness([route(), save(NO_STAKE), card()], { searchNews: async () => { throw new Error('offline'); } });
    const out = await runAgentTurn({ state: createAgentState(PERSONA), userMessage: "I'm into rally finland", deps: h.deps });
    expect(stagedTrack(out)).toBeDefined();
  });

  it('a leg that writes no card gets one required retry, and a model search is refused', async () => {
    const h = harness([route(), save(NO_STAKE), res({ toolCalls: [tc('searchNews', { query: 'again' })] }), card()]);
    const out = await runAgentTurn({ state: createAgentState(PERSONA), userMessage: "I'm into rally finland", deps: h.deps });
    expect(h.port.searchNews).toHaveBeenCalledTimes(1);
    expect(names(h.requests[3])).toEqual(['proposeTrack']);
    expect(h.requests[3].toolChoice).toBe('required');
    expect(stagedTrack(out)).toBeDefined();
  });

  it('a card with no sentence beside it gets the fixed line, in the reader\'s language', async () => {
    const h = harness([route(), save(NO_STAKE), res({ toolCalls: [tc('proposeTrack', MODEL_OPTIONS)] })]);
    const out = await runAgentTurn({
      state: createAgentState(PERSONA), userMessage: "I'm into rally finland", deps: h.deps,
      fallbacks: { leak: 'l', process: 'p', followCard: 'VOLG DEZE' },
    });
    expect(out.reply).toBe('VOLG DEZE');
  });

  it('a forced offer in a script that shares no word with English facts still goes through', async () => {
    const stake = { statement: 'Travels to Ahmedabad for the IPL final', has_stake: true, story_subject: 'IPL' };
    const h = harness([route(), res({ content: 'ठीक है।' }), res({ toolCalls: [tc('saveExtractedFacts', { extracted_user_information: [stake] })] }), res({ content: 'ठीक है।' })]);
    await runAgentTurn({ state: createAgentState(PERSONA), userMessage: 'मैं अगले महीने फाइनल देखने जा रहा हूँ', deps: h.deps });
    expect(h.port.saveExtractedFacts).toHaveBeenCalledTimes(1);
  });

  it('capitalises a subject the model wrote in lower case', async () => {
    const h = harness([route(), save({ ...NO_STAKE, story_subject: 'cycling' }), card()]);
    await runAgentTurn({ state: createAgentState(PERSONA), userMessage: "I'm into cycling", deps: h.deps });
    expect((h.port.proposeTrack.mock.calls[0][0] as { options: { label: string }[] }).options[0].label).toBe('Cycling');
  });

  it("the model's search for the subject's own row wins: the label stays theirs, the search is English", async () => {
    const h = harness([route(), save({ ...NO_STAKE, story_subject: 'रैली फ़िनलैंड' }), card([{ label: 'रैली फ़िनलैंड', search: 'Rally Finland' }])]);
    await runAgentTurn({ state: createAgentState(PERSONA), userMessage: 'मुझे रैली फ़िनलैंड पसंद है', deps: h.deps });
    const sent = h.port.proposeTrack.mock.calls[0][0] as { options: { label: string; search: string }[] };
    expect(sent.options).toEqual([{ label: 'रैली फ़िनलैंड', search: 'Rally Finland' }]);
  });

  it('the dropped entries ride the result as profileOffer', async () => {
    const h = harness([route(), save(NO_STAKE), card()]);
    const out = await runAgentTurn({ state: createAgentState(PERSONA), userMessage: "I'm into rally finland", deps: h.deps });
    expect(stagedTrack(out)).toMatchObject({
      storySubjects: ['Rally Finland'],
      profileOffer: [{ statement: 'Follows Rally Finland', questionnaire_attribute: KEY, topic_skill_id: 'topics/interest' }],
    });
  });

  it('true saves as today and never reaches the follow leg', async () => {
    const h = harness([route(), save(STAKE), res({ content: 'That sounds like a busy week.' })]);
    await runAgentTurn({ state: createAgentState(PERSONA), userMessage: 'I marshal at rally finland', deps: h.deps });
    expect(h.port.saveExtractedFacts).toHaveBeenCalledTimes(1);
    const entries = (h.port.saveExtractedFacts.mock.calls[0][0] as { extracted_user_information: Record<string, unknown>[] }).extracted_user_information;
    expect(entries[0].statement).toBe('Marshals at Rally Finland');
    expect(entries[0]).not.toHaveProperty('has_stake');
    expect(entries[0]).not.toHaveProperty('story_subject');
    expect(h.port.proposeTrack).not.toHaveBeenCalled();
  });

  it.each([[undefined], ['false'], [0], [null]])('a missing or malformed value (%p) is today\'s card', async (value) => {
    const { has_stake: _dropped, ...rest } = NO_STAKE;
    const entry = value === undefined ? rest : { ...rest, has_stake: value };
    const h = harness([route(), save(entry), res({ content: 'Nice one.' })]);
    await runAgentTurn({ state: createAgentState(PERSONA), userMessage: "I'm into rally finland", deps: h.deps });
    expect(h.port.saveExtractedFacts).toHaveBeenCalledTimes(1);
    expect(h.port.proposeTrack).not.toHaveBeenCalled();
  });

  it('a mixed call stages the fact and the follow card in one turn', async () => {
    const other = { ...STAKE, statement: 'Marshals at the Monte Carlo Rally', story_subject: 'Monte Carlo Rally' };
    const h = harness([route(), save(other, NO_STAKE), card()]);
    const out = await runAgentTurn({ state: createAgentState(PERSONA), userMessage: 'I marshal at Monte Carlo and love rally finland', deps: h.deps });
    const saved = (h.port.saveExtractedFacts.mock.calls[0][0] as { extracted_user_information: { statement: string }[] }).extracted_user_information;
    expect(saved.map((e) => e.statement)).toEqual(['Marshals at the Monte Carlo Rally']);
    expect(h.port.proposeTrack).toHaveBeenCalledTimes(1);
    expect(out.proposals.map((p) => p.statement)).toEqual(['Marshals at the Monte Carlo Rally']);
  });

  it('a forced leg that stages no card gives the fact card back, and the reader loses nothing', async () => {
    const h = harness([route(), save(NO_STAKE), res({ content: 'No idea.' }), res({ content: 'Still none.' })]);
    const state = createAgentState(PERSONA);
    const out = await runAgentTurn({ state, userMessage: "I'm into rally finland", deps: h.deps });
    const entries = (h.port.saveExtractedFacts.mock.calls[0][0] as { extracted_user_information: Record<string, unknown>[] }).extracted_user_information;
    expect(entries[0]).toMatchObject({ statement: 'Follows Rally Finland', topic_skill_id: 'topics/interest' });
    expect(entries[0]).not.toHaveProperty('has_stake');
    expect(out.proposals.map((p) => p.statement)).toEqual(['Follows Rally Finland']);
    expect(out.stagedSomething).toBe(true);
    expect(state.turn.lastSkill).toBe('facts/interest');
  });

  it('a refused card gives the fact card back too', async () => {
    const h = harness([route(), save(NO_STAKE), card()], { proposeTrack: async () => ({ error: 'options is required' }) });
    await runAgentTurn({ state: createAgentState(PERSONA), userMessage: "I'm into rally finland", deps: h.deps });
    expect(h.port.saveExtractedFacts).toHaveBeenCalledTimes(1);
  });

  it('a question beside the save keeps it a fact card: one question per turn', async () => {
    const ask = tc('ask_choice', { question: 'Which rally?', options: ['Finland', 'Sweden'] });
    const h = harness([route(), res({ toolCalls: [tc('saveExtractedFacts', { extracted_user_information: [NO_STAKE] }), ask] })]);
    await runAgentTurn({ state: createAgentState(PERSONA), userMessage: "I'm into rally", deps: h.deps });
    expect(h.port.proposeTrack).not.toHaveBeenCalled();
    expect(h.port.saveExtractedFacts).toHaveBeenCalledTimes(1);
  });

  it('a fact already on file gets no card', async () => {
    const persona = { ...PERSONA, facts: [{ id: 'f1', statement: 'Follows Rally Finland', attribute: KEY }] };
    const h = harness([route(), save(NO_STAKE), res({ content: 'That one is already on file.' })]);
    await runAgentTurn({ state: createAgentState(persona), userMessage: "I'm into rally finland", deps: h.deps });
    expect(h.port.proposeTrack).not.toHaveBeenCalled();
  });

  it('a staged result with no save stays out of the thread: factsSaved is zero', async () => {
    const h = harness([route(), save(NO_STAKE), card()]);
    const out = await runAgentTurn({ state: createAgentState(PERSONA), userMessage: "I'm into rally finland", deps: h.deps });
    const saveResult = out.legs.flatMap((l) => l.toolResults).find((r) => r.name === 'saveExtractedFacts');
    expect(saveResult?.result).toMatchObject({ factsSaved: 0 });
  });
});

describe('forced-offer grounding on a message it cannot compare', () => {
  // Facts are written in English, so word overlap with any other language is always empty.
  const forced = (statement: string, extra: Record<string, unknown> = {}) =>
    res({ toolCalls: [tc('saveExtractedFacts', { extracted_user_information: [{ statement, ...extra }] })] });
  const run = (facts: { languageName: string; message: string; statement: string; earlier?: string[]; profession?: boolean; question?: string }) => {
    const h = harness([route(facts.profession ? 'facts/residence' : 'facts/interest'), res({ content: 'Prima.' }), forced(facts.statement), res({ content: 'Prima.' })]);
    const state = createAgentState({ ...PERSONA, languageName: facts.languageName });
    state.turn.lastSubjects = facts.earlier ?? [];
    state.turn.lastQuestion = facts.question ?? null;
    return { h, done: runAgentTurn({ state, userMessage: facts.message, deps: h.deps }) };
  };
  const saved = (h: ReturnType<typeof harness>) =>
    h.port.saveExtractedFacts.mock.calls.flatMap((c) => (c[0] as { extracted_user_information: { statement: string }[] }).extracted_user_information.map((e) => e.statement));

  it('a Dutch message keeps its forced offer, in the Latin script', async () => {
    const { h, done } = run({ languageName: 'Dutch', message: 'Ik ben gek op wielrennen', statement: 'Follows cycling' });
    await done;
    expect(saved(h)).toEqual(['Follows cycling']);
  });

  it('a Hindi message keeps its forced offer on any fact skill, not only interests', async () => {
    const { h, done } = run({ languageName: 'Hindi', message: 'मैं क्रिकेट कोच हूँ', statement: 'Cricket coach', profession: true });
    await done;
    expect(saved(h)).toEqual(['Cricket coach']);
  });

  it('a script with no Latin letter is exempt whatever the app language', async () => {
    const { h, done } = run({ languageName: 'English', message: 'मैं क्रिकेट कोच हूँ', statement: 'Cricket coach' });
    await done;
    expect(saved(h)).toEqual(['Cricket coach']);
  });

  it('LEAK GUARD, in Dutch: an unrelated new fact never carries the earlier subject', async () => {
    const { h, done } = run({ languageName: 'Dutch', message: 'Ik roei graag in het weekend', statement: 'Follows Porto Santo news', earlier: ['Porto Santo island'] });
    await done;
    expect(saved(h)).toEqual([]);
  });

  it('LEAK GUARD, in Hindi', async () => {
    const { h, done } = run({ languageName: 'Hindi', message: 'मुझे सप्ताहांत में नाव चलाना पसंद है', statement: 'Follows Porto Santo news', earlier: ['Porto Santo island'] });
    await done;
    expect(saved(h)).toEqual([]);
  });

  it('a Dutch message that names the earlier subject itself keeps it', async () => {
    const { h, done } = run({ languageName: 'Dutch', message: 'Ik ga volgend jaar naar Porto Santo', statement: 'Going to Porto Santo', earlier: ['Porto Santo island'] });
    await done;
    expect(saved(h)).toEqual(['Going to Porto Santo']);
  });

  it('a bare yes names nothing in any language, so an invented subject still goes', async () => {
    const { h, done } = run({ languageName: 'Dutch', message: 'ja', statement: 'Follows the conflict in Israel', question: 'Which thread are you following?' });
    await done;
    expect(saved(h)).toEqual([]);
  });

  it('a bare yes in Hindi too', async () => {
    const { h, done } = run({ languageName: 'Hindi', message: 'हाँ', statement: 'Follows the conflict in Israel', question: 'कौन सी खबर?' });
    await done;
    expect(saved(h)).toEqual([]);
  });

  it('an English reader keeps the original rule: an offer naming nothing said goes', async () => {
    const { h, done } = run({ languageName: 'English', message: 'I enjoy rowing on weekends', statement: 'Follows the conflict in Israel' });
    await done;
    expect(saved(h)).toEqual([]);
  });
});

describe('a save whose list arrives as a JSON string', () => {
  const stringSave = (raw: string) => res({ toolCalls: [tc('saveExtractedFacts', { extracted_user_information: raw })] });

  it('keeps the entries on any fact skill', async () => {
    const raw = JSON.stringify([{ statement: 'Daughter plays in a youth team' }]);
    const h = harness([route('facts/residence'), stringSave(raw), res({ content: 'Nice.' })]);
    const out = await runAgentTurn({ state: createAgentState(PERSONA), userMessage: 'My daughter plays in a youth team', deps: h.deps });
    expect(out.proposals.map((p) => p.statement)).toEqual(['Daughter plays in a youth team']);
    expect(h.port.saveExtractedFacts).toHaveBeenCalledTimes(1);
  });

  it('a no-stake entry in a string still reaches the follow card', async () => {
    const h = harness([route(), stringSave(JSON.stringify([NO_STAKE])), card()]);
    await runAgentTurn({ state: createAgentState(PERSONA), userMessage: "I'm into rally finland", deps: h.deps });
    expect(h.port.saveExtractedFacts).not.toHaveBeenCalled();
    expect(h.port.proposeTrack).toHaveBeenCalledTimes(1);
  });

  it.each([['[{"statement": "Rally'], ['not json'], ['{"statement":"Rally"}'], ['7'], ['[1,"x",null]'], ['']])(
    'a malformed string (%p) is treated as empty and the call never fails',
    async (raw) => {
      const h = harness([route(), stringSave(raw), res({ content: 'Nice to hear it.' }), res({ content: 'Nice to hear it.' })]);
      const out = await runAgentTurn({ state: createAgentState(PERSONA), userMessage: "I'm into rally finland", deps: h.deps });
      expect(out.terminalReason).not.toBe('transport-error');
      expect(out.proposals).toEqual([]);
    },
  );

  it('a malformed string is not an explicit empty save: the forced leg still rescues the turn', async () => {
    const h = harness([route(), stringSave('not json'), res({ content: 'Nice.' }), save(STAKE), res({ content: 'Nice.' })]);
    const out = await runAgentTurn({ state: createAgentState(PERSONA), userMessage: 'I marshal at rally finland', deps: h.deps });
    expect(out.forcedProposal).toBe(true);
    expect(out.proposals.map((p) => p.statement)).toEqual(['Marshals at Rally Finland']);
  });
});

describe('the first option is never personal', () => {
  it('skips a personal or missing subject and opens on the model\'s options', async () => {
    for (const subject of ["I'm into Rally Finland", undefined]) {
      const h = harness([route(), save({ ...NO_STAKE, story_subject: subject }), card()]);
      const out = await runAgentTurn({ state: createAgentState(PERSONA), userMessage: "I'm into rally finland", deps: h.deps });
      const sent = h.port.proposeTrack.mock.calls[0][0] as { options: { label: string }[]; storySubjects: string[] };
      expect(sent.options[0].label).toBe('Rally Finland Results');
      expect(sent.storySubjects).toEqual([]);
      expect(stagedTrack(out).storySubjects).toEqual([]);
    }
  });

  it('a model option that is personal goes too', async () => {
    const options = [{ label: 'My Rally Finland', search: 'x' }, ...MODEL_OPTIONS.options];
    const h = harness([route(), save(NO_STAKE), card(options)]);
    await runAgentTurn({ state: createAgentState(PERSONA), userMessage: "I'm into rally finland", deps: h.deps });
    const sent = h.port.proposeTrack.mock.calls[0][0] as { options: { label: string }[] };
    expect(sent.options.map((o) => o.label)).not.toContain('My Rally Finland');
  });

  it.each([
    ["I'm into Formula 1", "I'm into formula 1"],
    ['my club Ajax', 'I love my club Ajax'],
    ['into cycling', 'I am into cycling'],
    ['Ik volg PSV', 'Ik volg PSV en Ajax'],
    ['मुझे क्रिकेट', 'मुझे क्रिकेट पसंद है'],
    // No word list: the whole message came back, in any language.
    ['Me encanta la Fórmula 1', 'Me encanta la Fórmula 1'],
    ['Ich mag Formel 1 wirklich sehr', 'Ich mag Formel 1 wirklich sehr'],
  ])('refuses %p', (subject, message) => {
    expect(isUsableSubject(subject, message)).toBe(false);
  });

  it.each([
    ['Formula 1', "I'm into Formula 1"],
    ['Formule 1', 'Ik ben dol op Formule 1'],
    ['क्रिकेट', 'मुझे क्रिकेट पसंद है'],
    ['US elections', 'I care about the US elections'],
    ['Formula 1', 'Formula 1'],
  ])('keeps %p', (subject, message) => {
    expect(isUsableSubject(subject, message)).toBe(true);
  });
});

describe('the answer to the impact question', () => {
  const asked = () => {
    const state = createAgentState(PERSONA);
    state.turn.lastUserMessage = "I'm into rally finland";
    withImpactQuestion(state.turn, 'Before I add it, how does this affect you?');
    return state;
  };

  it('sets the question on the turn, with facts/interest as the skill it resumes', () => {
    const state = asked();
    expect(state.turn.lastQuestion).toBe('Before I add it, how does this affect you?');
    expect(state.turn.lastSkill).toBe('facts/interest');
    expect(state.turn.lastTurnAskedQuestion).toBe(true);
    expect(state.turn.recentExchanges[state.turn.recentExchanges.length - 1].reply).toContain('Before I add it');
  });

  it('a real impact stages a fact card written from the answer', async () => {
    const h = harness([route(), save(STAKE), res({ content: 'That helps.' })]);
    await runAgentTurn({ state: asked(), userMessage: 'I marshal there every year', deps: h.deps });
    expect(h.port.saveExtractedFacts).toHaveBeenCalledTimes(1);
    expect(h.port.proposeTrack).not.toHaveBeenCalled();
  });

  it('no impact gets one line and no second card, and the follow card stays open', async () => {
    const h = harness([route(), save(NO_STAKE), res({ content: 'Then following it is the better fit.' })]);
    const out = await runAgentTurn({ state: asked(), userMessage: 'it does not, I just like it', deps: h.deps });
    expect(h.port.saveExtractedFacts).not.toHaveBeenCalled();
    expect(h.port.proposeTrack).not.toHaveBeenCalled();
    expect(h.requests[2].tools).toEqual([]);
    expect(out.reply).toContain('better fit');
  });

  it('a plain no resumes the question rather than cancelling the waiting card', async () => {
    const state = asked();
    state.pendingProposal = { id: 'track-1', summary: 'Rally Finland', chooseOne: true, appliable: false, multiSelect: true };
    state.turn.lastCard = { proposalId: 'track-1', skill: 'conversation/follow-story', turn: 1 };
    const cancelProposal = jest.fn(async () => ({ cancelled: true }));
    const h = harness([res({ content: 'Then following it is the better fit.' })], { cancelProposal });
    const out = await runAgentTurn({ state, userMessage: 'no', deps: h.deps });
    expect(h.requests[0].role).toBe('tool');
    expect(h.requests[0].tools).toEqual([]);
    expect(cancelProposal).not.toHaveBeenCalled();
    expect(out.reply).toContain('better fit');
    expect(out.forcedProposal).toBe(false);
  });

  it('lasts one turn', async () => {
    const state = asked();
    const h = harness([route(), save(STAKE), res({ content: 'That helps.' }), route(), save(NO_STAKE), card()]);
    await runAgentTurn({ state, userMessage: 'I marshal there every year', deps: h.deps });
    await runAgentTurn({ state, userMessage: "and I'm into rally sweden", deps: h.deps });
    expect(h.port.proposeTrack).toHaveBeenCalledTimes(1);
  });
});

describe('with no follow path', () => {
  it('a false entry is today\'s fact card', async () => {
    const h = harness([route(), save(NO_STAKE), res({ content: 'Nice.' })], { proposeTrack: undefined });
    await runAgentTurn({ state: createAgentState(PERSONA), userMessage: "I'm into rally finland", deps: h.deps });
    expect(h.port.saveExtractedFacts).toHaveBeenCalledTimes(1);
  });
});
