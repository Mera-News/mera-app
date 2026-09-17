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
): { deps: AgentDeps; calls: { systemPrompt: string }[] } {
  const calls: { systemPrompt: string }[] = [];
  let i = 0;
  const deps: AgentDeps = {
    callModel: async (req) => {
      calls.push({ systemPrompt: req.systemPrompt });
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
      modelResult({ content: 'Saved that one.' }),
    ]);
    const out = await runAgentTurn({ state: createAgentState(PERSONA), userMessage: 'I moved', deps });
    expect(out.legs).toHaveLength(2);
    expect(out.skillLoaded).toBe('facts/residence');
    expect(out.routeKind).toBe('residence');
    // The loaded body becomes the NEXT leg's system prompt.
    expect(calls[0].systemPrompt).toContain('You are Mera');
    expect(calls[1].systemPrompt).toBe('RESIDENCE SKILL BODY');
  });

  it('CLAMPS at the leg bound, sets legBudgetHit, and never throws', async () => {
    const { deps } = scriptedDeps([
      modelResult({ content: 'x', toolCalls: [tc('load_skill', { id: 'facts/residence' })] }),
    ]);
    const out = await runAgentTurn({ state: createAgentState(PERSONA), userMessage: 'hi', deps });
    expect(out.legs).toHaveLength(MAX_AGENT_LEGS);
    expect(out.legBudgetHit).toBe(true);
    expect(out.legCapped).toBe(true);
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
