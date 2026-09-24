// B1 (release group G3): several subjects in one turn, behind the
// `multi-subject` arm. OFF by default; these pin both the arm and the control.

import { createAgentState, runAgentTurn, type AgentPersona } from '../core';
import { MULTI_SUBJECT_ARM_ID } from '../arms';
import { buildRouterPrompt } from '../router-prompt';
import type { AgentDeps, AgentModelResult, Place } from '../types';

const BERLIN: Place = { locality: 'Berlin', admin1: 'Berlin', countryCode: 'DE', countryName: 'Germany', bloc: 'EU' };
const BERLIN_NH: Place = { ...BERLIN, admin1: 'New Hampshire', countryCode: 'US', countryName: 'United States', bloc: 'North America' };

function res(over: Partial<AgentModelResult> = {}): AgentModelResult {
  return {
    content: '', toolCalls: [], finishReason: 'stop', truncated: false,
    usage: null, modelSent: 'fake', latencyMs: 1, error: null, ...over,
  };
}
const tc = (name: string, args: unknown) => ({ name, argumentsRaw: JSON.stringify(args) });
const save = (statement: string, extra: Record<string, unknown> = {}) =>
  tc('saveExtractedFacts', { extracted_user_information: [{ statement, ...extra }] });

const SKILLS: Record<string, string> = {
  'facts/residence': 'RESIDENCE SKILL BODY',
  'facts/profession': 'PROFESSION SKILL BODY',
  'facts/origin': 'ORIGIN SKILL BODY',
  'facts/interest': 'INTEREST SKILL BODY',
  'conversation/question': 'QUESTION SKILL BODY',
  'topics/residence': 'x',
  'topics/profession': 'x',
  'topics/origin': 'x',
  'topics/interest': 'x',
};

const PERSONA: AgentPersona = { surface: 'CONFIG', languageName: 'English', facts: [] };

function harness(script: AgentModelResult[], places: Place[] = [BERLIN]) {
  const calls: { systemPrompt: string; tools: string[]; messages: { role: string; content: string }[] }[] = [];
  const saves: Record<string, unknown>[][] = [];
  let i = 0;
  const deps: AgentDeps = {
    callModel: async (req) => {
      calls.push({
        systemPrompt: req.systemPrompt,
        tools: ((req.tools ?? []) as { function: { name: string } }[]).map((t) => t.function.name),
        messages: req.messages,
      });
      return script[Math.min(i++, script.length - 1)];
    },
    tools: {
      findSimilarFacts: async () => ({ candidates: [] }),
      lookupPlace: async () => ({ status: 'resolved', places }),
      saveExtractedFacts: async (args) => {
        saves.push((args.extracted_user_information as Record<string, unknown>[]) ?? []);
        return { staged: true };
      },
      deleteUserFacts: async () => ({ deleted: [] }),
    },
    loadSkill: (id) => SKILLS[id] ?? null,
    skillIds: () => Object.keys(SKILLS),
  };
  return { deps, calls, saves };
}

const ROUTE_TWO = res({
  content: 'A product manager in Berlin.',
  toolCalls: [tc('load_skill', { id: 'facts/residence' }), tc('load_skill', { id: 'facts/profession' })],
});

describe('the control: one skill per turn is what ships', () => {
  it('ignores a second load_skill on the baseline arm', async () => {
    const h = harness([ROUTE_TWO, res({ toolCalls: [save('Lives in Berlin')] }), res({ content: 'Here it is.' })]);
    const out = await runAgentTurn({ state: createAgentState(PERSONA), userMessage: 'PM in Berlin', deps: h.deps });
    expect(out.skillsLoaded).toEqual(['facts/residence']);
    expect(h.calls.some((c) => c.systemPrompt === 'PROFESSION SKILL BODY')).toBe(false);
    expect(buildRouterPrompt({ surface: 'CONFIG', answerPending: false })).not.toContain('Several subjects');
  });
});

describe('the multi-subject arm', () => {
  it('asks the router for one load_skill per subject', () => {
    expect(buildRouterPrompt({ surface: 'CONFIG', answerPending: false, arm: MULTI_SUBJECT_ARM_ID }))
      .toContain('call `load_skill` once for EACH subject');
  });

  it('runs every subject as its own segment, with its own guideline and topic skill', async () => {
    const h = harness([
      ROUTE_TWO,
      res({ toolCalls: [tc('lookup_place', { query: 'Berlin' }), save('Lives in Berlin, Germany, EU')] }),
      res({ content: 'Berlin it is.' }),
      res({ toolCalls: [save('Product manager')] }),
      res({ content: 'And the job.' }),
    ]);
    const out = await runAgentTurn({
      state: createAgentState(PERSONA),
      userMessage: 'I work as a product manager in Berlin',
      deps: h.deps,
      promptVariant: MULTI_SUBJECT_ARM_ID,
    });
    expect(out.skillsLoaded).toEqual(['facts/residence', 'facts/profession']);
    // The primary route is still what routing accuracy scores.
    expect(out.routeKind).toBe('residence');
    expect(h.saves.flat().map((e) => [e.statement, e.topic_skill_id])).toEqual([
      ['Lives in Berlin, Germany, EU', 'topics/residence'],
      ['Product manager', 'topics/profession'],
    ]);
    // The second segment never reads the first one's lookups.
    const profLeg = h.calls.find((c) => c.systemPrompt === 'PROFESSION SKILL BODY');
    expect(profLeg?.messages.some((m) => m.content.startsWith('lookup_place'))).toBe(false);
    expect(profLeg?.messages[0].content).toContain('You handle only the profession part');
    expect(out.reply).toBe('Berlin it is. And the job.');
  });

  it('a question in one segment does not stop the next, and only one question is asked', async () => {
    const state = createAgentState(PERSONA);
    const h = harness(
      [
        ROUTE_TWO,
        res({ toolCalls: [tc('lookup_place', { query: 'Berlin' })] }),
        res({ content: 'Which Berlin?', toolCalls: [tc('ask_choice', { question: 'Which Berlin?', options: ['Berlin, Germany', 'Berlin, USA'] })] }),
        res({ toolCalls: [save('Product manager')] }),
        res({ content: 'Got the job.' }),
      ],
      [BERLIN, BERLIN_NH],
    );
    const out = await runAgentTurn({ state, userMessage: 'PM in Berlin', deps: h.deps, promptVariant: MULTI_SUBJECT_ARM_ID });

    const profLegs = h.calls.filter((c) => c.systemPrompt === 'PROFESSION SKILL BODY');
    expect(profLegs.length).toBeGreaterThan(0);
    expect(profLegs.every((c) => !c.tools.includes('ask_choice'))).toBe(true);
    expect(profLegs[0].messages[0].content).toContain('A question about another part is already waiting');
    expect(out.terminalReason).toBe('awaiting-user');
    // The chip tap must resume the skill that asked, not the last one run.
    expect(state.turn.lastSkill).toBe('facts/residence');
    // The bubble ends on the question the chips answer.
    expect(out.reply).toBe('Got the job. Which Berlin?');
    expect(h.saves.flat().map((e) => e.statement)).toEqual(['Product manager']);
  });

  it('caps a turn at three subjects', async () => {
    const h = harness([
      res({
        content: 'Lots there.',
        toolCalls: ['facts/residence', 'facts/profession', 'facts/origin', 'facts/interest'].map((id) => tc('load_skill', { id })),
      }),
      res({ content: 'ok' }),
    ]);
    const out = await runAgentTurn({ state: createAgentState(PERSONA), userMessage: 'x', deps: h.deps, promptVariant: MULTI_SUBJECT_ARM_ID });
    expect(out.skillsLoaded).toEqual(['facts/residence', 'facts/profession', 'facts/origin']);
  });
});
