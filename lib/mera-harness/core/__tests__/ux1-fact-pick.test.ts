// Owner rule (ux1): an ask_choice between DISTINCT facts is never a pick-one.
// The loop offers them all as cards; a chip list that still reaches the user
// carries "Save all". Readings of one ambiguous thing ("Which Porto?") stay a
// question. The device case: "I live in niew West Amsterdam and I'm an expat
// from india" came back as "Which fact should I offer to save?".

import { createAgentState, runAgentTurn } from '../core';
import { CANONICAL_LOCATION_KEY, EXPAT_KEY, ORIGIN_KEY } from '../combined-fact';
import { factPickStatement, isFactPickChoice, joinFactPick } from '../fact-pick';
import type { AgentDeps, AgentModelResult } from '../types';

function res(over: Partial<AgentModelResult> = {}): AgentModelResult {
  return {
    content: '', toolCalls: [], finishReason: 'stop', truncated: false,
    usage: null, modelSent: 'fake', latencyMs: 1, error: null, ...over,
  };
}
const tc = (name: string, args: unknown) => ({ name, argumentsRaw: JSON.stringify(args) });
const SKILLS: Record<string, string> = {
  'facts/residence': 'R', 'facts/origin': 'O', 'facts/generic': 'G', 'topics/origin': 'x', 'topics/residence': 'x',
};
const NL = { locality: 'Amsterdam', admin1: 'North Holland', countryCode: 'NL', countryName: 'The Netherlands', bloc: 'EU' as const };
const DEVICE_MESSAGE = "I live in niew West Amsterdam and I'm an expat from india";
const DEVICE_OPTIONS = ['You are an expat', 'You are from India', 'You live in New West, Amsterdam'];

function harness(script: AgentModelResult[], lookup: AgentDeps['tools']['lookupPlace'] = async () => ({ status: 'resolved', places: [NL] })) {
  const saves: Record<string, unknown>[][] = [];
  let i = 0;
  const modelCalls: number[] = [];
  const deps: AgentDeps = {
    callModel: async () => { modelCalls.push(i); return script[Math.min(i++, script.length - 1)]; },
    tools: {
      findSimilarFacts: async () => ({ candidates: [] }),
      lookupPlace: lookup,
      saveExtractedFacts: async (a) => { saves.push((a.extracted_user_information as Record<string, unknown>[]) ?? []); return { staged: true }; },
      deleteUserFacts: async () => ({ deleted: [] }),
    },
    loadSkill: (id) => SKILLS[id] ?? null,
    skillIds: () => Object.keys(SKILLS),
  };
  return { deps, saves, modelCalls };
}

describe('isFactPickChoice', () => {
  it('the device options are distinct facts', () => {
    expect(isFactPickChoice(DEVICE_OPTIONS)).toBe(true);
  });
  it('allows more than three', () => {
    expect(isFactPickChoice([...DEVICE_OPTIONS, 'You work at Booking'])).toBe(true);
  });
  it('readings of one place are not', () => {
    expect(isFactPickChoice(['You live in Porto, Portugal', 'You live in Porto Alegre, Brazil'])).toBe(false);
    expect(isFactPickChoice(['Porto, Portugal', 'Porto Alegre'])).toBe(false);
    expect(isFactPickChoice(['I mean Porto, Portugal', 'I mean Porto Alegre'])).toBe(false);
  });
  it('a replacement or yes/no question is not', () => {
    expect(isFactPickChoice(['Yes, I now live in Berlin', 'No, keep Amsterdam'])).toBe(false);
  });
  it('an option naming one of several looked-up places is a reading', () => {
    const PT = { locality: 'Porto', admin1: 'Porto', countryCode: 'PT', countryName: 'Portugal', bloc: 'EU' as const };
    const BR = { locality: 'Porto Alegre', admin1: 'Rio Grande do Sul', countryCode: 'BR', countryName: 'Brazil', bloc: null };
    expect(isFactPickChoice(['You are from India', 'You live in Porto'], [PT, BR])).toBe(false);
  });
  it('needs at least two options', () => {
    expect(isFactPickChoice(['You are from India'])).toBe(false);
    expect(isFactPickChoice('nope')).toBe(false);
  });
});

describe('factPickStatement and joinFactPick', () => {
  it('rewrites a chip as a fact', () => {
    expect(factPickStatement('You are from India')).toBe('From India');
    expect(factPickStatement('You live in New West, Amsterdam')).toBe('Lives in New West, Amsterdam');
    expect(factPickStatement("You're a product manager")).toBe('Product manager');
    expect(factPickStatement('You work at Booking')).toBe('Works at Booking');
    expect(factPickStatement('You have two kids')).toBe('Has two kids');
    expect(factPickStatement('I follow Formula 1')).toBe('Follows Formula 1');
  });
  it('joins options into one sentence-per-option message', () => {
    expect(joinFactPick(DEVICE_OPTIONS)).toBe('You are an expat. You are from India. You live in New West, Amsterdam.');
  });
});

describe('the device case', () => {
  it('turns a pick-one between distinct facts into cards for all of them', async () => {
    const h = harness([
      res({ content: 'Got it. One moment.', toolCalls: [tc('load_skill', { id: 'facts/origin' })] }),
      res({
        content: "You've told me a few things. What should I write down?",
        toolCalls: [tc('ask_choice', { question: 'Which fact should I offer to save?', options: DEVICE_OPTIONS })],
      }),
      res({ content: 'Here they are.' }),
    ]);
    const state = createAgentState({ surface: 'CONFIG', facts: [] });
    const out = await runAgentTurn({ state, userMessage: DEVICE_MESSAGE, deps: h.deps });
    expect(out.terminalReason).not.toBe('awaiting-user');
    expect(state.turn.pendingChoice).toBeNull();
    const flat = h.saves.flat().map((e) => [e.statement, e.questionnaire_attribute]);
    expect(flat).toContainEqual(['From India', ORIGIN_KEY]);
    expect(flat).toContainEqual(['Expat in The Netherlands', EXPAT_KEY]);
    expect(flat.find(([, k]) => k === CANONICAL_LOCATION_KEY)?.[0]).toMatch(/^Lives in New West, Amsterdam/);
    expect(flat.map(([s]) => s)).not.toContain('Expat');
    expect(out.reply).not.toMatch(/what should i write down/i);
  });

  it('leaves a question between readings of one place alone', async () => {
    const h = harness([
      res({ content: 'Porto.', toolCalls: [tc('load_skill', { id: 'facts/origin' })] }),
      res({ toolCalls: [tc('ask_choice', { question: 'Which Porto?', options: ['You live in Porto, Portugal', 'You live in Porto Alegre, Brazil'] })] }),
    ]);
    const out = await runAgentTurn({ state: createAgentState({ surface: 'CONFIG', facts: [] }), userMessage: 'I moved to Porto', deps: h.deps });
    expect(out.terminalReason).toBe('awaiting-user');
    expect(h.saves).toEqual([]);
  });

  it('a Save all tap offers every option as cards, without asking the model to pick', async () => {
    const state = createAgentState({ surface: 'CONFIG', facts: [] });
    state.turn.pendingChoice = {
      question: 'Which fact should I offer to save?',
      options: DEVICE_OPTIONS.map((text) => ({ text, payload: null })),
    };
    state.turn.lastQuestion = 'Which fact should I offer to save?';
    state.turn.lastSkill = 'facts/origin';
    state.turn.lastTurnAskedQuestion = true;
    const h = harness([res({ content: 'Here they are.' })]);
    const out = await runAgentTurn({ state, userMessage: joinFactPick(DEVICE_OPTIONS), deps: h.deps });
    const flat = h.saves.flat().map((e) => [e.statement, e.questionnaire_attribute]);
    expect(flat).toContainEqual(['From India', ORIGIN_KEY]);
    expect(flat).toContainEqual(['Expat in The Netherlands', EXPAT_KEY]);
    expect(out.terminalReason).not.toBe('awaiting-user');
  });
});

// Staging run 20260924-150827 repeat 0, verbatim: the model resolved the place,
// then ended on a prose question with nothing offered.
describe('ruling: a turn that ends on prose with a resolved place offers it', () => {
  const NW = { neighbourhood: 'Nieuw-West', locality: 'Amsterdam', admin1: 'North Holland', countryCode: 'NL', countryName: 'The Netherlands', bloc: 'EU' as const };
  const lookup: AgentDeps['tools']['lookupPlace'] = async (a) =>
    /west/i.test(a.query) ? { status: 'resolved', places: [NW] } : { status: 'unavailable' };
  const REPEAT0 = [
    res({ content: 'Got it, an expat from India living in Nieuw-West. One moment.', toolCalls: [tc('load_skill', { id: 'facts/origin' })] }),
    res({
      content: 'I’d like to save both details, but first I need to pin down the places properly. Let me check them.',
      toolCalls: [tc('lookup_place', { query: 'New West Amsterdam', countryHint: 'NL' }), tc('lookup_place', { query: 'India' })],
    }),
    res({ toolCalls: [tc('lookup_place', { query: 'India' })] }),
    res({ content: "Great, that's helpful. One quick check before I lock this in: is **India** the country you originally come from (your expat origin), or just where you lived before the Netherlands?" }),
  ];

  it('offers the residence, and the origin and expat status the message states plainly', async () => {
    const h = harness(REPEAT0, lookup);
    const out = await runAgentTurn({ state: createAgentState({ surface: 'CONFIG', facts: [] }), userMessage: DEVICE_MESSAGE, deps: h.deps });
    const flat = h.saves.flat().map((e) => [e.statement, e.questionnaire_attribute]);
    expect(flat).toContainEqual(['Lives in Nieuw-West, Amsterdam, North Holland, The Netherlands, EU', CANONICAL_LOCATION_KEY]);
    expect(flat).toContainEqual(['From India', ORIGIN_KEY]);
    expect(flat).toContainEqual(['Expat in The Netherlands', EXPAT_KEY]);
    // The question the cards now answer is not left above them.
    expect(out.reply).not.toMatch(/\?\s*$/);
  });

  it('offers only the residence when the rest of the message is not plain', async () => {
    const h = harness(REPEAT0, lookup);
    await runAgentTurn({
      state: createAgentState({ surface: 'CONFIG', facts: [] }),
      userMessage: 'I live in niew West Amsterdam, my family is partly from india and partly from kenya',
      deps: h.deps,
    });
    expect(h.saves.flat().map((e) => e.statement)).toEqual(['Lives in Nieuw-West, Amsterdam, North Holland, The Netherlands, EU']);
  });

  it('never when a home was already offered, or the place is in the origin country', async () => {
    const IN = { locality: 'Delhi', admin1: 'Delhi', countryCode: 'IN', countryName: 'India', bloc: null };
    const h = harness(
      [
        res({ content: 'Delhi.', toolCalls: [tc('load_skill', { id: 'facts/origin' })] }),
        res({ toolCalls: [tc('lookup_place', { query: 'Delhi' })] }),
        res({ content: 'Did you grow up in Delhi, or just live there for a while?' }),
      ],
      async () => ({ status: 'resolved', places: [IN] }),
    );
    await runAgentTurn({ state: createAgentState({ surface: 'CONFIG', facts: [] }), userMessage: "I'm from India, I grew up in Delhi", deps: h.deps });
    expect(h.saves).toEqual([]);
  });

  it('never on a turn that asked with chips', async () => {
    const h = harness(
      [
        res({ content: 'Porto.', toolCalls: [tc('load_skill', { id: 'facts/origin' })] }),
        res({ toolCalls: [tc('lookup_place', { query: 'New West' })] }),
        res({ toolCalls: [tc('ask_choice', { question: 'Which one?', options: ['Nieuw-West, Amsterdam', 'New West, Canada'] })] }),
      ],
      // Two matches: a real place question, which the loop lets through.
      async () => ({ status: 'resolved', places: [NW, { locality: 'New Westminster', admin1: 'British Columbia', countryCode: 'CA', countryName: 'Canada', bloc: null }] }),
    );
    const out = await runAgentTurn({ state: createAgentState({ surface: 'CONFIG', facts: [] }), userMessage: 'I live in New West', deps: h.deps });
    expect(out.terminalReason).toBe('awaiting-user');
    expect(h.saves).toEqual([]);
  });
});

describe('ruling: a parenthesised place chain is written in the comma form', () => {
  it('Lives in Nieuw-West, Amsterdam (North Holland, The Netherlands)', async () => {
    const h = harness([
      res({ content: 'Amsterdam.', toolCalls: [tc('load_skill', { id: 'facts/residence' })] }),
      res({ toolCalls: [tc('lookup_place', { query: 'Nieuw-West' })] }),
      res({ toolCalls: [tc('saveExtractedFacts', { extracted_user_information: [
        { statement: 'Lives in Nieuw-West, Amsterdam (North Holland, The Netherlands)', questionnaire_attribute: CANONICAL_LOCATION_KEY },
      ] })] }),
      res({ content: 'Here it is.' }),
    ], async () => ({ status: 'resolved', places: [{ neighbourhood: 'Nieuw-West', ...NL }] }));
    await runAgentTurn({ state: createAgentState({ surface: 'CONFIG', facts: [] }), userMessage: 'I live in Nieuw-West', deps: h.deps });
    expect(h.saves.flat().map((e) => e.statement)).toEqual(['Lives in Nieuw-West, Amsterdam, North Holland, The Netherlands']);
  });
});
