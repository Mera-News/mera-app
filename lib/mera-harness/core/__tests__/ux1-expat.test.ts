// Owner decision (ux1, 2026-09-24): an expat is THREE separate facts, never
// one combined fact. Origin, expat status, and residence, each manageable.

import { createAgentState, runAgentTurn, type AgentPersona } from '../core';
import {
  CANONICAL_LOCATION_KEY,
  COMBINED_ORIGIN_KEY,
  EXPAT_KEY,
  ORIGIN_KEY,
  countryOf,
  toOriginStatement,
} from '../combined-fact';
import type { AgentDeps, AgentModelResult } from '../types';

function res(over: Partial<AgentModelResult> = {}): AgentModelResult {
  return {
    content: '', toolCalls: [], finishReason: 'stop', truncated: false,
    usage: null, modelSent: 'fake', latencyMs: 1, error: null, ...over,
  };
}
const tc = (name: string, args: unknown) => ({ name, argumentsRaw: JSON.stringify(args) });
const SKILLS: Record<string, string> = {
  'facts/residence': 'R', 'facts/origin': 'O', 'topics/origin': 'x', 'topics/residence': 'x',
};

function harness(script: AgentModelResult[], extra: Partial<AgentDeps> = {}) {
  const saves: Record<string, unknown>[][] = [];
  let i = 0;
  const deps: AgentDeps = {
    callModel: async () => script[Math.min(i++, script.length - 1)],
    tools: {
      findSimilarFacts: async () => ({ candidates: [] }),
      lookupPlace: async () => ({ status: 'no_match', query: '' }),
      saveExtractedFacts: async (a) => { saves.push((a.extracted_user_information as Record<string, unknown>[]) ?? []); return { staged: true }; },
      deleteUserFacts: async () => ({ deleted: [] }),
    },
    loadSkill: (id) => SKILLS[id] ?? null,
    skillIds: () => Object.keys(SKILLS),
    ...extra,
  };
  return { deps, saves };
}
const brief = (e: Record<string, unknown>) => [e.statement, e.questionnaire_attribute, e.replaces ?? null];

describe('helpers', () => {
  it('reads the origin and the country', () => {
    expect(toOriginStatement('Expat from India')).toBe('From India');
    expect(toOriginStatement('Expat originally from Kerala, India')).toBe('From Kerala, India');
    expect(countryOf('Lives in Nieuw-West, Amsterdam, North Holland, The Netherlands, EU')).toBe('The Netherlands');
    expect(countryOf('Lives in Berlin, State of Berlin, Germany, EU')).toBe('Germany');
    expect(countryOf('Lives in Berlin')).toBeNull();
  });

  // Staging run 20260924-140712-ux1-expat: an unresolved "Nieuw-West,
  // Amsterdam" gave "Expat in Amsterdam". A country is read only from a
  // resolved chain (it ends in a bloc) or from a place the lookup returned.
  it('never reads a city as a country', () => {
    expect(countryOf('Lives in Nieuw-West, Amsterdam')).toBeNull();
    expect(countryOf('Lives in Nieuw-West, Amsterdam', [{ locality: 'Amsterdam', countryName: 'The Netherlands' }]))
      .toBe('The Netherlands');
  });
});

describe('a combined statement from the model becomes three facts', () => {
  it('splits it before it reaches a card, and never uses the combined key', async () => {
    const h = harness([
      res({ content: 'India.', toolCalls: [tc('load_skill', { id: 'facts/origin' })] }),
      res({ toolCalls: [tc('saveExtractedFacts', { extracted_user_information: [
        { statement: 'Expat from India living in Nieuw-West, Amsterdam, North Holland, The Netherlands, EU', questionnaire_attribute: COMBINED_ORIGIN_KEY },
      ] })] }),
      res({ content: 'Here they are.' }),
    ]);
    await runAgentTurn({ state: createAgentState({ surface: 'CONFIG', facts: [] }), userMessage: 'I am an expat from India living in Nieuw-West Amsterdam', deps: h.deps });
    expect(h.saves.flat().map(brief)).toEqual([
      ['From India', ORIGIN_KEY, null],
      ['Expat in The Netherlands', EXPAT_KEY, null],
      ['Lives in Nieuw-West, Amsterdam, North Holland, The Netherlands, EU', CANONICAL_LOCATION_KEY, null],
    ]);
  });

  it('writes the exact keys even when the model shortens them', async () => {
    const h = harness([
      res({ content: 'India.', toolCalls: [tc('load_skill', { id: 'facts/origin' })] }),
      res({ toolCalls: [tc('saveExtractedFacts', { extracted_user_information: [
        { statement: 'From India', questionnaire_attribute: 'origin' },
        { statement: 'Expat in the Netherlands', questionnaire_attribute: 'expat' },
        { statement: 'Lives in Amsterdam, The Netherlands, EU', questionnaire_attribute: 'location' },
      ] })] }),
      res({ content: 'Here they are.' }),
    ]);
    await runAgentTurn({ state: createAgentState({ surface: 'CONFIG', facts: [] }), userMessage: 'expat from india in amsterdam', deps: h.deps });
    expect(h.saves.flat().map((e) => e.questionnaire_attribute)).toEqual([ORIGIN_KEY, EXPAT_KEY, CANONICAL_LOCATION_KEY]);
  });
});

describe('an unresolved place gets no expat status', () => {
  it('splits into origin and residence only when no country is known', async () => {
    const h = harness([
      res({ content: 'India.', toolCalls: [tc('load_skill', { id: 'facts/origin' })] }),
      res({ toolCalls: [tc('saveExtractedFacts', { extracted_user_information: [
        { statement: 'I am an expat from India living in Nieuw-West, Amsterdam.' },
      ] })] }),
      res({ content: 'Here they are.' }),
    ]);
    await runAgentTurn({ state: createAgentState({ surface: 'CONFIG', facts: [] }), userMessage: 'expat from India in Nieuw-West Amsterdam', deps: h.deps });
    expect(h.saves.flat().map((e) => e.statement)).toEqual(['From India', 'Lives in Nieuw-West, Amsterdam']);
  });
});

describe('the one-time split of an existing combined fact', () => {
  it('offers all three facts, the origin replacing the combined one', async () => {
    const COMBINED: AgentPersona = {
      surface: 'CONFIG',
      facts: [{ id: 'c1', statement: 'Expat from India living in Nieuw West, Amsterdam, North Holland, The Netherlands, EU', attribute: COMBINED_ORIGIN_KEY }],
    };
    const h = harness([
      res({ content: 'India.', toolCalls: [tc('load_skill', { id: 'facts/origin' })] }),
      res({ content: 'Got it.' }),
    ]);
    await runAgentTurn({ state: createAgentState(COMBINED), userMessage: 'I grew up in India', deps: h.deps });
    expect(h.saves.flat().map(brief)).toEqual([
      ['From India', ORIGIN_KEY, 'c1'],
      ['Expat in The Netherlands', EXPAT_KEY, null],
      ['Lives in Nieuw West, Amsterdam, North Holland, The Netherlands, EU', CANONICAL_LOCATION_KEY, null],
    ]);
  });
});

describe('a move that changes country', () => {
  const EXPAT: AgentPersona = {
    surface: 'CONFIG',
    facts: [
      { id: 'o', statement: 'From India', attribute: ORIGIN_KEY },
      { id: 'x', statement: 'Expat in The Netherlands', attribute: EXPAT_KEY },
      { id: 'h', statement: 'Lives in Amsterdam, North Holland, The Netherlands, EU', attribute: CANONICAL_LOCATION_KEY },
    ],
  };
  const moveTo = (statement: string) => harness([
    res({ content: 'Moving.', toolCalls: [tc('load_skill', { id: 'facts/residence' })] }),
    res({ toolCalls: [tc('saveExtractedFacts', { extracted_user_information: [{ statement, questionnaire_attribute: CANONICAL_LOCATION_KEY }] })] }),
    res({ content: 'Here it is.' }),
  ]);

  it('also offers to update the expat status', async () => {
    const h = moveTo('Lives in Berlin, State of Berlin, Germany, EU');
    await runAgentTurn({ state: createAgentState(EXPAT), userMessage: 'I moved to Berlin', deps: h.deps });
    expect(h.saves.flat().map(brief)).toEqual([
      ['Lives in Berlin, State of Berlin, Germany, EU', CANONICAL_LOCATION_KEY, 'h'],
      ['Expat in Germany', EXPAT_KEY, 'x'],
    ]);
  });

  it('leaves the expat status alone within the same country', async () => {
    const h = moveTo('Lives in Rotterdam, South Holland, The Netherlands, EU');
    await runAgentTurn({ state: createAgentState(EXPAT), userMessage: 'I moved to Rotterdam', deps: h.deps });
    expect(h.saves.flat().map(brief)).toEqual([
      ['Lives in Rotterdam, South Holland, The Netherlands, EU', CANONICAL_LOCATION_KEY, 'h'],
    ]);
  });

  it('never offers "Expat in" the country the user is from', async () => {
    const h = moveTo('Lives in Bangalore, Karnataka, India, Asia');
    await runAgentTurn({ state: createAgentState(EXPAT), userMessage: 'I moved back to Bangalore', deps: h.deps });
    expect(h.saves.flat().map((e) => e.statement)).toEqual(['Lives in Bangalore, Karnataka, India, Asia']);
  });
});
