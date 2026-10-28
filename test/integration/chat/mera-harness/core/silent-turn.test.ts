// No skill turn ends silent (chatfix D9/A2). The owner's "it understands, shows the tool calls and
// just stops": an acknowledgement, a few tool rows, then no reply, no card and no ending sentence.
// Each case below is a staging row replayed leg for leg through the real loop.
import {
  REPLY_NO_ANSWER_FALLBACK,
  createAgentState,
  runAgentTurn,
  type AgentPersona,
} from '@/lib/mera-harness/core/core';
import type { AgentDeps, AgentModelRequest, AgentModelResult } from '@/lib/mera-harness/core/types';

function res(over: Partial<AgentModelResult> = {}): AgentModelResult {
  return {
    content: '', toolCalls: [], finishReason: 'stop', truncated: false,
    usage: null, modelSent: 'fake', latencyMs: 1, error: null, ...over,
  };
}
const tc = (name: string, args: unknown = {}) => ({ name, argumentsRaw: JSON.stringify(args) });
const SKILLS: Record<string, string> = {
  'facts/interest': 'INTEREST BODY',
  'facts/residence': 'RESIDENCE BODY',
  'conversation/question': 'QUESTION BODY',
};
const PERSONA: AgentPersona = { surface: 'CONFIG', languageName: 'English', facts: [] };

/** `closing` answers the closing leg; the script's last entry repeats until then. */
function harness(script: AgentModelResult[], closing: AgentModelResult, tools: Partial<AgentDeps['tools']> = {}) {
  const requests: AgentModelRequest[] = [];
  let i = 0;
  const deps: AgentDeps = {
    callModel: async (req) => {
      requests.push(req);
      if (/Nothing was offered, saved or changed/.test(req.messages[req.messages.length - 1]?.content ?? '')) return closing;
      return script[Math.min(i++, script.length - 1)];
    },
    tools: {
      findSimilarFacts: async () => ({ candidates: [] }),
      lookupPlace: async () => ({ status: 'no_match', query: '' }) as never,
      saveExtractedFacts: async (a) => ({ staged: true, pendingFacts: a.extracted_user_information }),
      deleteUserFacts: async () => ({ deleted: [] }),
      webSearch: async () => ({ searched: true, results: [] }),
      ...tools,
    },
    loadSkill: (id) => SKILLS[id] ?? null,
    skillIds: () => Object.keys(SKILLS),
  };
  return { deps, requests };
}
const silent = res();
const lastRequest = (r: AgentModelRequest[]) => r[r.length - 1];
const noteOf = (req: AgentModelRequest) => req.messages[req.messages.length - 1]?.content ?? '';

/** real-expat-india t2 r0 (run 20261027-200933-stops-corpus-baseline). */
const BOLLYWOOD = [
  res({ content: 'Got it, keep Bollywood out of your news.', toolCalls: [tc('load_skill', { id: 'facts/interest' })] }),
  res({ toolCalls: [tc('find_similar_facts', { kind: 'generic' })] }),
  res({ toolCalls: [tc('saveExtractedFacts', { extracted_user_information: [] })] }),
  res({ toolCalls: [tc('saveExtractedFacts', { extracted_user_information: [{ statement: 'Does not want topics about Bollywood', questionnaire_attribute: 'topics: general interests' }] })] }),
];

describe('a skill turn that would end silent gets one tool-free closing leg', () => {
  it('the replayed see-less row ends on the closing sentence, not on the acknowledgement', async () => {
    const h = harness(BOLLYWOOD, res({ content: 'I did not change anything for Bollywood here.' }));
    const out = await runAgentTurn({ state: createAgentState(PERSONA), userMessage: 'Do not show me anything about Bollywood', deps: h.deps });

    expect(out.reply).toBe('I did not change anything for Bollywood here.');
    expect(out.closingLegFired).toBe(true);
    expect(out.noAnswerFallbackUsed).toBe(false);
    const closing = lastRequest(h.requests);
    expect(closing.tools).toEqual([]);
    expect(closing.systemPrompt).toContain('INTEREST BODY');
    expect(noteOf(closing)).toMatch(/nothing was offered, saved or changed/i);
  });

  it('a fact card waiting and "keep me updated on it" with an empty save is not left silent', async () => {
    const h = harness(
      [
        res({ content: 'Got it, you want updates on it.', toolCalls: [tc('load_skill', { id: 'facts/interest' })] }),
        res({ toolCalls: [tc('saveExtractedFacts', { extracted_user_information: [] })] }),
        silent, silent, silent,
      ],
      res({ content: 'Nothing changed yet.' }),
    );
    const state = createAgentState(PERSONA);
    state.pendingCardStatements = ['Works in data protection compliance'];
    const out = await runAgentTurn({ state, userMessage: 'keep me updated on it', deps: h.deps });
    expect(out.reply).toBe('Nothing changed yet.');
  });

  it('an offer the device staged nothing for is not a proposal, so the turn is not left silent', async () => {
    const h = harness(
      [
        res({ content: 'Got it, the DPDP law.', toolCalls: [tc('load_skill', { id: 'facts/interest' })] }),
        res({ toolCalls: [tc('saveExtractedFacts', { extracted_user_information: [{ statement: 'Follows the DPDP law', questionnaire_attribute: 'topics: general interests' }] })] }),
        silent, silent, silent,
      ],
      res({ content: 'I could not add that.' }),
      { saveExtractedFacts: async () => ({ staged: true, pendingFacts: [] }) },
    );
    const out = await runAgentTurn({ state: createAgentState(PERSONA), userMessage: 'I want to follow the DPDP law', deps: h.deps });
    expect(out.reply).toBe('I could not add that.');
    expect(out.stagedSomething).toBe(false);
  });

  it('a silent conversation turn also gets the closing leg before any canned line', async () => {
    const h = harness(
      [res({ content: 'One moment.', toolCalls: [tc('load_skill', { id: 'conversation/question' })] }), silent, silent, silent],
      res({ content: 'Porto Santo is an island near Madeira.' }),
    );
    const out = await runAgentTurn({ state: createAgentState(PERSONA), userMessage: 'what is porto santo', deps: h.deps });
    expect(out.reply).toBe('Porto Santo is an island near Madeira.');
    // The turn answered, so a run out of legs is not a failure the box should announce.
    expect(out.terminalReason).toBe('settled');
  });
});

describe('the canned line is the last resort', () => {
  it('an empty closing leg falls back to the reader-language line', async () => {
    const h = harness(BOLLYWOOD, silent);
    const out = await runAgentTurn({
      state: createAgentState(PERSONA), userMessage: 'Do not show me anything about Bollywood', deps: h.deps,
      fallbacks: { leak: 'L', process: 'P', noAnswer: 'NOANSWER-HI' },
    });
    expect(out.reply).toBe('NOANSWER-HI');
    expect(out.noAnswerFallbackUsed).toBe(true);
  });

  it('a closing sentence that claims a change is replaced and counted', async () => {
    const h = harness(BOLLYWOOD, res({ content: "Done, I've muted Bollywood for you." }));
    const out = await runAgentTurn({ state: createAgentState(PERSONA), userMessage: 'Do not show me anything about Bollywood', deps: h.deps });
    expect(out.reply).toBe(REPLY_NO_ANSWER_FALLBACK);
    expect(out.closingClaim).toBe(true);
  });
});

describe('never on a turn that already shows something', () => {
  it('a staged card needs no sentence', async () => {
    const h = harness(
      [
        res({ content: 'Pune.', toolCalls: [tc('load_skill', { id: 'facts/interest' })] }),
        res({ toolCalls: [tc('saveExtractedFacts', { extracted_user_information: [{ statement: 'Follows cricket', questionnaire_attribute: 'topics: general interests' }] })] }),
        silent, silent,
      ],
      res({ content: 'SHOULD NOT BE ASKED' }),
    );
    const out = await runAgentTurn({ state: createAgentState(PERSONA), userMessage: 'I love cricket', deps: h.deps });
    expect(out.closingLegFired).toBe(false);
    expect(out.reply).toBe('');
  });

  it('a stopped or failed turn is left alone', async () => {
    const h = harness(
      [res({ content: 'One moment.', toolCalls: [tc('load_skill', { id: 'conversation/question' })] }), res({ error: 'stopped' })],
      res({ content: 'SHOULD NOT BE ASKED' }),
    );
    const out = await runAgentTurn({ state: createAgentState(PERSONA), userMessage: 'what is porto santo', deps: h.deps });
    expect(out.terminalReason).toBe('transport-error');
    expect(out.closingLegFired).toBe(false);
    expect(out.reply).toBe('');
  });

  it('a turn that never loaded a skill keeps its own ending', async () => {
    const h = harness([res({ content: 'Hmm.' }), res({ content: 'Hmm.' }), res({ content: 'Hmm.' })], res({ content: 'SHOULD NOT BE ASKED' }));
    const out = await runAgentTurn({ state: createAgentState(PERSONA), userMessage: 'hello', deps: h.deps });
    expect(out.terminalReason).toBe('no-route');
    expect(out.closingLegFired).toBe(false);
  });
});
