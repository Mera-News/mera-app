// ux1 audit regressions, each driven through the real loop with a scripted
// model. Every case here failed on the loop as it was before ux1.

import { createAgentState, runAgentTurn, type AgentPersona } from '../core';
import { CANONICAL_LOCATION_KEY, COMBINED_ORIGIN_KEY, EXPAT_KEY, ORIGIN_KEY } from '../combined-fact';
import type { AgentDeps, AgentModelResult, Place } from '../types';

const AMS: Place = {
  locality: 'Amsterdam', admin1: 'North Holland', countryCode: 'NL', countryName: 'Netherlands', bloc: 'EU',
};
const ALK: Place = { ...AMS, locality: 'Alkmaar' };

function res(over: Partial<AgentModelResult> = {}): AgentModelResult {
  return {
    content: '', toolCalls: [], finishReason: 'stop', truncated: false,
    usage: null, modelSent: 'fake', latencyMs: 1, error: null, ...over,
  };
}
const tc = (name: string, args: unknown) => ({ name, argumentsRaw: JSON.stringify(args) });

const SKILLS: Record<string, string> = {
  'facts/residence': 'RESIDENCE SKILL BODY',
  'facts/interest': 'INTEREST SKILL BODY',
  'facts/origin': 'ORIGIN SKILL BODY',
  'facts/profession': 'PROFESSION SKILL BODY',
  'conversation/question': 'QUESTION SKILL BODY',
  'topics/origin': 'x',
  'topics/residence': 'x',
};

interface Call {
  systemPrompt: string;
  tools: { function: { name: string } }[];
  toolChoice?: string;
  stateLine: string;
}

function harness(
  script: AgentModelResult[],
  over: Partial<AgentDeps['tools']> = {},
  extra: Partial<AgentDeps> = {},
) {
  const calls: Call[] = [];
  const saves: Record<string, unknown>[][] = [];
  let i = 0;
  const deps: AgentDeps = {
    callModel: async (req) => {
      calls.push({
        systemPrompt: req.systemPrompt,
        tools: (req.tools ?? []) as Call['tools'],
        toolChoice: req.toolChoice,
        stateLine: req.messages[0]?.content ?? '',
      });
      const out = script[Math.min(i++, script.length - 1)];
      if (out.content) req.onDelta?.({ content: out.content });
      return out;
    },
    tools: {
      findSimilarFacts: async () => ({ candidates: [] }),
      lookupPlace: async () => ({ status: 'resolved', places: [AMS] }),
      saveExtractedFacts: async (args) => {
        saves.push((args.extracted_user_information as Record<string, unknown>[]) ?? []);
        return { staged: true };
      },
      deleteUserFacts: async () => ({ deleted: [] }),
      ...over,
    },
    loadSkill: (id) => SKILLS[id] ?? null,
    skillIds: () => Object.keys(SKILLS),
    ...extra,
  };
  return { deps, calls, saves };
}

const RESIDENT: AgentPersona = {
  surface: 'CONFIG',
  languageName: 'English',
  facts: [{ id: 'home', statement: 'Lives in Amsterdam, North Holland, Netherlands, EU', attribute: 'location: residence' }],
};

describe('B1 (G1 part): ask_choice ends the turn, not the leg', () => {
  it('a save placed after the question in the same leg still reaches the tool', async () => {
    const h = harness([
      res({ content: 'Berlin, one moment.', toolCalls: [tc('load_skill', { id: 'facts/residence' })] }),
      res({
        toolCalls: [
          tc('ask_choice', { question: 'Which Berlin?', options: ['Berlin, Germany', 'Berlin, USA'] }),
          tc('saveExtractedFacts', {
            extracted_user_information: [
              { statement: 'Product manager', questionnaire_attribute: 'profession: job role and industry' },
            ],
          }),
        ],
      }),
    ]);
    const out = await runAgentTurn({
      state: createAgentState(RESIDENT),
      userMessage: "I'm a product manager and I moved to Berlin",
      deps: h.deps,
    });
    expect(out.terminalReason).toBe('awaiting-user');
    expect(h.saves.flat().map((e) => e.statement)).toEqual(['Product manager']);
  });
});

describe('B13: a facts turn ends with an offer', () => {
  it('the last leg is the forced offer, even when the turn walks to the cap', async () => {
    const h = harness([
      res({ content: 'The Champions League.', toolCalls: [tc('load_skill', { id: 'facts/interest' })] }),
      res({ toolCalls: [tc('find_similar_facts', { kind: 'interest' })] }),
      res({ toolCalls: [tc('find_similar_facts', { kind: 'generic' })] }),
      res({
        content: 'Let me check what you already follow, then I can offer this.',
        toolCalls: [tc('saveExtractedFacts', { extracted_user_information: [{ statement: 'Follows the Champions League' }] })],
      }),
    ]);
    const out = await runAgentTurn({
      state: createAgentState(RESIDENT),
      userMessage: 'I also follow the Champions League',
      deps: h.deps,
    });
    expect(h.calls[3].toolChoice).toBe('required');
    expect(h.calls[3].tools.map((t) => t.function.name)).toEqual(['saveExtractedFacts', 'ask_choice']);
    expect(out.proposals.map((p) => p.statement)).toEqual(['Follows the Champions League']);
    // The promise is not shipped beside the card.
    expect(out.reply).toBe('');
  });

  it('a conversation turn that promises instead of answering is re-asked', async () => {
    const h = harness([
      res({ content: 'The Champions League.', toolCalls: [tc('load_skill', { id: 'conversation/question' })] }),
      res({ content: 'Let me check what you already follow, then I can offer this.' }),
      res({ content: 'Do you want me to add the Champions League?' }),
    ]);
    const out = await runAgentTurn({
      state: createAgentState(RESIDENT),
      userMessage: 'what about the champions league',
      deps: h.deps,
    });
    expect(out.processRetries).toBe(1);
    expect(out.reply).toBe('Do you want me to add the Champions League?');
  });
});

describe('B14: the acknowledgement is never the reply', () => {
  it('planning narration from the route leg reaches neither bubble', async () => {
    const h = harness([
      res({
        content: "I'll start by loading the appropriate skill for this turn.",
        toolCalls: [tc('load_skill', { id: 'conversation/question' })],
      }),
      res({ toolCalls: [tc('ask_choice', { question: 'Save it?', options: ['Save', 'No thanks'] })] }),
    ]);
    const out = await runAgentTurn({ state: createAgentState(RESIDENT), userMessage: 'Yes please add it.', deps: h.deps });
    expect(out.reply).toBe('');
    expect(out.acknowledgement).toBe('');
  });

  it('keeps a real acknowledgement apart from the answer', async () => {
    const h = harness([
      res({ content: 'Porto, one moment.', toolCalls: [tc('load_skill', { id: 'facts/residence' })] }),
      res({ toolCalls: [tc('saveExtractedFacts', { extracted_user_information: [{ statement: 'Lives in Porto' }] })] }),
      res({ content: 'Here it is to confirm.' }),
    ]);
    const out = await runAgentTurn({ state: createAgentState(RESIDENT), userMessage: 'I live in Porto', deps: h.deps });
    expect(out.acknowledgement).toBe('Porto, one moment.');
    expect(out.reply).toBe('Here it is to confirm.');
  });

  it('streams the route leg only, so the reading text is never swapped', async () => {
    const deltas: string[] = [];
    const h = harness([
      res({ content: 'Porto, one moment.', toolCalls: [tc('load_skill', { id: 'facts/residence' })] }),
      res({ content: 'interim', toolCalls: [tc('saveExtractedFacts', { extracted_user_information: [{ statement: 'Lives in Porto' }] })] }),
      res({ content: 'Here it is to confirm.' }),
    ]);
    await runAgentTurn({
      state: createAgentState(RESIDENT),
      userMessage: 'I live in Porto',
      deps: h.deps,
      onDelta: (d) => { if (d.content) deltas.push(d.content); },
    });
    expect(deltas).toEqual(['Porto, one moment.']);
  });
});

describe('Q1: the replacement card is the consent for a same-key replace', () => {
  const save = (entry: Record<string, unknown>) =>
    res({ toolCalls: [tc('saveExtractedFacts', { extracted_user_information: [entry] })] });

  it('honours a same-key replace without a chip tap', async () => {
    const h = harness([
      res({ content: 'Berlin.', toolCalls: [tc('load_skill', { id: 'facts/residence' })] }),
      save({ statement: 'Lives in Berlin, Germany, EU', questionnaire_attribute: CANONICAL_LOCATION_KEY, replaces: 'home' }),
      res({ content: 'Here it is.' }),
    ]);
    const out = await runAgentTurn({ state: createAgentState(RESIDENT), userMessage: 'I moved to Berlin', deps: h.deps });
    expect(out.proposals[0].replaces).toBe('home');
    expect(h.saves[0][0].replaces).toBe('home');
  });

  it('still needs a chip for a replace across keys', async () => {
    const h = harness([
      res({ content: 'OK.', toolCalls: [tc('load_skill', { id: 'facts/profession' })] }),
      save({ statement: 'Product manager', questionnaire_attribute: 'profession: job role and industry', replaces: 'home' }),
      res({ content: 'Here it is.' }),
    ]);
    const out = await runAgentTurn({ state: createAgentState(RESIDENT), userMessage: 'I am a PM', deps: h.deps });
    expect(out.proposals[0].replaces).toBeNull();
  });

  it('a home fact is never replaced by a fact under another key, even after a tap', async () => {
    const h = harness([
      res({ content: 'India.', toolCalls: [tc('load_skill', { id: 'facts/origin' })] }),
      // An ORIGIN fact aimed at the home (a combined statement is now split
      // into three facts before this guard ever sees it).
      save({ statement: 'From India', questionnaire_attribute: ORIGIN_KEY, replaces: 'home' }),
      res({ content: 'Here it is.' }),
    ]);
    const state = createAgentState(RESIDENT);
    state.turn.resolvedChoice = { question: 'Replace?', text: 'Yes', payload: null };
    const out = await runAgentTurn({ state, userMessage: 'I am from India', deps: h.deps });
    expect(out.proposals[0].replaces).toBeNull();
    expect(out.refusedReplaces).toBe(1);
  });

  it('carries the tapped place through the turns that resume the asking skill', async () => {
    const lookupPlace = jest.fn(async () => ({ status: 'resolved' as const, places: [AMS, ALK] }));
    const state = createAgentState(RESIDENT);
    const t1 = harness([
      res({ content: 'One moment.', toolCalls: [tc('load_skill', { id: 'facts/residence' })] }),
      res({ toolCalls: [tc('lookup_place', { query: 'Nieuw-West' }), tc('ask_choice', { question: 'Which?', options: ['Amsterdam', 'Alkmaar'] })] }),
    ], { lookupPlace });
    await runAgentTurn({ state, userMessage: 'I moved to Nieuw-West', deps: t1.deps });

    const t2 = harness([res({ toolCalls: [tc('ask_choice', { question: 'Which part?', options: ['Centrum', 'Noord'] })] })], { lookupPlace });
    await runAgentTurn({ state, userMessage: 'Amsterdam', deps: t2.deps });
    expect(t2.calls[0].stateLine).toContain('Place resolved: Amsterdam');

    const t3 = harness([res({ content: 'Here it is.' })], { lookupPlace });
    await runAgentTurn({ state, userMessage: 'Centrum', deps: t3.deps });
    // Resumed again: the place from the FIRST tap is still resolved.
    expect(t3.calls[0].stateLine).toContain('Place resolved: Amsterdam');
    expect(lookupPlace).toHaveBeenCalledTimes(1);
  });

  it('a resumed turn does not re-offer a card still waiting on screen', async () => {
    const state = createAgentState(RESIDENT);
    const t1 = harness([
      res({ content: 'One moment.', toolCalls: [tc('load_skill', { id: 'facts/residence' })] }),
      res({
        toolCalls: [
          tc('saveExtractedFacts', { extracted_user_information: [{ statement: 'Product manager' }] }),
          tc('ask_choice', { question: 'Which?', options: ['Amsterdam', 'Alkmaar'] }),
        ],
      }),
    ], { lookupPlace: async () => ({ status: 'resolved', places: [AMS, ALK] }) });
    await runAgentTurn({ state, userMessage: 'PM, moved to Nieuw-West', deps: t1.deps });

    const t2 = harness([
      res({ toolCalls: [tc('saveExtractedFacts', { extracted_user_information: [{ statement: 'Product manager' }, { statement: 'Lives in Amsterdam' }] })] }),
      res({ content: 'Here it is.' }),
    ]);
    const out = await runAgentTurn({ state, userMessage: 'Amsterdam', deps: t2.deps });
    expect(t2.saves[0].map((e) => e.statement)).toEqual(['Lives in Amsterdam']);
    expect(out.reProposals).toBe(1);
  });
});

describe('Q3: a typed yes continues the question it answers', () => {
  it('resumes the asking skill, echoes the question, and never confirms', async () => {
    const state = createAgentState(RESIDENT);
    const t1 = harness([
      res({ content: 'Football.', toolCalls: [tc('load_skill', { id: 'facts/interest' })] }),
      res({ content: 'Want me to add the Champions League?' }),
    ]);
    await runAgentTurn({ state, userMessage: 'I watch the Champions League sometimes', deps: t1.deps });

    const deleteUserFacts = jest.fn(async () => ({ deleted: ['home'] }));
    const t2 = harness([
      res({ toolCalls: [tc('deleteUserFacts', { fact_ids: ['home'] }), tc('saveExtractedFacts', { extracted_user_information: [{ statement: 'Follows the Champions League' }] })] }),
      res({ content: 'Offering the Champions League.' }),
    ], { deleteUserFacts });
    const out = await runAgentTurn({ state, userMessage: 'Yes please add it.', deps: t2.deps });

    expect(t2.calls[0].systemPrompt).toBe('INTEREST SKILL BODY');
    expect(t2.calls[0].stateLine).toContain('They answered yes to your question: "Want me to add the Champions League?"');
    expect(out.typedYesResume).toBe(true);
    expect(deleteUserFacts).not.toHaveBeenCalled();
    expect(out.proposals.map((p) => p.statement)).toEqual(['Follows the Champions League']);
  });

  it('a yes that carries anything else routes normally', async () => {
    const state = createAgentState(RESIDENT);
    state.turn.lastQuestion = 'Want me to add it?';
    state.turn.lastSkill = 'facts/interest';
    const h = harness([res({ content: 'F1.', toolCalls: [tc('load_skill', { id: 'facts/interest' })] }), res({ content: 'ok' })]);
    const out = await runAgentTurn({ state, userMessage: 'yes, and I also follow Formula 1', deps: h.deps });
    expect(out.typedYesResume).toBe(false);
    expect(h.calls[0].tools.map((t) => t.function.name)).toEqual(['load_skill']);
  });
});

describe('Q2: a combined origin-and-home fact is offered its split once', () => {
  const COMBINED: AgentPersona = {
    surface: 'CONFIG',
    languageName: 'English',
    facts: [{ id: 'c1', statement: 'Expat from India living in Amsterdam, Netherlands, EU', attribute: COMBINED_ORIGIN_KEY }],
  };

  it('offers the origin half as a replacement and adds the home half', async () => {
    const offered = new Set<string>();
    const onLeg = jest.fn();
    const h = harness(
      [
        res({ content: 'India.', toolCalls: [tc('load_skill', { id: 'facts/origin' })] }),
        res({ content: 'Got it.' }),
      ],
      {},
      { combinedFactRewrite: { wasOffered: (id) => offered.has(id), markOffered: (id) => { offered.add(id); } } },
    );
    const out = await runAgentTurn({ state: createAgentState(COMBINED), userMessage: 'I grew up in India', deps: h.deps, onLeg });

    expect(out.combinedRewriteOffered).toBe('c1');
    const split = h.saves[h.saves.length - 1];
    // Three separate facts (owner decision): origin, expat status, home.
    expect(split).toEqual([
      { statement: 'From India', questionnaire_attribute: ORIGIN_KEY, replaces: 'c1', topic_skill_id: 'topics/origin' },
      { statement: 'Expat in Netherlands', questionnaire_attribute: EXPAT_KEY, topic_skill_id: 'topics/origin' },
      { statement: 'Lives in Amsterdam, Netherlands, EU', questionnaire_attribute: CANONICAL_LOCATION_KEY, topic_skill_id: 'topics/residence' },
    ]);
    // The synthetic leg reaches the UI like any other.
    expect(onLeg.mock.calls[onLeg.mock.calls.length - 1][0].synthetic).toBe(true);

    const again = harness(
      [res({ content: 'India.', toolCalls: [tc('load_skill', { id: 'facts/origin' })] }), res({ content: 'Got it.' })],
      {},
      { combinedFactRewrite: { wasOffered: (id) => offered.has(id), markOffered: () => {} } },
    );
    const second = await runAgentTurn({ state: createAgentState(COMBINED), userMessage: 'I am from India', deps: again.deps });
    expect(second.combinedRewriteOffered).toBeNull();
  });

  it('merges with the skill\'s own origin card instead of offering a second one', async () => {
    const onLeg = jest.fn();
    const h = harness([
      res({ content: 'India.', toolCalls: [tc('load_skill', { id: 'facts/origin' })] }),
      res({ toolCalls: [tc('saveExtractedFacts', { extracted_user_information: [{ statement: 'Expat from India', questionnaire_attribute: ORIGIN_KEY }] })] }),
      res({ content: 'Got it.' }),
    ]);
    const out = await runAgentTurn({ state: createAgentState(COMBINED), userMessage: 'I am from India', deps: h.deps, onLeg });
    const all = h.saves.flat();
    // ONE origin card, and it is the one that retires the combined fact.
    expect(all.filter((e) => e.statement === 'Expat from India')).toEqual([
      expect.objectContaining({ replaces: 'c1' }),
    ]);
    // The home half is still offered, since no home fact is on file.
    expect(all.map((e) => e.statement)).toContain('Lives in Amsterdam, Netherlands, EU');
    expect(out.combinedRewriteOffered).toBe('c1');
  });

  it('is not offered on a turn about something else', async () => {
    const h = harness([res({ content: 'Chess.', toolCalls: [tc('load_skill', { id: 'facts/interest' })] }), res({ content: 'ok' })]);
    const out = await runAgentTurn({ state: createAgentState(COMBINED), userMessage: 'I play chess', deps: h.deps });
    expect(out.combinedRewriteOffered).toBeNull();
  });
});

describe('F7 ruling: a typed reply while a card waits', () => {
  it('a plain no resumes the question and is read as a no', async () => {
    const state = createAgentState(RESIDENT);
    state.turn.lastQuestion = 'Want me to add the Champions League?';
    state.turn.lastSkill = 'facts/interest';
    const h = harness([res({ content: 'Fine, leaving it out.' })]);
    const out = await runAgentTurn({ state, userMessage: 'No thanks', deps: h.deps });
    expect(out.typedYesResume).toBe(true);
    expect(h.calls[0].systemPrompt).toBe('INTEREST SKILL BODY');
    expect(h.calls[0].stateLine).toContain('They answered no to your question');
  });

  it('anything else is a new turn that never re-offers a card still waiting', async () => {
    const state = createAgentState(RESIDENT);
    state.pendingCardStatements = ['Lives in Berlin, Germany, EU'];
    const h = harness([
      res({ content: 'Berlin.', toolCalls: [tc('load_skill', { id: 'facts/residence' })] }),
      res({ toolCalls: [tc('saveExtractedFacts', { extracted_user_information: [{ statement: 'Lives in Berlin, Germany, EU' }, { statement: 'Works in Mitte' }] })] }),
      res({ content: 'Here it is.' }),
    ]);
    const out = await runAgentTurn({ state, userMessage: 'the one in Germany, I work in Mitte', deps: h.deps });
    expect(out.typedYesResume).toBe(false);
    expect(h.saves[0].map((e) => e.statement)).toEqual(['Works in Mitte']);
    expect(h.calls[1].stateLine).toContain('Cards already waiting for the user: "Lives in Berlin, Germany, EU"');
  });
});

// Batch 3 device captures (ux1 C1, C3, C4).
describe('batch 3 captures', () => {
  it('C1: marks only the route leg for streaming to the user', async () => {
    const flags: (boolean | undefined)[] = [];
    const h = harness([
      res({ content: 'Porto.', toolCalls: [tc('load_skill', { id: 'facts/residence' })] }),
      res({ content: 'Which Porto did you mean?', toolCalls: [tc('ask_choice', { question: 'Which Porto?', options: ['Porto, Portugal', 'Porto Alegre'] })] }),
    ]);
    const inner = h.deps.callModel;
    h.deps.callModel = async (req) => { flags.push(req.streamToUser); return inner(req); };
    await runAgentTurn({ state: createAgentState(RESIDENT), userMessage: 'I moved to Porto', deps: h.deps });
    expect(flags).toEqual([true, false]);
  });

  it('C1: the combined-fact split waits until the question is answered', async () => {
    const COMBINED: AgentPersona = {
      surface: 'CONFIG', languageName: 'English',
      facts: [{ id: 'c1', statement: 'Expat from India living in Nieuw West, Amsterdam', attribute: COMBINED_ORIGIN_KEY }],
    };
    const h = harness([
      res({ content: 'Porto.', toolCalls: [tc('load_skill', { id: 'facts/residence' })] }),
      res({ toolCalls: [tc('ask_choice', { question: 'Which Porto?', options: ['Porto, Portugal', 'Porto Alegre'] })] }),
    ]);
    const out = await runAgentTurn({ state: createAgentState(COMBINED), userMessage: 'I moved to Porto', deps: h.deps });
    expect(out.terminalReason).toBe('awaiting-user');
    expect(out.combinedRewriteOffered).toBeNull();
    expect(h.saves).toEqual([]);
  });

  it('C3: a reply saying it is already on file gets no forced offer', async () => {
    const onFile: AgentPersona = {
      surface: 'CONFIG', languageName: 'English',
      facts: [{ id: 'e1', statement: 'Follows EU regulation', attribute: 'topics: general interests' }],
    };
    const h = harness([
      res({ content: 'EU regulation.', toolCalls: [tc('load_skill', { id: 'facts/interest' })] }),
      res({ content: "That's already on file, and no new specifics were added. I'll leave your profile as it is." }),
      res({ toolCalls: [tc('saveExtractedFacts', { extracted_user_information: [{ statement: 'Follows EU regulation' }] })] }),
    ]);
    const out = await runAgentTurn({ state: createAgentState(onFile), userMessage: 'I follow EU regulation', deps: h.deps });
    expect(out.forcedProposal).toBe(false);
    expect(h.saves.flat()).toEqual([]);
    expect(out.terminalReason).toBe('settled');
    expect(out.replyRetries).toBe(0);
  });

  it('C3: a fact already on file is never offered again, even in other words', async () => {
    const onFile: AgentPersona = {
      surface: 'CONFIG', languageName: 'English',
      facts: [{ id: 'e1', statement: 'Follows the EU regulation.', attribute: 'topics: general interests' }],
    };
    const h = harness([
      res({ content: 'EU regulation.', toolCalls: [tc('load_skill', { id: 'facts/interest' })] }),
      res({ toolCalls: [tc('saveExtractedFacts', { extracted_user_information: [{ statement: 'Follows EU regulation' }, { statement: 'Follows the DMA' }] })] }),
      res({ content: 'Here it is.' }),
    ]);
    const out = await runAgentTurn({ state: createAgentState(onFile), userMessage: 'I follow EU regulation and the DMA', deps: h.deps });
    expect(h.saves[0].map((e) => e.statement)).toEqual(['Follows the DMA']);
    expect(out.reProposals).toBe(1);
  });

  it('C4: an acknowledgement narrating how it read the message is dropped', async () => {
    const h = harness([
      res({ content: 'I read that as answering the Porto question, but the word does not fit.', toolCalls: [tc('load_skill', { id: 'facts/origin' })] }),
      res({ content: 'Got it, from India.' }),
    ]);
    const out = await runAgentTurn({ state: createAgentState(RESIDENT), userMessage: 'I am originally from India', deps: h.deps });
    expect(out.acknowledgement).toBe('');
    expect(h.calls[0].stateLine).not.toContain('Your last turn asked');
  });
});

// Batch 4 device captures (ux1 C1, C4).
describe('batch 4 captures', () => {
  it('C1: two readings of the same new home are ONE card', async () => {
    const h = harness([
      res({ content: 'Porto.', toolCalls: [tc('load_skill', { id: 'facts/residence' })] }),
      res({
        toolCalls: [tc('saveExtractedFacts', {
          extracted_user_information: [
            { statement: 'Lives in Porto, Portugal, EU', questionnaire_attribute: CANONICAL_LOCATION_KEY, replaces: 'home' },
            { statement: 'Lives in Porto, Porto, Portugal, EU', questionnaire_attribute: CANONICAL_LOCATION_KEY, replaces: 'home' },
          ],
        })],
      }),
      res({ content: 'Here it is.' }),
    ]);
    const out = await runAgentTurn({ state: createAgentState(RESIDENT), userMessage: 'Porto, Portugal', deps: h.deps });
    // The richer chain wins; a turn never offers two current homes.
    // The richer chain wins, and its repeated rung is collapsed (batch 5).
    expect(h.saves.flat().map((e) => e.statement)).toEqual(['Lives in Porto, Portugal, EU']);
    expect(out.reProposals).toBe(1);
  });

  it('C1: a second home offered on a later leg is dropped', async () => {
    const h = harness([
      res({ content: 'Porto.', toolCalls: [tc('load_skill', { id: 'facts/residence' })] }),
      res({ toolCalls: [tc('saveExtractedFacts', { extracted_user_information: [{ statement: 'Lives in Porto, Portugal, EU', questionnaire_attribute: CANONICAL_LOCATION_KEY }] })] }),
      res({ toolCalls: [tc('saveExtractedFacts', { extracted_user_information: [{ statement: 'Lives in Porto, Porto, Portugal, EU', questionnaire_attribute: CANONICAL_LOCATION_KEY }] })] }),
      res({ content: 'Here it is.' }),
    ]);
    await runAgentTurn({ state: createAgentState(RESIDENT), userMessage: 'Porto, Portugal', deps: h.deps });
    expect(h.saves.flat().map((e) => e.statement)).toEqual(['Lives in Porto, Portugal, EU']);
  });

  it('C4: a replaced leak beside a card does not ask for more', async () => {
    const leak = "I'll extract the fact about their residence from your message.";
    const h = harness([
      res({ content: 'India.', toolCalls: [tc('load_skill', { id: 'facts/origin' })] }),
      res({ toolCalls: [tc('saveExtractedFacts', { extracted_user_information: [{ statement: 'Expat from India', questionnaire_attribute: ORIGIN_KEY }] })] }),
      res({ content: leak }),
      res({ content: leak }),
    ]);
    const out = await runAgentTurn({ state: createAgentState(RESIDENT), userMessage: 'I am from India', deps: h.deps });
    expect(out.replyLeakUnfixed).toBe(true);
    expect(out.reply).toBe('');
  });
});

// Batch 5 device capture (ux1 C1): "I moved to Porto" beside "Lives in
// Berlin..." produced a plain Add card, which would leave two homes.
describe('batch 5: a move replaces the current home', () => {
  const BERLIN_HOME: AgentPersona = {
    surface: 'CONFIG', languageName: 'English',
    facts: [
      { id: 'job', statement: 'Product manager', attribute: 'profession: job role and industry' },
      // The model had written the SHORT key form: it must still count.
      { id: 'berlin', statement: 'Lives in Berlin, State of Berlin, Germany, EU', attribute: 'location: residence' },
    ],
  };
  const move = (statement: string, extra: Record<string, unknown> = {}) => [
    res({ content: 'Porto.', toolCalls: [tc('load_skill', { id: 'facts/residence' })] }),
    res({ toolCalls: [tc('saveExtractedFacts', { extracted_user_information: [{ statement, questionnaire_attribute: CANONICAL_LOCATION_KEY, ...extra }] })] }),
    res({ content: 'Here it is.' }),
  ];

  it('a new home with no replaces targets the existing home', async () => {
    const h = harness(move('Lives in Porto, Portugal, EU'));
    const out = await runAgentTurn({ state: createAgentState(BERLIN_HOME), userMessage: 'I moved to Porto', deps: h.deps });
    expect(h.saves[0][0].replaces).toBe('berlin');
    expect(out.proposals[0].replaces).toBe('berlin');
  });

  it('finds a home written as a residence statement with no home key', async () => {
    const keyless: AgentPersona = {
      ...BERLIN_HOME,
      facts: [{ id: 'berlin', statement: 'Lives in Berlin, Germany', attribute: 'topics: general interests' }],
    };
    const h = harness(move('Lives in Porto, Portugal, EU'));
    await runAgentTurn({ state: createAgentState(keyless), userMessage: 'I moved to Porto', deps: h.deps });
    expect(h.saves[0][0].replaces).toBe('berlin');
  });

  it('never targets a relative\'s home', async () => {
    const family: AgentPersona = {
      ...BERLIN_HOME,
      facts: [{ id: 'parents', statement: 'Parents live in Bhopal, India', attribute: 'location: parents city' }],
    };
    const h = harness(move('Lives in Porto, Portugal, EU'));
    await runAgentTurn({ state: createAgentState(family), userMessage: 'I moved to Porto', deps: h.deps });
    expect(h.saves[0][0].replaces).toBeUndefined();
  });

  it('collapses a repeated place rung in the label', async () => {
    const h = harness(move('Lives in Porto, Porto, Portugal, EU'));
    await runAgentTurn({ state: createAgentState(BERLIN_HOME), userMessage: 'I moved to Porto', deps: h.deps });
    expect(h.saves[0][0].statement).toBe('Lives in Porto, Portugal, EU');
  });
});
