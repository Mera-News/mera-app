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

// Staging run 20260924-140931-ux1-expat-2: the model wrote first-person
// statements, skipped the lookup, and asked about the replacement despite
// the skill. Each is fixed in the loop, not in wording.
describe('staging run 2 findings', () => {
  const NL = { neighbourhood: 'Nieuw-West', locality: 'Amsterdam', admin1: 'North Holland', countryCode: 'NL', countryName: 'The Netherlands', bloc: 'EU' as const };

  it('turns first-person statements into facts, and an expat origin into origin plus status', async () => {
    const lookups: string[] = [];
    const h = harness(
      [
        res({ content: 'India.', toolCalls: [tc('load_skill', { id: 'facts/origin' })] }),
        res({ toolCalls: [tc('saveExtractedFacts', { extracted_user_information: [
          { statement: 'I am an expat from India', questionnaire_attribute: 'origin' },
          { statement: 'I live in Nieuw-West, Amsterdam', questionnaire_attribute: 'location' },
        ] })] }),
        res({ content: 'Here they are.' }),
      ],
      {
        tools: {
          findSimilarFacts: async () => ({ candidates: [] }),
          lookupPlace: async (a) => { lookups.push(a.query); return { status: 'resolved', places: [NL] }; },
          saveExtractedFacts: async (a) => { h2.push((a.extracted_user_information as Record<string, unknown>[]) ?? []); return { staged: true }; },
          deleteUserFacts: async () => ({ deleted: [] }),
        },
      },
    );
    const h2: Record<string, unknown>[][] = [];
    await runAgentTurn({ state: createAgentState({ surface: 'CONFIG', facts: [] }), userMessage: 'expat from India in Nieuw-West', deps: h.deps });
    // The loop looked the place up itself, since the model did not.
    expect(lookups).toEqual(['Nieuw-West, Amsterdam']);
    expect(h2.flat().map((e) => [e.statement, e.questionnaire_attribute])).toEqual([
      ['From India', ORIGIN_KEY],
      ['Lives in Nieuw-West, Amsterdam, North Holland, The Netherlands, EU', CANONICAL_LOCATION_KEY],
      ['Expat in The Netherlands', EXPAT_KEY],
    ]);
  });

  it('rewrites "Moved to X last month" as a residence', async () => {
    const h = harness([
      res({ content: 'Berlin.', toolCalls: [tc('load_skill', { id: 'facts/residence' })] }),
      res({ toolCalls: [tc('saveExtractedFacts', { extracted_user_information: [
        { statement: 'Moved to Berlin, Berlin, Germany, EU last month', questionnaire_attribute: CANONICAL_LOCATION_KEY },
      ] })] }),
      res({ content: 'Here it is.' }),
    ]);
    await runAgentTurn({ state: createAgentState({ surface: 'CONFIG', facts: [] }), userMessage: 'I moved to Berlin last month', deps: h.deps });
    expect(h.saves.flat().map((e) => e.statement)).toEqual(['Lives in Berlin, Germany, EU']);
  });

  it('refuses a replacement question on a residence turn: the card asks', async () => {
    const DE = { locality: 'Berlin', admin1: 'Berlin', countryCode: 'DE', countryName: 'Germany', bloc: 'EU' as const };
    const HOME: AgentPersona = { surface: 'CONFIG', facts: [{ id: 'h', statement: 'Lives in Amsterdam, North Holland, The Netherlands, EU', attribute: CANONICAL_LOCATION_KEY }] };
    const h = harness(
      [
        res({ content: 'Berlin.', toolCalls: [tc('load_skill', { id: 'facts/residence' })] }),
        res({ toolCalls: [tc('lookup_place', { query: 'Berlin' })] }),
        res({ toolCalls: [tc('ask_choice', { question: 'Berlin replaces your Amsterdam fact?', options: ['Yes', 'No'] })] }),
        res({ toolCalls: [tc('saveExtractedFacts', { extracted_user_information: [{ statement: 'Lives in Berlin, Germany, EU', questionnaire_attribute: CANONICAL_LOCATION_KEY }] })] }),
        res({ content: 'Here it is.' }),
      ],
      {
        tools: {
          findSimilarFacts: async () => ({ candidates: [] }),
          lookupPlace: async () => ({ status: 'resolved', places: [DE] }),
          saveExtractedFacts: async (a) => { saved.push((a.extracted_user_information as Record<string, unknown>[]) ?? []); return { staged: true }; },
          deleteUserFacts: async () => ({ deleted: [] }),
        },
      },
    );
    const saved: Record<string, unknown>[][] = [];
    const out = await runAgentTurn({ state: createAgentState(HOME), userMessage: 'I moved to Berlin', deps: h.deps });
    expect(out.terminalReason).not.toBe('awaiting-user');
    expect(saved.flat().map((e) => [e.statement, e.replaces])).toEqual([['Lives in Berlin, Germany, EU', 'h']]);
  });
});

describe('staging run 3 findings', () => {
  const NL = { neighbourhood: 'Nieuw-West', locality: 'Amsterdam', admin1: 'North Holland', countryCode: 'NL', countryName: 'The Netherlands', bloc: 'EU' as const };
  const DE = { locality: 'Berlin', admin1: 'Berlin', countryCode: 'DE', countryName: 'Germany', bloc: 'EU' as const };

  function withPlace(place: typeof NL | typeof DE, saved: Record<string, unknown>[][], lookups: string[] = []) {
    return {
      tools: {
        findSimilarFacts: async () => ({ candidates: [] }),
        lookupPlace: async (a: { query: string }) => { lookups.push(a.query); return { status: 'resolved' as const, places: [place] }; },
        saveExtractedFacts: async (a: Record<string, unknown>) => { saved.push((a.extracted_user_information as Record<string, unknown>[]) ?? []); return { staged: true }; },
        deleteUserFacts: async () => ({ deleted: [] }),
      },
    };
  }

  it('reads "User is ..." statements and snake-case keys as origin and residence', async () => {
    const saved: Record<string, unknown>[][] = [];
    const h = harness(
      [
        res({ content: 'India.', toolCalls: [tc('load_skill', { id: 'facts/origin' })] }),
        res({ toolCalls: [tc('lookup_place', { query: 'Nieuw-West, Amsterdam' })] }),
        res({ toolCalls: [tc('saveExtractedFacts', { extracted_user_information: [
          { statement: 'User is an expat from India', questionnaire_attribute: 'origin' },
          { statement: 'User lives in Nieuw-West, Amsterdam, North Holland, The Netherlands', questionnaire_attribute: 'residence' },
        ] })] }),
        res({ content: 'Here they are.' }),
      ],
      withPlace(NL, saved),
    );
    await runAgentTurn({ state: createAgentState({ surface: 'CONFIG', facts: [] }), userMessage: 'expat from India in Nieuw-West', deps: h.deps });
    expect(saved.flat().map((e) => [e.statement, e.questionnaire_attribute])).toEqual([
      ['From India', ORIGIN_KEY],
      ['Lives in Nieuw-West, Amsterdam, North Holland, The Netherlands', CANONICAL_LOCATION_KEY],
      ['Expat in The Netherlands', EXPAT_KEY],
    ]);
  });

  it('maps origin_country and residence_location keys', async () => {
    const saved: Record<string, unknown>[][] = [];
    const h = harness(
      [
        res({ content: 'India.', toolCalls: [tc('load_skill', { id: 'facts/origin' })] }),
        res({ toolCalls: [tc('lookup_place', { query: 'Nieuw-West' })] }),
        res({ toolCalls: [tc('saveExtractedFacts', { extracted_user_information: [
          { statement: 'I live in Nieuw-West, Amsterdam', questionnaire_attribute: 'residence_location' },
          { statement: 'I am an expat from India', questionnaire_attribute: 'origin_country' },
        ] })] }),
        res({ content: 'Here they are.' }),
      ],
      withPlace(NL, saved),
    );
    await runAgentTurn({ state: createAgentState({ surface: 'CONFIG', facts: [] }), userMessage: 'expat from India in Nieuw-West', deps: h.deps });
    const flat = saved.flat().map((e) => [e.statement, e.questionnaire_attribute]);
    expect(flat).toContainEqual(['From India', ORIGIN_KEY]);
    expect(flat).toContainEqual(['Expat in The Netherlands', EXPAT_KEY]);
    expect(flat.find(([, k]) => k === CANONICAL_LOCATION_KEY)?.[0]).toMatch(/^Lives in Nieuw-West, Amsterdam/);
  });

  it('a move saved before any lookup still moves the expat status', async () => {
    const saved: Record<string, unknown>[][] = [];
    const lookups: string[] = [];
    const EXPAT: AgentPersona = {
      surface: 'CONFIG',
      facts: [
        { id: 'o', statement: 'From India', attribute: ORIGIN_KEY },
        { id: 'x', statement: 'Expat in The Netherlands', attribute: EXPAT_KEY },
        { id: 'h', statement: 'Lives in Nieuw-West, Amsterdam, North Holland, The Netherlands, EU', attribute: CANONICAL_LOCATION_KEY },
      ],
    };
    const h = harness(
      [
        res({ content: 'Berlin.', toolCalls: [tc('load_skill', { id: 'facts/residence' })] }),
        res({ toolCalls: [tc('saveExtractedFacts', { extracted_user_information: [
          { statement: 'Lives in Berlin, Germany', questionnaire_attribute: 'residence_city' },
        ] })] }),
        res({ content: 'Here it is.' }),
      ],
      withPlace(DE, saved, lookups),
    );
    await runAgentTurn({ state: createAgentState(EXPAT), userMessage: 'I moved to Berlin last month', deps: h.deps });
    expect(lookups).toEqual(['Berlin, Germany']);
    expect(saved.flat().map((e) => [e.statement, e.replaces])).toEqual([
      ['Lives in Berlin, Germany, EU', 'h'],
      ['Expat in Germany', 'x'],
    ]);
  });
});

describe('staging run 4 findings', () => {
  const NL = { neighbourhood: 'Nieuw-West', locality: 'Amsterdam', admin1: 'North Holland', countryCode: 'NL', countryName: 'The Netherlands', bloc: 'EU' as const };
  const DE = { locality: 'Berlin', admin1: 'Berlin', countryCode: 'DE', countryName: 'Germany', bloc: 'EU' as const };
  const EXPAT: AgentPersona = {
    surface: 'CONFIG',
    facts: [
      { id: 'o', statement: 'From India', attribute: ORIGIN_KEY },
      { id: 'x', statement: 'Expat in The Netherlands', attribute: EXPAT_KEY },
      { id: 'h', statement: 'Lives in Amsterdam, North Holland, The Netherlands, EU', attribute: CANONICAL_LOCATION_KEY },
    ],
  };
  function withPlace(place: typeof NL | typeof DE, saved: Record<string, unknown>[][]) {
    return {
      tools: {
        findSimilarFacts: async () => ({ candidates: [] }),
        lookupPlace: async () => ({ status: 'resolved' as const, places: [place] }),
        saveExtractedFacts: async (a: Record<string, unknown>) => { saved.push((a.extracted_user_information as Record<string, unknown>[]) ?? []); return { staged: true }; },
        deleteUserFacts: async () => ({ deleted: [] }),
      },
    };
  }

  it('reads a bracketed replaces id', async () => {
    const saved: Record<string, unknown>[][] = [];
    const h = harness(
      [
        res({ content: 'Berlin.', toolCalls: [tc('load_skill', { id: 'facts/residence' })] }),
        res({ toolCalls: [tc('saveExtractedFacts', { extracted_user_information: [
          { statement: 'Lives in Berlin, Germany', questionnaire_attribute: CANONICAL_LOCATION_KEY, replaces: '[h]' },
        ] })] }),
        res({ content: 'Here it is.' }),
      ],
      withPlace(DE, saved),
    );
    await runAgentTurn({ state: createAgentState(EXPAT), userMessage: 'I moved to Berlin', deps: h.deps });
    expect(saved.flat().map((e) => [e.statement, e.replaces])).toEqual([
      ['Lives in Berlin, Germany, EU', 'h'],
      ['Expat in Germany', 'x'],
    ]);
  });

  it('refuses a question once the home card is offered: the card asks', async () => {
    const saved: Record<string, unknown>[][] = [];
    const h = harness(
      [
        res({ content: 'Berlin.', toolCalls: [tc('load_skill', { id: 'facts/residence' })] }),
        res({ toolCalls: [tc('saveExtractedFacts', { extracted_user_information: [
          { statement: 'Lives in Berlin, Germany, EU', questionnaire_attribute: CANONICAL_LOCATION_KEY, replaces: 'h' },
        ] })] }),
        res({ toolCalls: [tc('ask_choice', { question: 'Should I replace your Amsterdam address with Berlin?', options: ['Yes', 'No'] })] }),
        res({ content: 'Here it is.' }),
      ],
      withPlace(DE, saved),
    );
    const out = await runAgentTurn({ state: createAgentState(EXPAT), userMessage: 'I moved to Berlin', deps: h.deps });
    expect(out.terminalReason).not.toBe('awaiting-user');
  });

  it('reads "Is an expat from India" as the origin, and drops a bare "Expat."', async () => {
    const saved: Record<string, unknown>[][] = [];
    const h = harness(
      [
        res({ content: 'India.', toolCalls: [tc('load_skill', { id: 'facts/origin' })] }),
        res({ toolCalls: [tc('lookup_place', { query: 'Nieuw-West, Amsterdam' })] }),
        res({ toolCalls: [tc('saveExtractedFacts', { extracted_user_information: [
          { statement: 'The user is an expat.', questionnaire_attribute: 'residency_status' },
          { statement: 'Lives in Nieuw-West, Amsterdam, North Holland, The Netherlands', questionnaire_attribute: 'residence' },
          { statement: 'Is an expat from India', questionnaire_attribute: 'origin' },
        ] })] }),
        res({ content: 'Here they are.' }),
      ],
      withPlace(NL, saved),
    );
    await runAgentTurn({ state: createAgentState({ surface: 'CONFIG', facts: [] }), userMessage: 'expat from India in Nieuw-West', deps: h.deps });
    expect(saved.flat().map((e) => e.statement)).toEqual([
      'Lives in Nieuw-West, Amsterdam, North Holland, The Netherlands',
      'From India',
      'Expat in The Netherlands',
    ]);
  });
});

describe('the bare-expat drop and the subject strip stay narrow', () => {
  it('keeps "Expat" when no expat status replaces it', async () => {
    const h = harness([
      res({ content: 'Amsterdam.', toolCalls: [tc('load_skill', { id: 'facts/residence' })] }),
      res({ toolCalls: [tc('saveExtractedFacts', { extracted_user_information: [
        { statement: 'The user is an expat.', questionnaire_attribute: 'residency_status' },
      ] })] }),
      res({ content: 'Here it is.' }),
    ]);
    await runAgentTurn({ state: createAgentState({ surface: 'CONFIG', facts: [] }), userMessage: "I'm an expat", deps: h.deps });
    expect(h.saves.flat().map((e) => e.statement)).toEqual(['Expat.']);
  });

  it('leaves a "User ..." fact that is not a home, origin or expat alone', async () => {
    const h = harness([
      res({ content: 'Work.', toolCalls: [tc('load_skill', { id: 'facts/residence' })] }),
      res({ toolCalls: [tc('saveExtractedFacts', { extracted_user_information: [
        { statement: 'User researcher at Booking', questionnaire_attribute: 'occupation' },
      ] })] }),
      res({ content: 'Here it is.' }),
    ]);
    await runAgentTurn({ state: createAgentState({ surface: 'CONFIG', facts: [] }), userMessage: 'I research at Booking', deps: h.deps });
    expect(h.saves.flat().map((e) => e.statement)).toEqual(['User researcher at Booking']);
  });
});

describe('ruling: the loop offers a resolved residence the model left out', () => {
  const NL = { neighbourhood: 'Nieuw-West', locality: 'Amsterdam', admin1: 'North Holland', countryCode: 'NL', countryName: 'The Netherlands', bloc: 'EU' as const };
  const IN = { locality: 'Delhi', admin1: 'Delhi', countryCode: 'IN', countryName: 'India', bloc: null };
  function withPlace(place: typeof NL | typeof IN, saved: Record<string, unknown>[][]) {
    return {
      tools: {
        findSimilarFacts: async () => ({ candidates: [] }),
        lookupPlace: async () => ({ status: 'resolved' as const, places: [place] }),
        saveExtractedFacts: async (a: Record<string, unknown>) => { saved.push((a.extracted_user_information as Record<string, unknown>[]) ?? []); return { staged: true }; },
        deleteUserFacts: async () => ({ deleted: [] }),
      },
    };
  }

  it('adds the residence as a proposal when the model saved only the origin', async () => {
    const saved: Record<string, unknown>[][] = [];
    const h = harness(
      [
        res({ content: 'India.', toolCalls: [tc('load_skill', { id: 'facts/origin' })] }),
        res({ toolCalls: [tc('lookup_place', { query: 'Nieuw-West', countryHint: 'NL' })] }),
        res({ toolCalls: [tc('saveExtractedFacts', { extracted_user_information: [
          { statement: 'User is an expat from India', questionnaire_attribute: 'origin_country' },
        ] })] }),
        res({ content: 'Here they are.' }),
      ],
      withPlace(NL, saved),
    );
    await runAgentTurn({ state: createAgentState({ surface: 'CONFIG', facts: [] }), userMessage: "I'm an expat from India living in Nieuw-West, Amsterdam", deps: h.deps });
    expect(saved.flat().map((e) => [e.statement, e.questionnaire_attribute])).toEqual([
      ['From India', ORIGIN_KEY],
      ['Lives in Nieuw-West, Amsterdam, North Holland, The Netherlands, EU', CANONICAL_LOCATION_KEY],
      ['Expat in The Netherlands', EXPAT_KEY],
    ]);
  });

  it('never adds a place in the origin country as the residence', async () => {
    const saved: Record<string, unknown>[][] = [];
    const h = harness(
      [
        res({ content: 'India.', toolCalls: [tc('load_skill', { id: 'facts/origin' })] }),
        res({ toolCalls: [tc('lookup_place', { query: 'Delhi' })] }),
        res({ toolCalls: [tc('saveExtractedFacts', { extracted_user_information: [
          { statement: 'From Delhi, India', questionnaire_attribute: ORIGIN_KEY },
        ] })] }),
        res({ content: 'Here it is.' }),
      ],
      withPlace(IN, saved),
    );
    await runAgentTurn({ state: createAgentState({ surface: 'CONFIG', facts: [] }), userMessage: 'I grew up in Delhi', deps: h.deps });
    expect(saved.flat().map((e) => e.statement)).toEqual(['From Delhi, India']);
  });
});

describe('ruling: no place question before a lookup on a residence turn', () => {
  it('refuses the question and the leg continues to a lookup', async () => {
    const DE = { locality: 'Berlin', admin1: 'Berlin', countryCode: 'DE', countryName: 'Germany', bloc: 'EU' as const };
    const saved: Record<string, unknown>[][] = [];
    const h = harness(
      [
        res({ content: 'Berlin.', toolCalls: [tc('load_skill', { id: 'facts/residence' })] }),
        res({ toolCalls: [tc('ask_choice', { question: 'Where exactly in Berlin do you live?', options: ['Mitte', 'Somewhere else'] })] }),
        res({ toolCalls: [tc('lookup_place', { query: 'Berlin' })] }),
        res({ toolCalls: [tc('saveExtractedFacts', { extracted_user_information: [{ statement: 'Lives in Berlin, Germany, EU', questionnaire_attribute: CANONICAL_LOCATION_KEY }] })] }),
        res({ content: 'Here it is.' }),
      ],
      {
        tools: {
          findSimilarFacts: async () => ({ candidates: [] }),
          lookupPlace: async () => ({ status: 'resolved', places: [DE] }),
          saveExtractedFacts: async (a) => { saved.push((a.extracted_user_information as Record<string, unknown>[]) ?? []); return { staged: true }; },
          deleteUserFacts: async () => ({ deleted: [] }),
        },
      },
    );
    const out = await runAgentTurn({ state: createAgentState({ surface: 'CONFIG', facts: [] }), userMessage: 'I moved to Berlin', deps: h.deps });
    expect(out.terminalReason).not.toBe('awaiting-user');
    expect(saved.flat().map((e) => e.statement)).toEqual(['Lives in Berlin, Germany, EU']);
  });

  it('still asks after a lookup found nothing', async () => {
    const h = harness(
      [
        res({ content: 'Zorp.', toolCalls: [tc('load_skill', { id: 'facts/residence' })] }),
        res({ toolCalls: [tc('lookup_place', { query: 'Zorp' })] }),
        res({ toolCalls: [tc('ask_choice', { question: 'Which place did you mean?', options: ['Zorp', 'Somewhere else'] })] }),
      ],
      {
        tools: {
          findSimilarFacts: async () => ({ candidates: [] }),
          lookupPlace: async () => ({ status: 'no_match', query: 'Zorp' }),
          saveExtractedFacts: async () => ({ staged: true }),
          deleteUserFacts: async () => ({ deleted: [] }),
        },
      },
    );
    const out = await runAgentTurn({ state: createAgentState({ surface: 'CONFIG', facts: [] }), userMessage: 'I live in Zorp', deps: h.deps });
    expect(out.terminalReason).toBe('awaiting-user');
  });
});

describe('staging run 6 finding', () => {
  it('reads every word of a snake-case key: country_of_origin is the origin', async () => {
    const NL = { neighbourhood: 'Nieuw-West', locality: 'Amsterdam', admin1: 'North Holland', countryCode: 'NL', countryName: 'The Netherlands', bloc: 'EU' as const };
    const saved: Record<string, unknown>[][] = [];
    const h = harness(
      [
        res({ content: 'India.', toolCalls: [tc('load_skill', { id: 'facts/origin' })] }),
        res({ toolCalls: [tc('lookup_place', { query: 'Nieuw-West, Amsterdam', countryHint: 'NL' })] }),
        res({ toolCalls: [tc('saveExtractedFacts', { extracted_user_information: [
          { statement: 'The user is an expat from India.', kind: 'origin', questionnaire_attribute: 'country_of_origin', placeChain: { countryName: 'India' } },
          { statement: 'The user lives in Nieuw-West, Amsterdam, North Holland, The Netherlands.', kind: 'residence', questionnaire_attribute: 'current_residence' },
        ] })] }),
        res({ content: 'Here they are.' }),
      ],
      {
        tools: {
          findSimilarFacts: async () => ({ candidates: [] }),
          lookupPlace: async () => ({ status: 'resolved', places: [NL] }),
          saveExtractedFacts: async (a) => { saved.push((a.extracted_user_information as Record<string, unknown>[]) ?? []); return { staged: true }; },
          deleteUserFacts: async () => ({ deleted: [] }),
        },
      },
    );
    await runAgentTurn({ state: createAgentState({ surface: 'CONFIG', facts: [] }), userMessage: "I'm an expat from India living in Nieuw-West, Amsterdam", deps: h.deps });
    const flat = saved.flat().map((e) => [e.statement, e.questionnaire_attribute]);
    expect(flat).toContainEqual(['From India', ORIGIN_KEY]);
    expect(flat).toContainEqual(['Expat in The Netherlands', EXPAT_KEY]);
    expect(flat.find(([, k]) => k === CANONICAL_LOCATION_KEY)?.[0]).toMatch(/^Lives in Nieuw-West, Amsterdam/);
  });
});
