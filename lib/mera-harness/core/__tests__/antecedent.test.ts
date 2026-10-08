// "Yes follow it" after a news answer (owner report, navx2-fu). The loop sends
// no chat history, so turn 2 reached the model as the bare reply plus the
// trailing question "...any particular thread of this?", with no subject. The
// forced offer then made the model save one anyway, and it guessed Israel.
// Driven through the real loop, two turns on ONE state, with a scripted model.

import { createAgentState, runAgentTurn, type AgentPersona } from '../core';
import { CANONICAL_LOCATION_KEY, ORIGIN_KEY } from '../combined-fact';
import type { AgentDeps, AgentModelRequest, AgentModelResult } from '../types';

function res(over: Partial<AgentModelResult> = {}): AgentModelResult {
  return {
    content: '', toolCalls: [], finishReason: 'stop', truncated: false,
    usage: null, modelSent: 'fake', latencyMs: 1, error: null, ...over,
  };
}
const tc = (name: string, args: unknown) => ({ name, argumentsRaw: JSON.stringify(args) });

const SKILLS: Record<string, string> = {
  'facts/interest': 'INTEREST SKILL BODY',
  'facts/origin': 'ORIGIN SKILL BODY',
  'conversation/question': 'QUESTION SKILL BODY',
};

const PERSONA: AgentPersona = {
  surface: 'CONFIG',
  languageName: 'English',
  facts: [{ id: 'home', statement: 'Lives in Nieuw-West, Amsterdam, North Holland, Netherlands, Europe' }],
};

const TURN_1_REPLY =
  'Talks on a ceasefire are stalled and fighting continues in the east. '
  + 'Would you like to keep an eye on any particular thread of this?';

function harness(script: AgentModelResult[]) {
  const requests: AgentModelRequest[] = [];
  const saves: Record<string, unknown>[][] = [];
  let i = 0;
  const deps: AgentDeps = {
    callModel: async (req) => {
      requests.push(req);
      return script[Math.min(i++, script.length - 1)];
    },
    tools: {
      findSimilarFacts: async () => ({ candidates: [] }),
      lookupPlace: async ({ query }) => ({ status: 'no_match', query }),
      saveExtractedFacts: async (args) => {
        const list = (args.extracted_user_information as Record<string, unknown>[]) ?? [];
        saves.push(list);
        return { staged: true, accepted: list.map((e) => e.statement) };
      },
      deleteUserFacts: async () => ({ deleted: [] }),
    },
    loadSkill: (id) => SKILLS[id] ?? null,
    skillIds: () => Object.keys(SKILLS),
  };
  return { deps, requests, saves };
}

const sent = (req: AgentModelRequest) => req.messages.map((m) => m.content).join('\n');

/** Turn 1, "What's going on in Ukraine", answered on conversation/question. */
async function askAboutUkraine(state: ReturnType<typeof createAgentState>) {
  const h = harness([
    res({ content: 'Ukraine, one moment.', toolCalls: [tc('load_skill', { id: 'conversation/question' })] }),
    res({ content: TURN_1_REPLY }),
  ]);
  await runAgentTurn({ state, userMessage: 'What’s going on in Ukraine', deps: h.deps });
  return h;
}

describe('a reply to a question keeps its antecedent', () => {
  it('turn 2 carries the previous user message, so "it" can be resolved', async () => {
    const state = createAgentState(PERSONA);
    await askAboutUkraine(state);
    const h = harness([
      res({ content: 'On it.', toolCalls: [tc('load_skill', { id: 'facts/interest' })] }),
      res({
        content: 'Noted.',
        toolCalls: [tc('saveExtractedFacts', {
          extracted_user_information: [{ statement: 'Follows the war in Ukraine' }],
        })],
      }),
    ]);
    await runAgentTurn({ state, userMessage: 'Yes follow it', deps: h.deps });
    // EVERY leg of the answering turn, the route leg included, names the subject.
    for (const req of h.requests) expect(sent(req)).toContain('Ukraine');
  });

  it('a typed answer is not announced to the router as "did NOT answer"', async () => {
    const state = createAgentState(PERSONA);
    await askAboutUkraine(state);
    const h = harness([res({ content: 'Sure.', toolCalls: [tc('load_skill', { id: 'facts/interest' })] })]);
    await runAgentTurn({ state, userMessage: 'Yes follow it', deps: h.deps });
    expect(h.requests[0].systemPrompt).not.toContain('They did NOT answer your last question');
  });
});

describe('the forced offer never invents its subject', () => {
  async function forcedAfterClarifyingQuestion(forcedStatement: string, promptVariant?: string) {
    const state = createAgentState(PERSONA);
    await askAboutUkraine(state);
    const h = harness([
      res({ content: 'Got it.', toolCalls: [tc('load_skill', { id: 'facts/interest' })] }),
      // The reply leg asks which thread, offering nothing: the forced leg runs.
      res({ content: 'Which one are you following, in a few words?' }),
      res({
        toolCalls: [tc('saveExtractedFacts', {
          extracted_user_information: [{ statement: forcedStatement }],
        })],
      }),
      res({ content: 'Which one are you following, in a few words?' }),
    ]);
    const out = await runAgentTurn({ state, userMessage: 'Yes follow it', deps: h.deps, promptVariant });
    return { out, h };
  }

  it('DEVICE CASE: a forced fact naming nothing the user or Mera said is dropped', async () => {
    const { out, h } = await forcedAfterClarifyingQuestion(
      'Follows the current geopolitical conflict in the region of Israel',
    );
    expect(out.forcedProposal).toBe(true);
    // Asserted on what the TOOL was handed: that list is what builds the cards.
    expect(h.saves.flat().map((e) => String(e.statement))).not.toContainEqual(
      expect.stringMatching(/Israel/),
    );
    expect(out.proposals).toEqual([]);
  });

  it('a forced fact grounded in the previous message is kept', async () => {
    const { out } = await forcedAfterClarifyingQuestion('Follows the war in Ukraine');
    expect(out.proposals.map((p) => p.statement)).toEqual(['Follows the war in Ukraine']);
  });

  it('the control arm keeps the ungrounded entry, so the arm reaches the loop', async () => {
    const { out } = await forcedAfterClarifyingQuestion(
      'Follows the current geopolitical conflict in the region of Israel',
      'forced-offer-ungrounded',
    );
    expect(out.proposals.map((p) => p.statement)).toEqual([
      'Follows the current geopolitical conflict in the region of Israel',
    ]);
  });

  it('a card the LOOP adds on a forced leg survives: its country comes from a fact on file', async () => {
    const state = createAgentState({
      ...PERSONA,
      facts: [{
        id: 'home',
        statement: 'Lives in Nieuw-West, Amsterdam, North Holland, Netherlands, EU',
        attribute: CANONICAL_LOCATION_KEY,
      }],
    });
    const h = harness([
      res({ content: 'India, got it.', toolCalls: [tc('load_skill', { id: 'facts/origin' })] }),
      res({ content: 'Nice.' }),
      res({
        toolCalls: [tc('saveExtractedFacts', {
          extracted_user_information: [{ statement: 'From India', questionnaire_attribute: ORIGIN_KEY }],
        })],
      }),
      res({ content: 'Two cards for you.' }),
    ]);
    const out = await runAgentTurn({ state, userMessage: "I'm originally from India", deps: h.deps });
    expect(out.forcedProposal).toBe(true);
    expect(h.saves.flat().map((e) => String(e.statement))).toEqual(['From India', 'Expat in Netherlands']);
  });

  it('a number counts as said: "Age: 34" from "I\'m 34" is kept (staging corpus case)', async () => {
    const h = harness([
      res({ content: 'Got it.', toolCalls: [tc('load_skill', { id: 'facts/interest' })] }),
      res({ content: 'Nice.' }),
      res({ toolCalls: [tc('saveExtractedFacts', { extracted_user_information: [{ statement: 'Age: 34' }] })] }),
      res({ content: 'One card for you.' }),
    ]);
    const out = await runAgentTurn({ state: createAgentState(PERSONA), userMessage: "I'm 34", deps: h.deps });
    expect(out.forcedProposal).toBe(true);
    expect(h.saves.flat().map((e) => String(e.statement))).toEqual(['Age: 34']);
  });
});
