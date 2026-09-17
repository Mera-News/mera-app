import {
  MAX_AGENT_LEGS,
  bindChoicePayloads,
  createAgentState,
  reconcilePlaceChain,
  runAgentTurn,
  type AgentPersona,
} from '../core';
import type { AgentDeps, AgentModelResult, Place } from '../types';

const AMS: Place = {
  neighbourhood: undefined,
  locality: 'Amsterdam',
  admin1: 'North Holland',
  countryCode: 'NL',
  countryName: 'Netherlands',
  bloc: 'EU',
};
const ALK: Place = { ...AMS, locality: 'Alkmaar' };

function modelResult(over: Partial<AgentModelResult> = {}): AgentModelResult {
  return {
    content: '',
    toolCalls: [],
    finishReason: 'stop',
    truncated: false,
    usage: null,
    modelSent: 'fake',
    latencyMs: 1,
    error: null,
    ...over,
  };
}

const PERSONA: AgentPersona = {
  surface: 'CONFIG',
  languageName: 'English',
  facts: [{ id: 'f1', statement: 'Lives in Amsterdam', attribute: 'location: residence' }],
};

/** Scripts one AgentModelResult per leg, in order. */
function scriptedDeps(
  script: AgentModelResult[],
  toolOver: Partial<AgentDeps['tools']> = {},
): {
  deps: AgentDeps;
  calls: {
    systemPrompt: string;
    tools: unknown[];
    toolChoice?: string;
    messages: { role: string; content: string }[];
  }[];
} {
  const calls: {
    systemPrompt: string;
    tools: unknown[];
    toolChoice?: string;
    messages: { role: string; content: string }[];
  }[] = [];
  let i = 0;
  const deps: AgentDeps = {
    callModel: async (req) => {
      calls.push({
        systemPrompt: req.systemPrompt,
        tools: (req.tools ?? []) as unknown[],
        toolChoice: req.toolChoice,
        messages: req.messages,
      });
      return script[Math.min(i++, script.length - 1)];
    },
    tools: {
      findSimilarFacts: async () => ({ candidates: [] }),
      lookupPlace: async () => ({ status: 'resolved', places: [AMS] }),
      saveExtractedFacts: async () => ({ staged: true }),
      deleteUserFacts: async () => ({ deleted: [] }),
      ...toolOver,
    },
    loadSkill: (id) => (id === 'facts/residence' ? 'RESIDENCE SKILL BODY' : null),
    skillIds: () => ['facts/residence'],
  };
  return { deps, calls };
}

const tc = (name: string, args: unknown) => ({ name, argumentsRaw: JSON.stringify(args) });

describe('the bounded loop', () => {
  it('a text-only turn is exactly ONE leg', async () => {
    const { deps } = scriptedDeps([modelResult({ content: 'Hello there.' })]);
    const out = await runAgentTurn({ state: createAgentState(PERSONA), userMessage: 'hi', deps });
    expect(out.legs).toHaveLength(1);
    expect(out.reply).toBe('Hello there.');
    expect(out.legBudgetHit).toBe(false);
  });

  it('a preamble PLUS load_skill continues; it does not settle on leg 1', async () => {
    // The whole acknowledgement design rests on this ordering: a leg with text
    // AND a forcing call must continue, or every fact turn becomes one leg with
    // no skill loaded.
    const { deps, calls } = scriptedDeps([
      modelResult({ content: 'Nieuw-West, let me note that.', toolCalls: [tc('load_skill', { id: 'facts/residence' })] }),
      modelResult({
        content: 'Saved that one.',
        toolCalls: [tc('saveExtractedFacts', {
          extracted_user_information: [{ statement: 'Lives in Alkmaar' }],
        })],
      }),
    ]);
    const out = await runAgentTurn({ state: createAgentState(PERSONA), userMessage: 'I moved', deps });
    expect(out.legs).toHaveLength(2);
    expect(out.forcedProposal).toBe(false);
    expect(out.skillLoaded).toBe('facts/residence');
    expect(out.routeKind).toBe('residence');
    // The loaded body becomes the NEXT leg's system prompt.
    expect(calls[0].systemPrompt).toContain('You are Mera');
    expect(calls[1].systemPrompt).toBe('RESIDENCE SKILL BODY');
  });

  it('CLAMPS at the leg bound on DISTINCT forcing calls, and never throws', async () => {
    // Distinct arguments, because an identical repeat no longer buys a leg.
    const { deps } = scriptedDeps([
      modelResult({ content: 'a', toolCalls: [tc('load_skill', { id: 'facts/residence' })] }),
      modelResult({ content: 'b', toolCalls: [tc('lookup_place', { query: 'Alkmaar' })] }),
      modelResult({ content: 'c', toolCalls: [tc('lookup_place', { query: 'Hoorn' })] }),
      modelResult({ content: 'd', toolCalls: [tc('lookup_place', { query: 'Utrecht' })] }),
    ]);
    const out = await runAgentTurn({ state: createAgentState(PERSONA), userMessage: 'hi', deps });
    expect(out.legs).toHaveLength(MAX_AGENT_LEGS);
    expect(out.legBudgetHit).toBe(true);
    expect(out.legCapped).toBe(true);
    expect(out.terminalReason).toBe('leg-cap');
  });

  it('a REPEATED load_skill of the ALREADY-LOADED skill settles instead of spinning', async () => {
    // The device failure, exactly: "I enjoy playing chess" produced four legs
    // of ~1s, messageCount 4,5,6,7, reason leg-cap, and one sentence of prose.
    // The model re-loaded facts/generic every leg; each call forced a
    // continuation, so the prose-settles rule was never reached.
    const { deps, calls } = scriptedDeps([
      modelResult({
        content: 'Nice hobby, chess!',
        toolCalls: [tc('load_skill', { id: 'facts/residence' })],
      }),
      // The model calls it AGAIN even though the tool has left the payload:
      // an undeclared call is still something a model emits.
      modelResult({
        content: 'Nice hobby, chess!',
        toolCalls: [tc('load_skill', { id: 'facts/residence' })],
      }),
      modelResult({
        content: 'Here it is.',
        toolCalls: [tc('saveExtractedFacts', {
          extracted_user_information: [{ statement: 'Plays chess' }],
        })],
      }),
    ]);
    const out = await runAgentTurn({
      state: createAgentState(PERSONA), userMessage: 'I enjoy playing chess', deps,
    });
    // Leg 1 loads, leg 2 re-requests the same skill without buying a leg and
    // would settle on prose, leg 3 is the FORCED proposal.
    expect(calls.length).toBeLessThanOrEqual(3);
    expect(out.legBudgetHit).toBe(false);
    expect(out.terminalReason).toBe('settled');
    expect(out.legs[1].toolResults[0].result).toEqual({
      id: 'facts/residence', alreadyLoaded: true, activeSkill: 'facts/residence',
    });
    expect(out.rerouteAttempts).toBe(1);
  });

  it('WITHHOLDS load_skill from the payload once a skill is loaded', async () => {
    // Stronger than answering the call: a tool the model cannot see is one it
    // cannot spend a leg on. Every capped turn in the 312-turn corpus was a
    // repeated load_skill.
    const { deps, calls } = scriptedDeps([
      modelResult({ content: 'a', toolCalls: [tc('load_skill', { id: 'facts/residence' })] }),
      modelResult({ content: 'b' }),
    ]);
    await runAgentTurn({ state: createAgentState(PERSONA), userMessage: 'hi', deps });
    const names = (t: unknown[]) =>
      (t as { function: { name: string } }[]).map((d) => d.function.name);
    expect(names(calls[0].tools)).toContain('load_skill');
    expect(names(calls[1].tools)).not.toContain('load_skill');
  });

  it('an identical REPEAT of any forcing call does not buy another leg', async () => {
    const { deps } = scriptedDeps([
      modelResult({ content: 'a', toolCalls: [tc('lookup_place', { query: 'Alkmaar' })] }),
      modelResult({ content: 'b', toolCalls: [tc('lookup_place', { query: 'Alkmaar' })] }),
    ]);
    const out = await runAgentTurn({ state: createAgentState(PERSONA), userMessage: 'hi', deps });
    expect(out.legs).toHaveLength(2);
    expect(out.legBudgetHit).toBe(false);
  });

  it('populates legs even when a leg carries a transport error', async () => {
    const { deps } = scriptedDeps([
      modelResult({ content: 'a', toolCalls: [tc('load_skill', { id: 'facts/residence' })] }),
      modelResult({ error: 'network down' }),
    ]);
    const out = await runAgentTurn({ state: createAgentState(PERSONA), userMessage: 'hi', deps });
    expect(out.legs).toHaveLength(2);
    expect(out.legs[1].result.error).toBe('network down');
    // Terminal: no further hedged legs.
    expect(out.legBudgetHit).toBe(false);
  });

  it('RETHROWS what it did not produce: a throwing callModel aborts the turn', async () => {
    const deps: AgentDeps = {
      callModel: async () => { throw new Error('HTTP 402: API key spend limit exceeded'); },
      tools: {
        findSimilarFacts: async () => ({ candidates: [] }),
        lookupPlace: async () => ({ status: 'unavailable' }),
        saveExtractedFacts: async () => ({}),
        deleteUserFacts: async () => ({}),
      },
      loadSkill: () => null,
      skillIds: () => [],
    };
    await expect(
      runAgentTurn({ state: createAgentState(PERSONA), userMessage: 'hi', deps }),
    ).rejects.toThrow('402');
  });

  it('routeKind stays NULL when no skill resolved, never defaulted', async () => {
    const { deps } = scriptedDeps([
      modelResult({ content: 'x', toolCalls: [tc('load_skill', { id: 'facts/nope' })] }),
      modelResult({ content: 'done' }),
    ]);
    const out = await runAgentTurn({ state: createAgentState(PERSONA), userMessage: 'hi', deps });
    expect(out.routeKind).toBeNull();
    expect(out.skillLoaded).toBeNull();
  });

  it('records the MATERIALISED system prompt and per-leg input tokens', async () => {
    const { deps } = scriptedDeps([modelResult({ content: 'hi' })]);
    const out = await runAgentTurn({ state: createAgentState(PERSONA), userMessage: 'hi', deps });
    expect(out.legs[0].systemPrompt.length).toBeGreaterThan(100);
    expect(out.legs[0].inputTokens).toBeGreaterThan(0);
  });

  it('a malformed tool call is neither executed nor forcing', async () => {
    const { deps } = scriptedDeps([
      modelResult({ content: 'text', toolCalls: [{ name: 'load_skill', argumentsRaw: '{"id":' }] }),
    ]);
    const out = await runAgentTurn({ state: createAgentState(PERSONA), userMessage: 'hi', deps });
    // Not forcing => settles on leg 1 rather than burning the cap retrying.
    expect(out.legs).toHaveLength(1);
    expect(out.legs[0].toolResults[0].result).toEqual({ error: 'malformed arguments' });
  });
});

describe('ask_choice', () => {
  it('ENDS the turn with no further leg', async () => {
    const { deps, calls } = scriptedDeps([
      modelResult({
        content: 'Which one?',
        toolCalls: [tc('ask_choice', { question: 'Which?', options: ['Amsterdam', 'Alkmaar'] })],
      }),
      modelResult({ content: 'should never run' }),
    ]);
    const state = createAgentState(PERSONA);
    const out = await runAgentTurn({ state, userMessage: 'I moved', deps });
    expect(calls).toHaveLength(1);
    expect(out.legs).toHaveLength(1);
    expect(state.turn.pendingChoice?.options.map((o) => o.text)).toEqual(['Amsterdam', 'Alkmaar']);
  });

  it('a MALFORMED ask_choice is a counted terminal state, not a settled prose question', async () => {
    const { deps } = scriptedDeps([
      modelResult({ content: 'Which?', toolCalls: [tc('ask_choice', { question: 'Which?', options: ['only one'] })] }),
    ]);
    const state = createAgentState(PERSONA);
    const out = await runAgentTurn({ state, userMessage: 'hi', deps });
    expect(out.legs[0].toolResults[0].result).toEqual({ error: 'options must be 2 or 3' });
    expect(state.turn.pendingChoice).toBeNull();
  });

  it('a tap answered on the NEXT turn resolves without a second lookup', async () => {
    const lookupPlace = jest.fn(async () => ({ status: 'resolved' as const, places: [AMS, ALK] }));
    const first = scriptedDeps(
      [
        modelResult({
          content: 'Which?',
          toolCalls: [
            tc('lookup_place', { query: 'Nieuw-West' }),
            tc('ask_choice', { question: 'Which?', options: ['Amsterdam', 'Alkmaar'] }),
          ],
        }),
      ],
      { lookupPlace },
    );
    const state = createAgentState(PERSONA);
    await runAgentTurn({ state, userMessage: 'I moved to Nieuw-West', deps: first.deps });
    expect(lookupPlace).toHaveBeenCalledTimes(1);
    // The chip carries the structured Place, not just its label.
    expect(state.turn.pendingChoice?.options[0].payload).toEqual(AMS);

    const second = scriptedDeps([modelResult({ content: 'Got it.' })], { lookupPlace });
    await runAgentTurn({ state, userMessage: 'Amsterdam', deps: second.deps });
    expect(lookupPlace).toHaveBeenCalledTimes(1); // still ONE: no re-lookup
    expect(state.turn.resolvedChoice?.payload).toEqual(AMS);
    expect(state.turn.pendingChoice).toBeNull();
  });
});

describe('destructive and place guards', () => {
  it('deleteUserFacts is REFUSED without a confirmed choice', async () => {
    const deleteUserFacts = jest.fn(async () => ({ deleted: ['f1'] }));
    const { deps } = scriptedDeps(
      [modelResult({ content: 'ok', toolCalls: [tc('deleteUserFacts', { fact_ids: ['f1'] })] })],
      { deleteUserFacts },
    );
    const out = await runAgentTurn({ state: createAgentState(PERSONA), userMessage: 'drop it', deps });
    expect(deleteUserFacts).not.toHaveBeenCalled();
    expect(out.legs[0].toolResults[0].result).toEqual({ error: 'confirm with ask_choice first' });
  });

  it('`replaces` is dropped unless a choice was actually confirmed', async () => {
    const { deps } = scriptedDeps([
      modelResult({
        content: 'ok',
        toolCalls: [tc('saveExtractedFacts', {
          extracted_user_information: [{ statement: 'Lives in Berlin', replaces: 'f1' }],
        })],
      }),
    ]);
    const out = await runAgentTurn({ state: createAgentState(PERSONA), userMessage: 'I moved to Berlin', deps });
    expect(out.proposals[0].replaces).toBeNull();
  });

  it('turnActive toggles exactly once and ends false', async () => {
    const seen: boolean[] = [];
    const state = createAgentState(PERSONA);
    const deps: AgentDeps = {
      callModel: async () => { seen.push(state.turn.turnActive); return modelResult({ content: 'hi' }); },
      tools: {
        findSimilarFacts: async () => ({ candidates: [] }),
        lookupPlace: async () => ({ status: 'unavailable' }),
        saveExtractedFacts: async () => ({}),
        deleteUserFacts: async () => ({}),
      },
      loadSkill: () => null,
      skillIds: () => [],
    };
    expect(state.turn.turnActive).toBe(false);
    await runAgentTurn({ state, userMessage: 'hi', deps });
    expect(seen).toEqual([true]);          // true for the whole of every leg
    expect(state.turn.turnActive).toBe(false);
  });
});

describe('place reconciliation', () => {
  it('keeps a neighbourhood the user actually said', () => {
    const out = reconcilePlaceChain(
      { locality: 'Amsterdam', neighbourhood: 'Nieuw-West' },
      [AMS],
      'I moved to Nieuw-West last month',
    );
    expect(out?.neighbourhood).toBe('Nieuw-West');
    expect(out?.bloc).toBe('EU');
  });

  it('DROPS an invented neighbourhood but keeps the rest of the chain', () => {
    const out = reconcilePlaceChain(
      { locality: 'Amsterdam', neighbourhood: 'Jordaan' },
      [AMS],
      'I moved to Amsterdam last month',
    );
    expect(out?.neighbourhood).toBeUndefined();
    expect(out?.locality).toBe('Amsterdam');
  });

  it('ignores a bloc the model supplies and uses the resolved candidate', () => {
    const out = reconcilePlaceChain(
      { locality: 'Amsterdam', bloc: 'Asia', countryName: 'Narnia' },
      [AMS],
      'Amsterdam',
    );
    expect(out?.bloc).toBe('EU');
    expect(out?.countryName).toBe('Netherlands');
  });

  it('returns null when nothing was resolved', () => {
    expect(reconcilePlaceChain({ locality: 'Nowhere' }, [], 'x')).toBeNull();
  });
});

describe('bindChoicePayloads', () => {
  it('matches by CONTENT, so a reordered option keeps its own payload', () => {
    const bound = bindChoicePayloads(['Alkmaar', 'Amsterdam'], [AMS, ALK]);
    expect(bound[0].payload).toEqual(ALK);
    expect(bound[1].payload).toEqual(AMS);
  });

  it('gives an unmatched option a null payload rather than a wrong one', () => {
    const bound = bindChoicePayloads(['Neither of those'], [AMS]);
    expect(bound[0].payload).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// A facts/* turn owes a PROPOSAL. Prose is not one. (pagent P1)
//
// Both device failures at 51750c7 were this: "I enjoy playing chess" loaded
// facts/interest then produced two prose legs and NO card, and the residence
// turn asked four prose questions and "confirmed" a stale Rotterdam fact.
// ---------------------------------------------------------------------------
describe('the forced proposal leg', () => {
  const FACTS_DEPS = (script: AgentModelResult[]) =>
    scriptedDeps(script).deps;

  it('DEVICE CASE 1 (chess): prose after a fact skill forces one proposal leg', async () => {
    const { deps, calls } = scriptedDeps([
      modelResult({ content: 'ok', toolCalls: [tc('load_skill', { id: 'facts/residence' })] }),
      modelResult({ content: 'Let me pull up the right steps.' }),
      modelResult({
        content: 'Here is what I have.',
        toolCalls: [tc('saveExtractedFacts', {
          extracted_user_information: [{ statement: 'Plays chess' }],
        })],
      }),
    ]);
    const out = await runAgentTurn({
      state: createAgentState(PERSONA), userMessage: 'I enjoy playing chess', deps,
    });
    expect(out.forcedProposal).toBe(true);
    expect(out.proposals.map((p) => p.statement)).toEqual(['Plays chess']);
    expect(out.terminalReason).toBe('settled');
    // The forced leg is REQUIRED and carries only the two tools that answer
    // "propose something now".
    const forced = calls[calls.length - 1];
    expect(forced.toolChoice).toBe('required');
    const names = (forced.tools as { function: { name: string } }[]).map((t) => t.function.name);
    expect(names.sort()).toEqual(['ask_choice', 'saveExtractedFacts']);
  });

  it('the forced leg is told plainly that nothing has been proposed', async () => {
    const { deps, calls } = scriptedDeps([
      modelResult({ content: 'ok', toolCalls: [tc('load_skill', { id: 'facts/residence' })] }),
      modelResult({ content: 'thinking out loud' }),
      modelResult({ content: 'done', toolCalls: [tc('saveExtractedFacts', {
        extracted_user_information: [{ statement: 'Plays chess' }] })] }),
    ]);
    await runAgentTurn({ state: createAgentState(PERSONA), userMessage: 'chess', deps });
    const forcedMsgs = calls[calls.length - 1].messages.map((m) => m.content).join('\n');
    expect(forcedMsgs).toContain('You have not proposed anything yet');
  });

  it('ask_choice ALSO discharges the debt, so a genuine question is not forced', async () => {
    const { deps } = scriptedDeps([
      modelResult({ content: 'ok', toolCalls: [tc('load_skill', { id: 'facts/residence' })] }),
      modelResult({
        content: 'Which one?',
        toolCalls: [tc('ask_choice', { question: 'Which?', options: ['A', 'B'] })],
      }),
    ]);
    const out = await runAgentTurn({ state: createAgentState(PERSONA), userMessage: 'x', deps });
    expect(out.forcedProposal).toBe(false);
    expect(out.terminalReason).toBe('awaiting-user');
  });

  it('a forced leg that STILL proposes nothing ends as no-proposal', async () => {
    const deps = FACTS_DEPS([
      modelResult({ content: 'ok', toolCalls: [tc('load_skill', { id: 'facts/residence' })] }),
      modelResult({ content: 'still just talking' }),
      modelResult({ content: 'still just talking' }),
    ]);
    const out = await runAgentTurn({ state: createAgentState(PERSONA), userMessage: 'x', deps });
    expect(out.forcedProposal).toBe(true);
    expect(out.terminalReason).toBe('no-proposal');
  });

  it('a conversation/* turn owes NOTHING and settles on prose', async () => {
    const { deps } = scriptedDeps([
      modelResult({ content: 'ok', toolCalls: [tc('load_skill', { id: 'conversation/question' })] }),
      modelResult({ content: 'Mera keeps your topics on the device.' }),
    ]);
    const out = await runAgentTurn({ state: createAgentState(PERSONA), userMessage: 'how?', deps });
    expect(out.forcedProposal).toBe(false);
    expect(out.terminalReason).toBe('settled');
  });
});

describe('existing facts are labelled, and re-proposals rejected', () => {
  it('DEVICE CASE 2: a proposal equal to an EXISTING candidate is dropped', async () => {
    const { deps } = scriptedDeps(
      [
        modelResult({ content: 'ok', toolCalls: [tc('load_skill', { id: 'facts/residence' })] }),
        modelResult({ content: 'ok', toolCalls: [tc('find_similar_facts', { kind: 'residence' })] }),
        modelResult({
          content: 'Confirming.',
          toolCalls: [tc('saveExtractedFacts', {
            // The model echoing back what it was just shown. On device this
            // read as "confirming" a Rotterdam fact replaced two turns ago.
            extracted_user_information: [{ statement: 'Lives in Rotterdam' }],
          })],
        }),
      ],
      {
        findSimilarFacts: async () => ({
          candidates: [{ factId: 'f9', statement: 'Lives in Rotterdam', attribute: null, overlap: 1 }],
        }),
      },
    );
    const out = await runAgentTurn({ state: createAgentState(PERSONA), userMessage: 'x', deps });
    // At least one, and NOTHING proposed. The forced leg then fires precisely
    // because nothing was proposed, and a model that echoes the same stale
    // statement again is rejected again -- which is the behaviour we want.
    expect(out.reProposals).toBeGreaterThanOrEqual(1);
    expect(out.proposals).toEqual([]);
    expect(out.terminalReason).toBe('no-proposal');
  });

  it('labels the candidates as EXISTING in the next leg state line', async () => {
    const { deps, calls } = scriptedDeps(
      [
        modelResult({ content: 'ok', toolCalls: [tc('find_similar_facts', { kind: 'residence' })] }),
        modelResult({ content: 'done' }),
      ],
      {
        findSimilarFacts: async () => ({
          candidates: [{ factId: 'f9', statement: 'Lives in Rotterdam', attribute: null, overlap: 1 }],
        }),
      },
    );
    await runAgentTurn({ state: createAgentState(PERSONA), userMessage: 'x', deps });
    const seen = calls[1].messages.map((m) => m.content).join('\n');
    expect(seen).toContain('EXISTING facts already on file, never re-propose these');
    expect(seen).toContain('[f9]');
    expect(seen).toContain('set replaces to the matching id');
  });

  it('a genuinely NEW statement still proposes', async () => {
    const { deps } = scriptedDeps(
      [
        modelResult({ content: 'ok', toolCalls: [tc('load_skill', { id: 'facts/residence' })] }),
        modelResult({ content: 'ok', toolCalls: [tc('find_similar_facts', { kind: 'residence' })] }),
        modelResult({ content: 'ok', toolCalls: [tc('saveExtractedFacts', {
          extracted_user_information: [{ statement: 'Lives in Nieuw-West, Amsterdam' }] })] }),
      ],
      {
        findSimilarFacts: async () => ({
          candidates: [{ factId: 'f9', statement: 'Lives in Rotterdam', attribute: null, overlap: 1 }],
        }),
      },
    );
    const out = await runAgentTurn({ state: createAgentState(PERSONA), userMessage: 'x', deps });
    expect(out.reProposals).toBe(0);
    expect(out.proposals.map((p) => p.statement)).toEqual(['Lives in Nieuw-West, Amsterdam']);
  });
});

// ---------------------------------------------------------------------------
// THE PAYLOAD. saveExtractedFacts was never offered on any leg, which is why
// 480 fact turns produced ONE save and the model invented add_fact /
// save_fact / update_fact -- it could see the need and not the tool.
// ---------------------------------------------------------------------------
describe('per-leg tool payload', () => {
  const names = (t: unknown[]) =>
    (t as { function: { name: string } }[]).map((d) => d.function.name).sort();

  it('the ROUTER leg offers the four discovery tools and NO writer', async () => {
    const { deps, calls } = scriptedDeps([modelResult({ content: 'hi' })]);
    await runAgentTurn({ state: createAgentState(PERSONA), userMessage: 'hi', deps });
    expect(names(calls[0].tools)).toEqual([
      'ask_choice', 'find_similar_facts', 'load_skill', 'lookup_place',
    ]);
    expect(names(calls[0].tools)).not.toContain('saveExtractedFacts');
  });

  it('a FACTS leg offers saveExtractedFacts and deleteUserFacts', async () => {
    const { deps, calls } = scriptedDeps([
      modelResult({ content: 'ok', toolCalls: [tc('load_skill', { id: 'facts/residence' })] }),
      modelResult({ content: 'ok', toolCalls: [tc('saveExtractedFacts', {
        extracted_user_information: [{ statement: 'Plays chess' }] })] }),
    ]);
    await runAgentTurn({ state: createAgentState(PERSONA), userMessage: 'x', deps });
    const leg2 = names(calls[1].tools);
    expect(leg2).toContain('saveExtractedFacts');
    expect(leg2).toContain('deleteUserFacts');
    // load_skill is gone once a skill is loaded.
    expect(leg2).not.toContain('load_skill');
  });

  it('a CONVERSATION leg offers no writer: there is nothing to save', async () => {
    const { deps, calls } = scriptedDeps([
      modelResult({ content: 'ok', toolCalls: [tc('load_skill', { id: 'conversation/question' })] }),
      modelResult({ content: 'answer' }),
    ]);
    await runAgentTurn({ state: createAgentState(PERSONA), userMessage: 'how?', deps });
    expect(names(calls[1].tools)).not.toContain('saveExtractedFacts');
  });
});
