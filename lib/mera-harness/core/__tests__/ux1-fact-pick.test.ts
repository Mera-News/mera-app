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
