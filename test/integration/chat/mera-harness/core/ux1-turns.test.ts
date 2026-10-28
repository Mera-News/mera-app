// ux1 audit regressions, each driven through the real loop with a scripted
// model. Every case here failed on the loop as it was before ux1.

import { createAgentState, runAgentTurn, type AgentPersona } from '@/lib/mera-harness/core/core';
import { reconcilePlaceChain } from '@/lib/mera-harness/core/choice-binding';
import { buildStateLine } from '@/lib/mera-harness/core/state-line';
import { CANONICAL_LOCATION_KEY, COMBINED_ORIGIN_KEY, EXPAT_KEY, ORIGIN_KEY } from '@/lib/mera-harness/core/combined-fact';
import type { AgentDeps, AgentModelResult, Place } from '@/lib/mera-harness/core/types';

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
      res({ content: 'Berlin, one moment.', toolCalls: [tc('load_skill', { id: 'facts/origin' })] }),
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
      res({ content: 'One moment.', toolCalls: [tc('load_skill', { id: 'facts/origin' })] }),
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

    expect(t2.calls[0].systemPrompt.startsWith('INTEREST SKILL BODY')).toBe(true);
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
    // ONE origin card, and it is the one that retires the combined fact. The
    // model's "Expat from India" is saved as the origin alone.
    expect(all.filter((e) => /india/i.test(String(e.statement)))).toEqual([
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
    expect(h.calls[0].systemPrompt.startsWith('INTEREST SKILL BODY')).toBe(true);
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
      res({ content: 'Porto.', toolCalls: [tc('load_skill', { id: 'facts/origin' })] }),
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
      res({ content: 'Porto.', toolCalls: [tc('load_skill', { id: 'facts/origin' })] }),
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

describe('ux2 C4: a blocked delete names what it would remove', () => {
  it('attaches the statements of the facts it names, skipping unknown ids', async () => {
    const results: unknown[] = [];
    const h = harness([
      res({ content: 'Right.', toolCalls: [tc('load_skill', { id: 'conversation/question' })] }),
      res({ toolCalls: [tc('deleteUserFacts', { fact_ids: ['home', 'ghost'] })] }),
      res({ content: 'Shall I remove it?' }),
    ]);
    const out = await runAgentTurn({
      state: createAgentState(RESIDENT),
      userMessage: 'delete all my facts',
      deps: h.deps,
      onLeg: (leg) => results.push(...leg.toolResults.filter((r) => r.name === 'deleteUserFacts').map((r) => r.result)),
    });
    expect(out.legs.length).toBeGreaterThan(0);
    expect(results).toEqual([
      {
        error: expect.stringMatching(/card asks the user to confirm/),
        pendingFactIds: ['home'],
        pendingStatements: ['Lives in Amsterdam, North Holland, Netherlands, EU'],
      },
    ]);
  });
});

describe('ux2 D: districts, typos and the place the user named', () => {
  const NOBODY: AgentPersona = { surface: 'CONFIG', languageName: 'English', facts: [] };
  const VILA: Place = {
    locality: 'Vila Baleira', admin1: 'Madeira', countryCode: 'PT', countryName: 'Portugal', bloc: 'EU',
    userTerm: 'Porto Santo',
  };

  it('D1: the state line carries the finer area the lookup could not place', async () => {
    const h = harness(
      [
        res({ content: 'Amsterdam.', toolCalls: [tc('load_skill', { id: 'facts/residence' })] }),
        res({ toolCalls: [tc('lookup_place', { query: 'niew west amsterdam' })] }),
        res({ content: 'Noted.' }),
      ],
      { lookupPlace: async () => ({ status: 'resolved', places: [AMS], unmatched: 'niew west' }) },
    );
    await runAgentTurn({ state: createAgentState(NOBODY), userMessage: 'I live in niew west Amsterdam', deps: h.deps });
    expect(h.calls[2].stateLine).toContain('Finer area as the user wrote it: "niew west"');
  });

  it('D2: reconcilePlaceChain keeps a canonical district spelling of a typo', () => {
    expect(reconcilePlaceChain({ neighbourhood: 'Nieuw-West' }, [AMS], 'I live in niew west Amsterdam'))
      .toMatchObject({ locality: 'Amsterdam', neighbourhood: 'Nieuw-West' });
    expect(reconcilePlaceChain({ neighbourhood: 'Nieuw-Oost' }, [AMS], 'I live in niew west Amsterdam'))
      .toMatchObject({ locality: 'Amsterdam', neighbourhood: undefined });
  });

  it('D3+D5: a loop offer keeps the district, corrected, and settles the turn', async () => {
    const h = harness(
      [
        res({ content: 'Amsterdam.', toolCalls: [tc('load_skill', { id: 'facts/residence' })] }),
        res({ toolCalls: [tc('lookup_place', { query: 'niew west amsterdam' })] }),
        res({ content: 'You live in Nieuw-West in Amsterdam.' }),
      ],
      { lookupPlace: async () => ({ status: 'resolved', places: [AMS], unmatched: 'niew west' }) },
    );
    const out = await runAgentTurn({ state: createAgentState(NOBODY), userMessage: 'I live in niew west Amsterdam', deps: h.deps });
    expect(h.saves.flat().map((e) => e.statement)).toEqual([
      'Lives in Nieuw-West, Amsterdam, North Holland, Netherlands, EU',
    ]);
    expect(out.terminalReason).toBe('settled');
  });

  it('D3: with no model spelling, the user\'s own words are kept, never downgraded to the city', async () => {
    const h = harness(
      [
        res({ content: 'Amsterdam.', toolCalls: [tc('load_skill', { id: 'facts/residence' })] }),
        res({ toolCalls: [tc('lookup_place', { query: 'niew west amsterdam' })] }),
        res({ content: 'Noted.' }),
      ],
      { lookupPlace: async () => ({ status: 'resolved', places: [AMS], unmatched: 'niew west' }) },
    );
    await runAgentTurn({ state: createAgentState(NOBODY), userMessage: 'I live in niew west Amsterdam', deps: h.deps });
    expect(h.saves.flat().map((e) => e.statement)).toEqual([
      'Lives in Niew West, Amsterdam, North Holland, Netherlands, EU',
    ]);
  });

  it('D4: never proposes the home on a turn that asked about it, even a refused ask', async () => {
    const h = harness(
      [
        res({ content: 'Amsterdam.', toolCalls: [tc('load_skill', { id: 'facts/residence' })] }),
        res({ toolCalls: [tc('lookup_place', { query: 'amsterdam' })] }),
        res({ toolCalls: [tc('ask_choice', { question: 'Which part?', options: ['Nieuw-West', 'Nieuw-Oost'] })] }),
        res({ content: 'Tell me which part of Amsterdam.' }),
      ],
    );
    await runAgentTurn({ state: createAgentState(NOBODY), userMessage: 'I live in niew west Amsterdam', deps: h.deps });
    expect(h.saves.flat()).toEqual([]);
  });

  it('D7: a reply cut off by the token cap ends at its last whole sentence', async () => {
    const h = harness([
      res({ content: 'Sure.', toolCalls: [tc('load_skill', { id: 'conversation/question' })] }),
      res({ content: 'Porto Santo is an island in Madeira. Would you prefer', finishReason: 'length', truncated: true }),
    ]);
    const out = await runAgentTurn({ state: createAgentState(NOBODY), userMessage: 'what is porto santo', deps: h.deps });
    expect(out.reply).toBe('Porto Santo is an island in Madeira.');
  });

  it('D13a: a place matched through an alias keeps the user\'s term first', async () => {
    const h = harness(
      [
        res({ content: 'Porto Santo.', toolCalls: [tc('load_skill', { id: 'facts/residence' })] }),
        res({ toolCalls: [tc('lookup_place', { query: 'Porto Santo' })] }),
        res({ content: 'Noted.' }),
      ],
      { lookupPlace: async () => ({ status: 'resolved', places: [VILA] }) },
    );
    await runAgentTurn({ state: createAgentState(NOBODY), userMessage: 'I live in Porto Santo', deps: h.deps });
    expect(h.saves.flat().map((e) => e.statement)).toEqual([
      'Lives in Porto Santo (Vila Baleira), Madeira, Portugal, EU',
    ]);
  });

  it('D13b: an invented rung is removed and the user\'s term restored in a relative\'s fact', async () => {
    const h = harness(
      [
        res({ content: 'Porto Santo.', toolCalls: [tc('load_skill', { id: 'facts/origin' })] }),
        res({ toolCalls: [tc('lookup_place', { query: 'Porto Santo' })] }),
        res({
          toolCalls: [tc('saveExtractedFacts', {
            extracted_user_information: [
              { statement: "Girlfriend's parents live in Vila Baleira, Machico, Madeira, Portugal, EU" },
            ],
          })],
        }),
        res({ content: 'Offered.' }),
      ],
      { lookupPlace: async () => ({ status: 'resolved', places: [VILA] }) },
    );
    await runAgentTurn({
      state: createAgentState(NOBODY),
      userMessage: "My girlfriend's parents live in Porto Santo",
      deps: h.deps,
    });
    expect(h.saves.flat().map((e) => e.statement)).toEqual([
      "Girlfriend's parents live in Porto Santo (Vila Baleira), Madeira, Portugal, EU",
    ]);
  });
});

describe('ux2 owner: two cards for the SAME old fact become one', () => {
  const WORK = 'profession: job role and industry';
  const FOUNDER: AgentPersona = {
    surface: 'CONFIG',
    languageName: 'English',
    facts: [
      { id: 'w1', statement: 'Entrepreneur building a tech startup', attribute: WORK },
      { id: 'w2', statement: 'Founder starting a new business', attribute: WORK },
    ],
  };
  const save = (entries: unknown[]) => res({ toolCalls: [tc('saveExtractedFacts', { extracted_user_information: entries })] });

  it('merges two proposals for the same target into one, options de-duplicated', async () => {
    const h = harness([
      res({ content: 'An AI news app.', toolCalls: [tc('load_skill', { id: 'facts/profession' })] }),
      save([
        { statement: 'Founder of an AI news app', questionnaire_attribute: WORK, replaces: 'w2', alternatives: ['Developer building an AI news app'] },
        { statement: 'Developer building an AI news app', questionnaire_attribute: WORK, replaces: 'w2', alternatives: ['Building an AI curated news app'] },
      ]),
      res({ content: 'Offered.' }),
    ]);
    await runAgentTurn({ state: createAgentState(FOUNDER), userMessage: "I'm building an ai news app", deps: h.deps });
    const entries = h.saves.flat();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      statement: 'Founder of an AI news app',
      replaces: 'w2',
      alternatives: ['Developer building an AI news app', 'Building an AI curated news app'],
    });
  });

  it('keeps one card per DIFFERENT overlapped fact', async () => {
    const h = harness([
      res({ content: 'An AI news app.', toolCalls: [tc('load_skill', { id: 'facts/profession' })] }),
      save([
        { statement: 'Building an AI news app', questionnaire_attribute: WORK, replaces: 'w1' },
        { statement: 'Founder of an AI curated news app', questionnaire_attribute: WORK, replaces: 'w2' },
      ]),
      res({ content: 'Offered.' }),
    ]);
    await runAgentTurn({ state: createAgentState(FOUNDER), userMessage: "I'm building an ai news app", deps: h.deps });
    expect(h.saves.flat().map((e) => e.replaces)).toEqual(['w1', 'w2']);
  });

  it('a later leg never offers a second card for a fact already targeted this turn', async () => {
    const h = harness([
      res({ content: 'An AI news app.', toolCalls: [tc('load_skill', { id: 'facts/profession' })] }),
      save([{ statement: 'Founder of an AI news app', questionnaire_attribute: WORK, replaces: 'w2' }]),
      save([{ statement: 'Building an AI curated news app', questionnaire_attribute: WORK, replaces: 'w2' }]),
      res({ content: 'Offered.' }),
    ]);
    await runAgentTurn({ state: createAgentState(FOUNDER), userMessage: "I'm building an ai news app", deps: h.deps });
    expect(h.saves.flat()).toHaveLength(1);
  });
});

describe('ux2 D10: the persona agent can search the web', () => {
  const NOBODY: AgentPersona = { surface: 'CONFIG', languageName: 'English', facts: [] };
  const names = (c: Call) => c.tools.map((t) => t.function.name);

  it('declares webSearch on facts and question legs, never on the route leg', async () => {
    const webSearch = jest.fn(async () => ({ searched: true, results: [] }));
    const h = harness(
      [
        res({ content: 'Sure.', toolCalls: [tc('load_skill', { id: 'conversation/question' })] }),
        res({ content: 'Porto Santo is an island.' }),
      ],
      { webSearch },
    );
    await runAgentTurn({ state: createAgentState(NOBODY), userMessage: 'what is porto santo', deps: h.deps });
    expect(names(h.calls[0])).not.toContain('webSearch');
    expect(names(h.calls[1])).toContain('webSearch');
  });

  it('is not declared when the port has no webSearch (the setting is off)', async () => {
    const h = harness([
      res({ content: 'Sure.', toolCalls: [tc('load_skill', { id: 'conversation/question' })] }),
      res({ content: 'An island.' }),
    ]);
    await runAgentTurn({ state: createAgentState(NOBODY), userMessage: 'what is porto santo', deps: h.deps });
    expect(names(h.calls[1])).not.toContain('webSearch');
  });

  it('runs the search on the device and reads its result on the next leg', async () => {
    const webSearch = jest.fn(async () => ({ searched: true, results: [{ title: 'Porto Santo island' }] }));
    const h = harness(
      [
        res({ content: 'Sure.', toolCalls: [tc('load_skill', { id: 'conversation/question' })] }),
        res({ toolCalls: [tc('webSearch', { queries: ['Porto Santo'] })] }),
        res({ content: 'Porto Santo is an island in the Madeira archipelago.' }),
      ],
      { webSearch },
    );
    const out = await runAgentTurn({ state: createAgentState(NOBODY), userMessage: 'what is porto santo', deps: h.deps });
    expect(webSearch).toHaveBeenCalledWith({ queries: ['Porto Santo'] });
    expect(out.reply).toBe('Porto Santo is an island in the Madeira archipelago.');
    expect(out.unknownTools).toEqual([]);
  });
});

describe('ux2 batch 27: a place chip shows the chain it stands for', () => {
  const NOBODY: AgentPersona = { surface: 'CONFIG', languageName: 'English', facts: [] };
  const TYNE: Place = { locality: 'Newcastle upon Tyne', admin1: 'England', countryCode: 'GB', countryName: 'United Kingdom', bloc: 'UK' };
  const NSW: Place = { locality: 'Newcastle', admin1: 'New South Wales', countryCode: 'AU', countryName: 'Australia', bloc: null };
  const LYME: Place = { locality: 'Newcastle-under-Lyme', admin1: 'England', countryCode: 'GB', countryName: 'United Kingdom', bloc: 'UK' };
  const CHAINS = [
    'Newcastle upon Tyne, England, United Kingdom',
    'Newcastle, New South Wales, Australia',
    'Newcastle-under-Lyme, England, United Kingdom',
  ];

  // The options the model wrote 5 of 5 times on staging (run 20260925-175739).
  const ask = async (options: string[], places: Place[] = [TYNE, NSW, LYME]) => {
    const legs: { toolCalls: { name: string; argumentsRaw: string }[]; toolResults: { name: string; result: unknown }[] }[] = [];
    const h = harness(
      [
        res({ content: 'Newcastle.', toolCalls: [tc('load_skill', { id: 'facts/residence' })] }),
        res({ toolCalls: [tc('lookup_place', { query: 'Newcastle' })] }),
        res({ toolCalls: [tc('ask_choice', { question: 'Which Newcastle?', options })] }),
      ],
      { lookupPlace: async () => ({ status: 'resolved', places }) },
    );
    const state = createAgentState(NOBODY);
    await runAgentTurn({ state, userMessage: 'I live in Newcastle', deps: h.deps, onLeg: (l) => legs.push(l as never) });
    const askCall = legs.flatMap((l) => l.toolCalls).find((c) => c.name === 'ask_choice');
    const askResult = legs.flatMap((l) => l.toolResults).find((r) => r.name === 'ask_choice');
    return {
      state,
      chips: state.turn.pendingChoice?.options.map((o) => o.text),
      persisted: (JSON.parse(askCall?.argumentsRaw ?? '{}') as { options?: string[] }).options,
      askResult,
    };
  };

  it('the Newcastle trio shows three distinct chains, the same in the loop and in the thread', async () => {
    const { chips, persisted } = await ask(['Newcastle upon Tyne', 'Newcastle', 'Newcastle-under-Lyme']);
    expect(chips).toEqual(CHAINS);
    // The thread derives its chips from the persisted call, and a tap sends
    // that text back, so the two must be identical.
    expect(persisted).toEqual(CHAINS);
  });

  it.each([[0, TYNE], [1, NSW], [2, LYME]] as const)('a tap on chip %i resolves its own place', async (i, place) => {
    const { state } = await ask(['Newcastle upon Tyne', 'Newcastle', 'Newcastle-under-Lyme']);
    const h = harness([res({ content: 'Offered.' })]);
    await runAgentTurn({ state, userMessage: CHAINS[i], deps: h.deps });
    expect(state.turn.confirmedPlace).toEqual(place);
  });

  it('batch 28: after a tapped place, a follow-up question is refused and the home is offered', async () => {
    // Captured on device: the NSW tap resumed facts/residence, the model asked
    // "Are you an expat in Australia, or originally from there?", and the turn
    // ended on that question with no card. residence.md asks only an AMBIGUOUS
    // place; a tapped place is not ambiguous.
    const { state } = await ask(['Newcastle upon Tyne', 'Newcastle', 'Newcastle-under-Lyme']);
    const results: { name: string; result: unknown }[] = [];
    const h = harness([
      res({ toolCalls: [tc('ask_choice', {
        question: 'Are you an expat in Australia, or originally from there?',
        options: ['Expat in Australia', 'Originally from Australia'],
      })] }),
      res({ toolCalls: [tc('saveExtractedFacts', { extracted_user_information: [
        { statement: 'Lives in Newcastle, New South Wales, Australia', questionnaire_attribute: CANONICAL_LOCATION_KEY },
      ] })] }),
      res({ content: 'Offered.' }),
    ]);
    await runAgentTurn({
      state, userMessage: CHAINS[1], deps: h.deps,
      onLeg: (l) => results.push(...l.toolResults),
    });
    expect(state.turn.confirmedPlace).toEqual(NSW);
    expect(results.find((r) => r.name === 'ask_choice')?.result).toHaveProperty('error');
    expect(state.turn.pendingChoice).toBeNull();
    expect(h.saves.flat().map((e) => e.statement)).toContain('Lives in Newcastle, New South Wales, Australia');
  });

  it('distinct chips that each name their country are left as the model wrote them', async () => {
    const options = ['Newcastle upon Tyne, UK', 'Newcastle, Australia'];
    const { chips, persisted } = await ask(options, [TYNE, NSW]);
    expect(chips).toEqual(options);
    expect(persisted).toEqual(options);
  });

  it('an unbound chip stays verbatim, and the save-as-written chip is untouched', async () => {
    const { chips, askResult } = await ask(['Newcastle', 'Somewhere else']);
    expect(chips).toEqual(['Newcastle, New South Wales, Australia', 'Somewhere else']);
    expect(askResult?.result).toMatchObject({ saveAsWritten: { statement: 'Lives in Newcastle' } });
  });
});

describe('ux2 batch 26 D6: a question turn is never left on its acknowledgement', () => {
  const NOBODY: AgentPersona = { surface: 'CONFIG', languageName: 'English', facts: [] };

  it('a question whose legs all stay silent is not left on the ack alone', async () => {
    // Captured on device: "Got it, you're asking about Porto Santo. One
    // moment." and then nothing. The question leg never called webSearch and
    // never wrote a word, so the turn walked to the cap with an empty reply.
    // It now gets one closing leg; when that is silent too, the cap's own
    // sentence is what the box shows (no second line repeating it).
    const webSearch = jest.fn(async () => ({ searched: true, results: [] }));
    const h = harness(
      [
        res({ content: "Got it, you're asking about Porto Santo. One moment.", toolCalls: [tc('load_skill', { id: 'conversation/question' })] }),
        res({ content: '' }),
      ],
      { webSearch },
    );
    const out = await runAgentTurn({ state: createAgentState(NOBODY), userMessage: 'what is porto santo', deps: h.deps });
    expect(out.acknowledgement).toBe("Got it, you're asking about Porto Santo. One moment.");
    expect(out.closingLegFired).toBe(true);
    expect(out.reply).toBe('');
    expect(out.terminalReason).toBe('leg-cap');
  });

  it('the app can hand in the reader-language fallbacks, and they replace the English ones', async () => {
    const h = harness([
      res({ content: 'One moment.', toolCalls: [tc('load_skill', { id: 'conversation/question' })] }),
      res({ content: 'Let me check that for you.' }),
    ]);
    const out = await runAgentTurn({
      state: createAgentState(NOBODY),
      userMessage: 'what is porto santo',
      deps: h.deps,
      fallbacks: { leak: 'LEAK-DE', process: 'PROCESS-DE' },
    });
    expect(out.reply).toBe('PROCESS-DE');
  });

  it('an answered question keeps its answer', async () => {
    const h = harness([
      res({ content: 'Sure.', toolCalls: [tc('load_skill', { id: 'conversation/question' })] }),
      res({ content: 'Porto Santo is an island.' }),
    ]);
    const out = await runAgentTurn({ state: createAgentState(NOBODY), userMessage: 'what is porto santo', deps: h.deps });
    expect(out.reply).toBe('Porto Santo is an island.');
  });
});

describe('ux2 D9: "Save as I wrote it" is added by the loop, never the model', () => {
  const NOBODY: AgentPersona = { surface: 'CONFIG', languageName: 'English', facts: [] };
  const NEWCASTLES: Place[] = [
    { locality: 'Newcastle upon Tyne', admin1: 'England', countryCode: 'GB', countryName: 'United Kingdom', bloc: 'UK' },
    { locality: 'Newcastle-under-Lyme', admin1: 'England', countryCode: 'GB', countryName: 'United Kingdom', bloc: 'UK' },
  ];

  it('an accepted question carries the user\'s sentence, residence key and skill; the chip is never an option', async () => {
    const results: unknown[] = [];
    const h = harness(
      [
        res({ content: 'Newcastle.', toolCalls: [tc('load_skill', { id: 'facts/residence' })] }),
        res({ toolCalls: [tc('lookup_place', { query: 'Newcastle' })] }),
        res({ toolCalls: [tc('ask_choice', { question: 'Which Newcastle?', options: ['Newcastle upon Tyne', 'Newcastle-under-Lyme'] })] }),
      ],
      { lookupPlace: async () => ({ status: 'resolved', places: NEWCASTLES }) },
    );
    const state = createAgentState(NOBODY);
    await runAgentTurn({
      state, userMessage: 'I live in Newcastle', deps: h.deps,
      onLeg: (leg) => results.push(...leg.toolResults.filter((r) => r.name === 'ask_choice').map((r) => r.result)),
    });
    expect(results).toEqual([{
      awaiting: 'user',
      saveAsWritten: {
        statement: 'Lives in Newcastle',
        questionnaire_attribute: CANONICAL_LOCATION_KEY,
        topic_skill_id: 'topics/residence',
      },
    }]);
    // Neither chip names a country, so both show their lookup chain (ux2 batch 27).
    expect(state.turn.pendingChoice?.options.map((o) => o.text)).toEqual([
      'Newcastle upon Tyne, England, United Kingdom',
      'Newcastle-under-Lyme, England, United Kingdom',
    ]);
  });

  it('a relative\'s place never takes the user\'s home key', async () => {
    const results: unknown[] = [];
    const h = harness(
      [
        res({ content: 'Newcastle.', toolCalls: [tc('load_skill', { id: 'facts/origin' })] }),
        res({ toolCalls: [tc('ask_choice', { question: 'Which Newcastle?', options: ['Newcastle upon Tyne', 'Newcastle-under-Lyme'] })] }),
      ],
    );
    await runAgentTurn({
      state: createAgentState(NOBODY), userMessage: 'My parents live in Newcastle', deps: h.deps,
      onLeg: (leg) => results.push(...leg.toolResults.filter((r) => r.name === 'ask_choice').map((r) => r.result)),
    });
    expect(results[0]).toMatchObject({ saveAsWritten: { statement: 'My parents live in Newcastle' } });
    expect((results[0] as { saveAsWritten: Record<string, unknown> }).saveAsWritten).not.toHaveProperty('questionnaire_attribute');
  });

  it('a lookup that placed nothing, on a turn that offered no card, ends with the chip', async () => {
    const legs: { toolCalls: { name: string }[]; toolResults: { result: unknown }[] }[] = [];
    const h = harness(
      [
        res({ content: 'Zzqq.', toolCalls: [tc('load_skill', { id: 'facts/residence' })] }),
        res({ toolCalls: [tc('lookup_place', { query: 'Zzqq' })] }),
        res({ content: 'I could not find Zzqq. Where is it?' }),
      ],
      { lookupPlace: async () => ({ status: 'no_match', query: 'Zzqq' }) },
    );
    await runAgentTurn({ state: createAgentState(NOBODY), userMessage: 'I live in Zzqq', deps: h.deps, onLeg: (l) => legs.push(l) });
    const last = legs[legs.length - 1];
    expect(last.toolCalls.map((c) => c.name)).toEqual(['saveAsWritten']);
    expect(last.toolResults[0].result).toMatchObject({ saveAsWritten: { statement: 'Lives in Zzqq' } });
  });
});

describe('ux2 batch 25 D4: a place nobody could find never replaces a verified home', () => {
  const BERLIN: AgentPersona = {
    surface: 'CONFIG', languageName: 'English',
    facts: [{ id: 'home', statement: 'Lives in Berlin, State of Berlin, Germany, EU', attribute: CANONICAL_LOCATION_KEY }],
  };
  it('drops the unverified home card and offers "Save as I wrote it" instead', async () => {
    const legs: { toolCalls: { name: string }[] }[] = [];
    const h = harness(
      [
        res({ content: 'Zzqq.', toolCalls: [tc('load_skill', { id: 'facts/residence' })] }),
        res({ toolCalls: [tc('lookup_place', { query: 'Zzqq' })] }),
        res({
          content: 'Could you spell the place?',
          toolCalls: [tc('saveExtractedFacts', { extracted_user_information: [{ statement: 'Lives in Zzqq', questionnaire_attribute: CANONICAL_LOCATION_KEY }] })],
        }),
        res({ content: 'Could you spell the place?' }),
      ],
      { lookupPlace: async () => ({ status: 'no_match', query: 'Zzqq' }) },
    );
    await runAgentTurn({ state: createAgentState(BERLIN), userMessage: 'I live in Zzqq', deps: h.deps, onLeg: (l) => legs.push(l) });
    expect(h.saves.flat().map((e) => e.statement)).not.toContain('Lives in Zzqq');
    expect(legs[legs.length - 1].toolCalls.map((c) => c.name)).toEqual(['saveAsWritten']);
  });

  it('with no home on file, the unverified place is still offered as a plain card', async () => {
    const h = harness(
      [
        res({ content: 'Zzqq.', toolCalls: [tc('load_skill', { id: 'facts/residence' })] }),
        res({ toolCalls: [tc('lookup_place', { query: 'Zzqq' })] }),
        res({ toolCalls: [tc('saveExtractedFacts', { extracted_user_information: [{ statement: 'Lives in Zzqq', questionnaire_attribute: CANONICAL_LOCATION_KEY }] })] }),
        res({ content: 'Offered.' }),
      ],
      { lookupPlace: async () => ({ status: 'no_match', query: 'Zzqq' }) },
    );
    await runAgentTurn({ state: createAgentState({ surface: 'CONFIG', languageName: 'English', facts: [] }), userMessage: 'I live in Zzqq', deps: h.deps });
    expect(h.saves.flat()).toEqual([expect.objectContaining({ statement: 'Lives in Zzqq' })]);
    expect(h.saves.flat()[0].replaces).toBeUndefined();
  });
});

describe('ux2 batch 25 D9: a near-identical fact on file is the replace target', () => {
  const APP: AgentPersona = {
    surface: 'CONFIG', languageName: 'English',
    facts: [
      { id: 'app', statement: 'Building an AI news app', attribute: 'topics: general interests' },
      { id: 'f1', statement: 'Follows Formula E', attribute: 'topics: general interests' },
    ],
  };
  const run = async (statement: string) => {
    const h = harness([
      res({ content: 'Noted.', toolCalls: [tc('load_skill', { id: 'facts/profession' })] }),
      res({ toolCalls: [tc('saveExtractedFacts', { extracted_user_information: [{ statement, questionnaire_attribute: 'topics: general interests' }] })] }),
      res({ content: 'Offered.' }),
    ]);
    await runAgentTurn({ state: createAgentState(APP), userMessage: `I'm ${statement}`, deps: h.deps });
    return h.saves.flat()[0];
  };
  it('targets it when the model named none', async () => {
    expect((await run('Now building an AI news app')).replaces).toBe('app');
  });
  it('leaves an unrelated fact alone', async () => {
    expect((await run('Follows Formula 1')).replaces).toBeUndefined();
  });
});

describe('ux2 batch 25 D1: the hyphenated spelling the turn used wins', () => {
  it('a model statement "Nieuw West" takes the "Nieuw-West" its own lookup used', async () => {
    const h = harness(
      [
        res({ content: 'Amsterdam.', toolCalls: [tc('load_skill', { id: 'facts/residence' })] }),
        res({ toolCalls: [tc('lookup_place', { query: 'Nieuw-West Amsterdam' })] }),
        res({ toolCalls: [tc('saveExtractedFacts', { extracted_user_information: [{ statement: 'Lives in Nieuw West, Amsterdam, North Holland, Netherlands, EU', questionnaire_attribute: CANONICAL_LOCATION_KEY }] })] }),
        res({ content: 'Offered.' }),
      ],
      { lookupPlace: async () => ({ status: 'resolved', places: [AMS], unmatched: 'Nieuw-West' }) },
    );
    await runAgentTurn({ state: createAgentState({ surface: 'CONFIG', languageName: 'English', facts: [] }), userMessage: 'I live in niew west Amsterdam', deps: h.deps });
    expect(h.saves.flat()[0].statement).toBe('Lives in Nieuw-West, Amsterdam, North Holland, Netherlands, EU');
  });

  it('a loop-written home prefers the hyphenated spelling among the turn\'s', () => {
    const { correctedDistrict } = require('@/lib/mera-harness/core/fuzzy-place') as typeof import('@/lib/mera-harness/core/fuzzy-place');
    expect(correctedDistrict('niew west', ['You live in Nieuw West.', '{"query":"Nieuw-West Amsterdam"}'])).toBe('Nieuw-West');
  });
});

describe('ux2 batch 25 C2/9: the delete card is the confirmation', () => {
  const MANY: AgentPersona = {
    surface: 'CONFIG', languageName: 'English',
    facts: [
      { id: 'h1', statement: 'Lives in Nieuw-West, Amsterdam, North Holland, The Netherlands, EU', attribute: CANONICAL_LOCATION_KEY },
      { id: 'o1', statement: 'From India', attribute: ORIGIN_KEY },
      { id: 'i1', statement: 'Follows Formula 1', attribute: 'topics: general interests' },
    ],
  };
  const results = (h: ReturnType<typeof harness>) => h;
  const runDelete = async (args: unknown, extraLegs: AgentModelResult[] = []) => {
    const out: unknown[] = [];
    const h = harness([
      res({ content: 'Sure.', toolCalls: [tc('load_skill', { id: 'conversation/question' })] }),
      res({ toolCalls: [tc('deleteUserFacts', args)] }),
      ...extraLegs,
      res({ content: 'The card has them.' }),
    ]);
    results(h);
    await runAgentTurn({
      state: createAgentState(MANY), userMessage: 'delete my facts', deps: h.deps,
      onLeg: (leg) => out.push(...leg.toolResults.map((r) => [r.name, r.result])),
    });
    return out;
  };

  it('all: true lists every fact, counted from the data', async () => {
    const out = await runDelete({ all: true });
    expect(out).toContainEqual(['deleteUserFacts', expect.objectContaining({
      pendingFactIds: ['h1', 'o1', 'i1'],
      pendingStatements: MANY.facts.map((f) => f.statement),
    })]);
  });

  it('resolves an id, an attribute key and a statement alike', async () => {
    const out = await runDelete({ fact_ids: ['[i1]', ORIGIN_KEY, 'Lives in Nieuw-West, Amsterdam, North Holland, The Netherlands, EU'] });
    expect(out).toContainEqual(['deleteUserFacts', expect.objectContaining({ pendingFactIds: ['i1', 'o1', 'h1'] })]);
  });

  it('a question about the same removal is refused: the card asks', async () => {
    const out = await runDelete({ all: true }, [
      res({ toolCalls: [tc('ask_choice', { question: 'Delete them all?', options: ['Yes', 'No'] })] }),
    ]);
    expect(out).toContainEqual(['ask_choice', expect.objectContaining({ error: expect.stringMatching(/card/) })]);
  });
});

describe('stop-showing-card: a stopped interest gets no invented card', () => {
  const UKR: AgentPersona = {
    surface: 'CONFIG', languageName: 'English',
    facts: [
      { id: 'ukr', statement: 'Follows the war in Ukraine', attribute: 'topics: general interests' },
      { id: 'job', statement: 'Works as a teacher', attribute: 'profession: job role and industry' },
    ],
  };
  const findSimilarFacts = async () => ({ candidates: [{ factId: 'ukr', statement: 'Follows the war in Ukraine', attribute: 'topics: general interests', overlap: 0 }] });

  it('an empty skill save is an answer, not a missing offer', async () => {
    const h = harness([
      res({ content: 'Cricket.', toolCalls: [tc('load_skill', { id: 'facts/interest' })] }),
      res({ toolCalls: [tc('find_similar_facts', { kind: 'generic' })] }),
      res({ toolCalls: [tc('saveExtractedFacts', { extracted_user_information: [] })] }),
      res({ content: "Okay, I won't add that." }),
    ], { findSimilarFacts });
    const out = await runAgentTurn({ state: createAgentState(UKR), userMessage: 'stop showing me cricket news', deps: h.deps });
    expect(h.calls.map((c) => c.toolChoice)).not.toContain('required');
    expect(h.saves.flat()).toEqual([]);
    expect(out.forcedProposal).toBe(false);
    expect(out.terminalReason).toBe('settled');
  });

  // The device "ok" shape: the empty save lands early, so a forced leg after
  // the prose would still fit the budget. Pins the prose-settle site.
  it('prose after an early empty save settles with no forced leg', async () => {
    const h = harness([
      res({ content: 'Cricket.', toolCalls: [tc('load_skill', { id: 'facts/interest' })] }),
      res({ toolCalls: [tc('saveExtractedFacts', { extracted_user_information: [] })] }),
      res({ content: 'Okay, nothing to change.' }),
      res({ toolCalls: [tc('saveExtractedFacts', { extracted_user_information: [{ statement: 'No longer follows cricket news' }] })] }),
    ], { findSimilarFacts });
    const out = await runAgentTurn({ state: createAgentState(UKR), userMessage: 'ok', deps: h.deps });
    expect(h.calls.map((c) => c.toolChoice)).not.toContain('required');
    expect(h.saves.flat()).toEqual([]);
    expect(out.forcedProposal).toBe(false);
    expect(out.terminalReason).toBe('settled');
  });

  // Pins the narration site: narration after an empty save is re-asked, never forced.
  it('narration after an empty save is re-asked, not forced', async () => {
    const h = harness([
      res({ content: 'Cricket.', toolCalls: [tc('load_skill', { id: 'facts/interest' })] }),
      res({ toolCalls: [tc('saveExtractedFacts', { extracted_user_information: [] })] }),
      res({ content: 'Let me check what you follow.' }),
      res({ content: "Okay, I won't add that." }),
      res({ content: "Okay, I won't add that." }),
    ], { findSimilarFacts });
    const out = await runAgentTurn({ state: createAgentState(UKR), userMessage: 'stop showing me cricket news', deps: h.deps });
    expect(h.calls.map((c) => c.toolChoice)).not.toContain('required');
    expect(out.forcedProposal).toBe(false);
    expect(out.reply).toBe("Okay, I won't add that.");
  });

  it('a same interest key does not make an unrelated fact the replace target; a profession still replaces', async () => {
    const h = harness([
      res({ content: 'Cricket.', toolCalls: [tc('load_skill', { id: 'facts/interest' })] }),
      res({ toolCalls: [tc('saveExtractedFacts', { extracted_user_information: [
        { statement: 'Follows cricket', questionnaire_attribute: 'topics: general interests', replaces: 'ukr' },
      ] })] }),
      res({ content: 'Here it is.' }),
    ], { findSimilarFacts });
    await runAgentTurn({ state: createAgentState(UKR), userMessage: 'I follow cricket', deps: h.deps });
    expect(h.saves[0][0].replaces).toBeUndefined();

    const p = harness([
      res({ content: 'Nurse.', toolCalls: [tc('load_skill', { id: 'facts/profession' })] }),
      res({ toolCalls: [tc('saveExtractedFacts', { extracted_user_information: [
        { statement: 'Works as a nurse', questionnaire_attribute: 'profession: job role and industry', replaces: 'job' },
      ] })] }),
      res({ content: 'Here it is.' }),
    ]);
    await runAgentTurn({ state: createAgentState(UKR), userMessage: 'I am a nurse now', deps: p.deps });
    expect(p.saves[0][0].replaces).toBe('job');
  });

  // A shared interest verb is not a shared subject: "Supports" alone made
  // Feyenoord the target of Ajax.
  it.each([
    ['Supports Ajax', 'Supports Feyenoord', 'teams_following: football clubs', undefined],
    ['Listens to drum and bass', 'Listens to jazz', 'entertainment_genres: music', undefined],
    ['Interested in AI', 'Interested in space exploration', 'topics: general interests', undefined],
    ['Plays blitz chess', 'Plays chess', 'hobbies: pastimes', 'old'],
  ])('"%s" replacing "%s" without a chip', async (statement, target, attribute, expected) => {
    const h = harness([
      res({ content: 'Noted.', toolCalls: [tc('load_skill', { id: 'facts/interest' })] }),
      res({ toolCalls: [tc('saveExtractedFacts', { extracted_user_information: [
        { statement, questionnaire_attribute: attribute, replaces: 'old' },
      ] })] }),
      res({ content: 'Here it is.' }),
    ]);
    const state = createAgentState({ surface: 'CONFIG', languageName: 'English', facts: [{ id: 'old', statement: target, attribute }] });
    await runAgentTurn({ state, userMessage: statement, deps: h.deps });
    expect(h.saves[0][0].replaces).toBe(expected);
  });

  it('a waiting fact card tells the model only a tap applies it', () => {
    const line = buildStateLine({
      routeKind: null, resolvedPlaces: null, similarFactCount: null, answerPending: false, resolvedChoiceText: null,
      pendingCards: ['No longer follows cricket news'],
    });
    expect(line).toContain('Cards already waiting for the user: "No longer follows cricket news"');
    expect(line).toContain('Tap the one you want on the card above');
    expect(line).toContain('Never say it is done or all set');
  });

  // F7: a typed yes or no resumes the question; the tap rule would contradict it.
  it.each([['answeredYesTo'], ['answeredNoTo']])('a waiting fact card leaves the tap rule out on %s', (key) => {
    const line = buildStateLine({
      routeKind: null, resolvedPlaces: null, similarFactCount: null, answerPending: false, resolvedChoiceText: null,
      pendingCards: ['Follows Formula 1'], [key]: 'Want me to add the Champions League too?',
    });
    expect(line).toContain('Cards already waiting for the user');
    expect(line).not.toContain('call nothing');
  });
});

describe('follow-this: pointing at a fact card still waiting', () => {
  const CARD = "Follows NASA's Artemis lunar program";
  const waitingState = () => {
    const state = createAgentState({ surface: 'CONFIG', languageName: 'English', facts: [] });
    state.pendingCardStatements = [CARD];
    state.turn.recentExchanges = [{ user: 'What is happening with the Artemis program?', reply: 'Want me to track Artemis updates for you?' }];
    state.turn.lastSubjects = [CARD];
    return state;
  };

  it('points at the card on a closing leg instead of re-offering or forcing', async () => {
    const h = harness([
      res({ content: 'One moment.', toolCalls: [tc('load_skill', { id: 'facts/interest' })] }),
      // The device shape: prose written BEFORE the result, beside the dropped save.
      res({ content: "I'll follow Artemis for you.", toolCalls: [tc('saveExtractedFacts', { extracted_user_information: [{ statement: CARD }] })] }),
      res({ content: 'Tap Add on the card above to follow Artemis.' }),
    ]);
    const out = await runAgentTurn({ state: waitingState(), userMessage: 'follow this', deps: h.deps });
    expect(h.saves).toEqual([]);
    expect(out.forcedProposal).toBe(false);
    expect(out.terminalReason).toBe('settled');
    expect(h.calls.map((c) => c.toolChoice)).not.toContain('required');
    const saveResult = out.legs.flatMap((l) => l.toolResults).find((r) => r.name === 'saveExtractedFacts');
    expect(saveResult?.result).toMatchObject({ alreadyWaiting: [CARD] });
    expect(saveResult?.result).not.toHaveProperty('staged', true);
    // The model read the note before writing the reply that ships.
    expect(h.calls).toHaveLength(3);
    expect(h.calls[2].tools).toEqual([]);
    expect(out.legs[2].messages.map((m) => m.content).join('\n')).toContain('alreadyWaiting');
    expect(out.reply).toBe('Tap Add on the card above to follow Artemis.');
  });
});

describe('stagefix P1b: an empty save blocks forcing only on a turn that states no fact', () => {
  const UKR: AgentPersona = {
    surface: 'CONFIG', languageName: 'English',
    facts: [{ id: 'ukr', statement: 'Follows the war in Ukraine', attribute: 'topics: general interests' }],
  };
  const BER: Place = { locality: 'Berlin', admin1: 'Berlin', countryCode: 'DE', countryName: 'Germany', bloc: 'EU' };

  // Measured (stagefix eval): the model answered a genuine origin-and-home
  // message with a placeholder empty save and no reply; the forced leg used
  // to rescue it.
  it('a genuine multi-fact turn whose leg saves [] and then says nothing still gets the forced offer', async () => {
    const h = harness([
      res({ content: 'Got it.', toolCalls: [tc('load_skill', { id: 'facts/origin' })] }),
      res({ toolCalls: [tc('saveExtractedFacts', { extracted_user_information: [] })] }),
      res({ content: '' }),
      res({ toolCalls: [tc('saveExtractedFacts', { extracted_user_information: [
        { statement: 'From India', questionnaire_attribute: ORIGIN_KEY },
      ] })] }),
      res({ content: 'Here they are.' }),
    ], { lookupPlace: async () => ({ status: 'resolved', places: [BER] }) });
    const out = await runAgentTurn({
      state: createAgentState({ surface: 'CONFIG', languageName: 'English', facts: [] }),
      userMessage: "I'm originally from India and I live in Berlin now",
      deps: h.deps,
    });
    expect(h.calls.map((c) => c.toolChoice)).toContain('required');
    expect(out.forcedProposal).toBe(true);
    expect(h.saves.flat().map((e) => e.statement)).toContain('From India');
  });

  it.each([
    ['stop showing me cricket news', 'No longer follows cricket news'],
    ['stop showing me cricket news', 'Does not want cricket news'],
    ['मुझे क्रिकेट की खबरें मत दिखाओ', 'Dislikes cricket news'],
  ])('"%s": a forced "%s" is never offered, the prose stands', async (userMessage, invented) => {
    const persona: AgentPersona = { ...UKR, facts: [...UKR.facts, { id: 'cr', statement: 'Follows cricket', attribute: 'topics: general interests' }] };
    const h = harness([
      res({ content: 'Okay.', toolCalls: [tc('load_skill', { id: 'facts/interest' })] }),
      res({ content: 'Okay, no more cricket.' }),
      res({ toolCalls: [tc('saveExtractedFacts', { extracted_user_information: [
        { statement: invented, questionnaire_attribute: 'topics: general interests', replaces: 'cr' },
      ] })] }),
      res({ content: 'Offered.' }),
    ]);
    const out = await runAgentTurn({ state: createAgentState(persona), userMessage, deps: h.deps });
    expect(h.saves.flat()).toEqual([]);
    expect(out.reply).toBe('Okay, no more cricket.');
    expect(out.terminalReason).toBe('settled');
  });

  it.each(['nice', 'thanks', 'cool'])('"%s" gets no forced leg, after an empty save or without one', async (ack) => {
    for (const script of [
      [
        res({ content: 'Glad.', toolCalls: [tc('load_skill', { id: 'facts/interest' })] }),
        res({ toolCalls: [tc('saveExtractedFacts', { extracted_user_information: [] })] }),
        res({ content: 'Glad you like it.' }),
        res({ toolCalls: [tc('saveExtractedFacts', { extracted_user_information: [{ statement: 'Follows the war in Ukraine news' }] })] }),
      ],
      [
        res({ content: 'Glad.', toolCalls: [tc('load_skill', { id: 'facts/interest' })] }),
        res({ content: 'Glad you like it.' }),
        res({ toolCalls: [tc('saveExtractedFacts', { extracted_user_information: [{ statement: 'Follows the war in Ukraine news' }] })] }),
      ],
    ]) {
      const h = harness(script);
      const out = await runAgentTurn({ state: createAgentState(UKR), userMessage: ack, deps: h.deps });
      expect(h.calls.map((c) => c.toolChoice)).not.toContain('required');
      expect(h.saves.flat()).toEqual([]);
      expect(out.forcedProposal).toBe(false);
      expect(out.reply).toBe('Glad you like it.');
    }
  });
});

describe('stagefix P1c: acknowledgements, see-less turns and waiting cards', () => {
  const UKR: AgentPersona = {
    surface: 'CONFIG', languageName: 'English',
    facts: [
      { id: 'ukr', statement: 'Follows the war in Ukraine', attribute: 'topics: general interests' },
      { id: 'cr', statement: 'Follows cricket', attribute: 'topics: general interests' },
    ],
  };
  const CARD = "Follows NASA's Artemis lunar program";
  const artemisState = () => {
    const state = createAgentState(UKR);
    state.pendingCardStatements = [CARD];
    state.turn.recentExchanges = [{ user: 'What is happening with the Artemis program?', reply: 'Want me to track Artemis updates for you?' }];
    state.turn.lastSubjects = [CARD];
    return state;
  };

  // Measured (stagefix2 eval): beside a waiting Artemis card, "follow this"
  // saved [] and the forced leg then staged "Follows the Artemis program".
  it.each(['yes', 'follow this'])('"%s" beside a waiting card: an empty save is final, no forced leg', async (userMessage) => {
    const h = harness([
      res({ content: 'Sure.', toolCalls: [tc('load_skill', { id: 'facts/interest' })] }),
      res({ toolCalls: [tc('saveExtractedFacts', { extracted_user_information: [] })] }),
      res({ content: 'Tap Add on the card above.' }),
      // The bait a forced leg would stage. For "yes" this is the tool-free
      // leg that points at the card (P1d), which drops the call.
      res({ content: 'Tap Add on the card above.', toolCalls: [tc('saveExtractedFacts', { extracted_user_information: [{ statement: 'Follows the Artemis program' }] })] }),
    ]);
    const out = await runAgentTurn({ state: artemisState(), userMessage, deps: h.deps });
    expect(h.calls.map((c) => c.toolChoice)).not.toContain('required');
    expect(h.saves.flat()).toEqual([]);
    expect(out.forcedProposal).toBe(false);
    expect(out.reply).toBe('Tap Add on the card above.');
  });

  // Owner ruling: ok and thanks only acknowledge, in every app language.
  it.each(['धन्यवाद', 'ठीक है', 'danke', 'ありがとう', '谢谢'])('"%s" gets no forced leg after an empty save', async (ack) => {
    const h = harness([
      res({ content: 'Glad.', toolCalls: [tc('load_skill', { id: 'facts/interest' })] }),
      res({ toolCalls: [tc('saveExtractedFacts', { extracted_user_information: [] })] }),
      res({ content: 'Glad you like it.' }),
      res({ toolCalls: [tc('saveExtractedFacts', { extracted_user_information: [{ statement: 'Follows the war in Ukraine news' }] })] }),
    ]);
    const out = await runAgentTurn({ state: createAgentState(UKR), userMessage: ack, deps: h.deps });
    expect(h.calls.map((c) => c.toolChoice)).not.toContain('required');
    expect(h.saves.flat()).toEqual([]);
    expect(out.reply).toBe('Glad you like it.');
  });

  // Owner ruling: stop, less, mute and hide stage a filter, never a negative
  // fact card, forced or not (stagefix2: unforced "Does not want The Hindu
  // included in news updates" on "Mute The Hindu").
  it.each([
    ['Mute The Hindu', 'Does not want The Hindu included in news updates'],
    ['Stop showing me cricket news', 'Is not interested in cricket'],
    ['The Hindu की खबरें मत दिखाओ', 'Dislikes The Hindu'],
  ])('"%s": an UNFORCED "%s" is dropped, the prose stands', async (userMessage, negative) => {
    const h = harness([
      res({ content: 'Okay.', toolCalls: [tc('load_skill', { id: 'facts/interest' })] }),
      res({ content: 'Okay, less of that.', toolCalls: [tc('saveExtractedFacts', { extracted_user_information: [
        { statement: negative, questionnaire_attribute: 'topics: general interests' },
      ] })] }),
      res({ content: 'Offered.' }),
    ]);
    const out = await runAgentTurn({ state: createAgentState(UKR), userMessage, deps: h.deps });
    expect(h.saves).toEqual([]);
    expect(h.calls.map((c) => c.toolChoice)).not.toContain('required');
    expect(out.reply).toBe('Okay, less of that.');
    expect(out.terminalReason).toBe('settled');
  });

  // stagefix2 feed-tuning t13: "ok" resumed the question asked after "Mute The
  // Hindu", and an unforced leg staged "Does not want The Hindu as a source".
  it('a typed ok resuming a see-less turn drops the negative offer too', async () => {
    const state = createAgentState(UKR);
    state.turn.lastQuestion = 'Do you want me to remove a saved fact instead?';
    state.turn.lastSkill = 'facts/interest';
    state.turn.lastUserMessage = 'Mute The Hindu';
    const h = harness([
      res({ toolCalls: [tc('saveExtractedFacts', { extracted_user_information: [
        { statement: 'Does not want The Hindu as a source', questionnaire_attribute: 'topics: general interests' },
      ] })] }),
      res({ content: 'Okay, nothing changes on your profile.' }),
    ]);
    const out = await runAgentTurn({ state, userMessage: 'ok', deps: h.deps });
    expect(h.saves).toEqual([]);
    // A silent leg has no prose to settle on: the next leg writes the reply.
    expect(out.reply).toBe('Okay, nothing changes on your profile.');
  });

  // Owner ruling: "I'm not interested in X" is a fact, so its card stands;
  // any other negative shape on a forced leg is still dropped.
  it.each([
    ['Not interested in golf', ['Not interested in golf']],
    ['Is not interested in golf', ['Is not interested in golf']],
    ['Does not want golf news', []],
  ])('"I am not interested in golf": a forced "%s" is offered only in the not-interested shape', async (statement, saved) => {
    const h = harness([
      res({ content: 'Noted.', toolCalls: [tc('load_skill', { id: 'facts/interest' })] }),
      res({ content: 'Got it, golf is not for you.' }),
      res({ toolCalls: [tc('saveExtractedFacts', { extracted_user_information: [
        { statement, questionnaire_attribute: 'topics: general interests' },
      ] })] }),
      res({ content: 'Here it is.' }),
    ]);
    await runAgentTurn({ state: createAgentState(UKR), userMessage: 'I am not interested in golf', deps: h.deps });
    expect(h.calls.map((c) => c.toolChoice)).toContain('required');
    expect(h.saves.flat().map((e) => e.statement)).toEqual(saved);
  });

  // Reviewer: the dropped-negative settle used to run BEFORE the waiting-card
  // branch, so the reply never pointed at the card.
  it('a forced call carrying a waiting card AND a dropped negative still points at the card', async () => {
    const h = harness([
      res({ content: 'One moment.', toolCalls: [tc('load_skill', { id: 'facts/interest' })] }),
      res({ content: 'Sure thing.' }),
      res({ toolCalls: [tc('saveExtractedFacts', { extracted_user_information: [
        { statement: CARD }, { statement: 'No longer follows cricket news' },
      ] })] }),
      res({ content: 'Tap Add on the card above to follow Artemis.' }),
    ]);
    const out = await runAgentTurn({ state: artemisState(), userMessage: 'follow this', deps: h.deps });
    expect(h.calls[2].toolChoice).toBe('required');
    expect(h.saves).toEqual([]);
    expect(h.calls).toHaveLength(4);
    expect(h.calls[3].tools).toEqual([]);
    const saveResult = out.legs.flatMap((l) => l.toolResults).find((r) => r.name === 'saveExtractedFacts');
    expect(saveResult?.result).toMatchObject({ alreadyWaiting: [CARD] });
    expect(out.reply).toBe('Tap Add on the card above to follow Artemis.');
  });
});

describe('stagefix P1d: see-less offers, real negative facts, reworded and acknowledged waiting cards', () => {
  const UKR: AgentPersona = {
    surface: 'CONFIG', languageName: 'English',
    facts: [
      { id: 'ukr', statement: 'Follows the war in Ukraine', attribute: 'topics: general interests' },
      { id: 'cr', statement: 'Follows cricket', attribute: 'topics: general interests' },
    ],
  };
  const CARD = "Follows NASA's Artemis lunar program";
  const artemisState = () => {
    const state = createAgentState(UKR);
    state.pendingCardStatements = [CARD];
    state.turn.recentExchanges = [{ user: 'What is happening with the Artemis program?', reply: 'Want me to track Artemis updates for you?' }];
    state.turn.lastSubjects = [CARD];
    return state;
  };

  // Reviewer: these carry no interest word, so the narrow predicate let them
  // through as cards beside "Stop showing me cricket".
  it.each([
    'Does not want cricket', 'Is not into cricket', 'Not a fan of cricket', 'Wants to see less cricket',
    'Unfollowed cricket', 'Has no interest in cricket',
  ])('"Stop showing me cricket": an unforced "%s" is dropped', async (negative) => {
    const h = harness([
      res({ content: 'Okay.', toolCalls: [tc('load_skill', { id: 'facts/interest' })] }),
      res({ content: 'Okay, less cricket.', toolCalls: [tc('saveExtractedFacts', { extracted_user_information: [
        { statement: negative, questionnaire_attribute: 'topics: general interests' },
      ] })] }),
      res({ content: 'Offered.' }),
    ]);
    const out = await runAgentTurn({ state: createAgentState(UKR), userMessage: 'Stop showing me cricket', deps: h.deps });
    expect(h.saves).toEqual([]);
    expect(out.reply).toBe('Okay, less cricket.');
  });

  it('a compound see-less message keeps the real fact beside it', async () => {
    const h = harness([
      res({ content: 'Okay.', toolCalls: [tc('load_skill', { id: 'facts/residence' })] }),
      res({ content: 'Here is your move.', toolCalls: [tc('saveExtractedFacts', { extracted_user_information: [
        { statement: 'Lives in Berlin', questionnaire_attribute: 'location: residence' },
        { statement: 'Does not want cricket', questionnaire_attribute: 'topics: general interests' },
      ] })] }),
      res({ content: 'Done.' }),
    ]);
    await runAgentTurn({ state: createAgentState(UKR), userMessage: 'Stop showing me cricket, I moved to Berlin', deps: h.deps });
    const saved = h.saves.flat().map((e) => String(e.statement));
    expect(saved.some((s) => s.includes('Berlin'))).toBe(true);
    expect(saved.some((s) => /cricket/i.test(s))).toBe(false);
  });

  // Reviewer: DISLIKE_LEAD needed no interest word, so a genuine fact was
  // dropped from a forced leg on an ordinary turn.
  it.each([
    ['I avoid gluten', 'Avoids gluten'],
    ['I am no longer interested in F1', 'No longer interested in F1'],
  ])('"%s": a forced "%s" is offered', async (userMessage, statement) => {
    const h = harness([
      res({ content: 'Noted.', toolCalls: [tc('load_skill', { id: 'facts/interest' })] }),
      res({ content: 'Got it.' }),
      res({ toolCalls: [tc('saveExtractedFacts', { extracted_user_information: [
        { statement, questionnaire_attribute: 'topics: general interests' },
      ] })] }),
      res({ content: 'Here it is.' }),
    ]);
    await runAgentTurn({ state: createAgentState(UKR), userMessage, deps: h.deps });
    expect(h.calls.map((c) => c.toolChoice)).toContain('required');
    expect(h.saves.flat().map((e) => e.statement)).toEqual([statement]);
  });

  // stagefix2 NEW r0 t4: an UNFORCED reworded copy of the waiting card was
  // staged as a second card on the same subject.
  it('a reworded copy of a waiting card points at the card instead of staging it', async () => {
    const h = harness([
      res({ content: 'One moment.', toolCalls: [tc('load_skill', { id: 'facts/interest' })] }),
      res({ content: "I'll follow Artemis for you.", toolCalls: [tc('saveExtractedFacts', { extracted_user_information: [
        { statement: 'Follows the NASA Artemis lunar program' },
      ] })] }),
      res({ content: 'Tap Add on the card above to follow Artemis.' }),
    ]);
    const out = await runAgentTurn({ state: artemisState(), userMessage: 'follow this', deps: h.deps });
    expect(h.saves).toEqual([]);
    const saveResult = out.legs.flatMap((l) => l.toolResults).find((r) => r.name === 'saveExtractedFacts');
    expect(saveResult?.result).toMatchObject({ alreadyWaiting: [CARD] });
    expect(h.calls[2].tools).toEqual([]);
    expect(out.reply).toBe('Tap Add on the card above to follow Artemis.');
  });

  // Owner ruling: an acknowledgement applies nothing and Mera points at the
  // waiting card. stagefix2: "thanks" answered "You're welcome" 6 of 8 times,
  // and once shipped a skill-body line as the whole reply to "ok".
  it.each(['thanks', 'ok', 'yes', 'धन्यवाद'])('"%s" beside a waiting card ends on a leg that points at it', async (userMessage) => {
    const h = harness([
      res({ content: 'Sure.', toolCalls: [tc('load_skill', { id: 'conversation/question' })] }),
      res({ content: "You're welcome! What else can I help with?" }),
      res({ content: 'Tap Add on the card above if you want it.' }),
    ]);
    const out = await runAgentTurn({ state: artemisState(), userMessage, deps: h.deps });
    expect(h.saves).toEqual([]);
    expect(h.calls).toHaveLength(3);
    expect(h.calls[2].tools).toEqual([]);
    expect(out.legs[2].messages.map((m) => m.content).join('\n')).toMatch(/tap/i);
    expect(out.reply).toBe('Tap Add on the card above if you want it.');
  });

  it('"thanks" with no card waiting keeps its own reply', async () => {
    const h = harness([
      res({ content: 'Sure.', toolCalls: [tc('load_skill', { id: 'conversation/question' })] }),
      res({ content: "You're welcome! What else can I help with?" }),
      res({ content: 'unused' }),
    ]);
    const out = await runAgentTurn({ state: createAgentState(UKR), userMessage: 'thanks', deps: h.deps });
    expect(h.calls).toHaveLength(2);
    expect(out.reply).toBe("You're welcome! What else can I help with?");
  });

  // Reviewer (scope): on device every untapped card in the thread waits, so a
  // genuine new fact beside an unrelated card must still get the forced offer
  // after a placeholder empty save.
  it('a genuine new fact beside an unrelated waiting card still gets the forced offer', async () => {
    const BER: Place = { locality: 'Berlin', admin1: 'Berlin', countryCode: 'DE', countryName: 'Germany', bloc: 'EU' };
    const h = harness([
      res({ content: 'Got it.', toolCalls: [tc('load_skill', { id: 'facts/origin' })] }),
      res({ toolCalls: [tc('saveExtractedFacts', { extracted_user_information: [] })] }),
      res({ content: '' }),
      res({ toolCalls: [tc('saveExtractedFacts', { extracted_user_information: [
        { statement: 'From India', questionnaire_attribute: ORIGIN_KEY },
      ] })] }),
      res({ content: 'Here they are.' }),
    ], { lookupPlace: async () => ({ status: 'resolved', places: [BER] }) });
    const out = await runAgentTurn({ state: artemisState(), userMessage: "I'm originally from India and I live in Berlin now", deps: h.deps });
    expect(h.calls.map((c) => c.toolChoice)).toContain('required');
    expect(out.forcedProposal).toBe(true);
    expect(h.saves.flat().map((e) => e.statement)).toContain('From India');
  });
});

describe('stagefix P1d review: the waiting-card twin and the yes leg keep their guards', () => {
  const NW = 'Lives in Nieuw-West, Amsterdam, North Holland, Netherlands, EU';
  const residenceTurn = (offer: string, card: string) => {
    const state = createAgentState({ surface: 'CONFIG', languageName: 'English', facts: [] });
    state.pendingCardStatements = [card];
    const h = harness([
      res({ content: 'Okay.', toolCalls: [tc('load_skill', { id: 'facts/residence' })] }),
      res({ content: 'Here it is.', toolCalls: [tc('saveExtractedFacts', { extracted_user_information: [
        { statement: offer, questionnaire_attribute: 'location: residence' },
      ] })] }),
      res({ content: 'Done.' }),
    ]);
    return { state, h };
  };

  // The near-twin rule skips homes and needs subject agreement; the waiting
  // card version must too, or a corrected district is silently dropped.
  it('a corrected district beside a waiting home card is its own card', async () => {
    const offer = 'Lives in Noord, Amsterdam, North Holland, Netherlands, EU';
    const { state, h } = residenceTurn(offer, NW);
    await runAgentTurn({ state, userMessage: 'Sorry, I live in Noord, Amsterdam', deps: h.deps });
    expect(h.saves.flat().map((e) => String(e.statement))).toEqual([offer]);
  });

  it("a relative's place beside the user's own waiting card is its own card", async () => {
    const card = 'Teaches in Bhopal';
    const offer = 'Father teaches in Bhopal';
    const state = createAgentState({ surface: 'CONFIG', languageName: 'English', facts: [] });
    state.pendingCardStatements = [card];
    const h = harness([
      res({ content: 'Okay.', toolCalls: [tc('load_skill', { id: 'facts/profession' })] }),
      res({ content: 'Here it is.', toolCalls: [tc('saveExtractedFacts', { extracted_user_information: [{ statement: offer }] })] }),
      res({ content: 'Done.' }),
    ]);
    await runAgentTurn({ state, userMessage: 'My father teaches in Bhopal', deps: h.deps });
    expect(h.saves.flat().map((e) => String(e.statement))).toEqual([offer]);
  });

  // A yes to a conversation question routes normally; its answer must not be
  // replaced by "tap the card" because an older card still waits.
  it('"yes" answering a conversation question beside an unrelated card keeps its answer', async () => {
    const state = createAgentState({ surface: 'CONFIG', languageName: 'English', facts: [] });
    state.pendingCardStatements = ['Works as a nurse at a hospital'];
    state.turn.lastQuestion = 'Want me to look up the latest on Artemis?';
    state.turn.lastSkill = 'conversation/question';
    state.turn.lastUserMessage = 'What is happening with the Artemis program?';
    const h = harness([
      res({ content: 'Sure.', toolCalls: [tc('load_skill', { id: 'conversation/question' })] }),
      res({ content: 'Artemis III is now planned for mid-2027.' }),
      res({ content: 'Tap Add on the card above.' }),
    ]);
    const out = await runAgentTurn({ state, userMessage: 'yes', deps: h.deps });
    expect(h.calls).toHaveLength(2);
    expect(out.reply).toBe('Artemis III is now planned for mid-2027.');
  });
});
