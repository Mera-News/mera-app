// e2e — drives runAgentTurn end to end through the three production
// conversations with a SCRIPTED fake model and fake ports. No network, no RN.
//
// This is the test that would have caught every seam bug the unit tests can
// hide: the units each mock the thing next to them, and a contract only breaks
// where two of them meet.

import {
  createAgentState,
  generateTopicsForFact,
  runAgentTurn,
  type AgentDeps,
  type AgentModelResult,
  type AgentPersona,
  type Place,
} from '../..';

const ALKMAAR: Place = {
  locality: 'Alkmaar', admin1: 'North Holland', countryCode: 'NL',
  countryName: 'Netherlands', bloc: 'EU',
};
const AMSTERDAM: Place = { ...ALKMAAR, locality: 'Amsterdam' };

function res(over: Partial<AgentModelResult> = {}): AgentModelResult {
  return {
    content: '', toolCalls: [], finishReason: 'stop', truncated: false,
    usage: null, modelSent: 'fake', latencyMs: 1, error: null, ...over,
  };
}
const call = (name: string, args: unknown) => ({ name, argumentsRaw: JSON.stringify(args) });

const SKILLS: Record<string, string> = {
  'facts/generic': 'GENERIC FACT RULES',
  'facts/residence': 'RESIDENCE FACT RULES',
  'conversation/correction': 'CORRECTION RULES',
  'topics/generic': 'GENERIC TOPIC RULES',
  'topics/residence': 'RESIDENCE TOPIC RULES',
};

interface Recorder {
  deps: AgentDeps;
  saved: Record<string, unknown>[];
  lookups: string[];
  deletes: string[][];
  prompts: string[];
}

function makeDeps(script: AgentModelResult[], places: Place[] = [ALKMAAR]): Recorder {
  const saved: Record<string, unknown>[] = [];
  const lookups: string[] = [];
  const deletes: string[][] = [];
  const prompts: string[] = [];
  let i = 0;
  return {
    saved, lookups, deletes, prompts,
    deps: {
      callModel: async (req) => {
        prompts.push(req.systemPrompt);
        return script[Math.min(i++, script.length - 1)];
      },
      tools: {
        findSimilarFacts: async ({ kind }) => ({
          candidates:
            kind === 'residence'
              ? [{ factId: 'f1', statement: 'Lives in Amsterdam', attribute: 'location: residence', overlap: 0 }]
              : [],
        }),
        lookupPlace: async ({ query }) => {
          lookups.push(query);
          return places.length > 0
            ? { status: 'resolved', places }
            : { status: 'no_match', query };
        },
        saveExtractedFacts: async (args) => { saved.push(args); return { staged: true }; },
        deleteUserFacts: async ({ fact_ids }) => { deletes.push(fact_ids); return { deleted: fact_ids }; },
      },
      loadSkill: (id) => {
        if (!(id in SKILLS)) return null;
        return id.endsWith('/generic') ? SKILLS[id] : `${SKILLS[`${id.split('/')[0]}/generic`]}\n\n${SKILLS[id]}`;
      },
      skillIds: () => Object.keys(SKILLS),
    },
  };
}

const PERSONA: AgentPersona = {
  surface: 'CONFIG',
  languageName: 'English',
  facts: [{ id: 'f1', statement: 'Lives in Amsterdam', attribute: 'location: residence' }],
};

// ---------------------------------------------------------------------------
// Conversation 1 — the headline residence turn, in THREE legs.
// "load + (lookup_place AND find_similar_facts together) + save" is the shape
// the whole cap rests on: if this routinely needed four, the cap would be
// load-bearing for correctness and the design would be wrong.
// ---------------------------------------------------------------------------
describe('conversation 1: a residence move', () => {
  it('routes, resolves the place and the similar fact in ONE leg, then proposes', async () => {
    const r = makeDeps([
      res({ content: 'Alkmaar, let me note that.', toolCalls: [call('load_skill', { id: 'facts/residence' })] }),
      res({
        content: 'Checking what I have.',
        toolCalls: [
          call('lookup_place', { query: 'Alkmaar' }),
          call('find_similar_facts', { kind: 'residence' }),
        ],
      }),
      res({
        content: 'Want me to swap Amsterdam for Alkmaar?',
        toolCalls: [call('saveExtractedFacts', {
          extracted_user_information: [{
            statement: 'Lives in Alkmaar, North Holland, Netherlands, EU',
            questionnaire_attribute: 'location: residence',
            placeChain: { locality: 'Alkmaar' },
          }],
        })],
      }),
    ]);

    const state = createAgentState(PERSONA);
    const out = await runAgentTurn({ state, userMessage: 'I moved to Alkmaar', deps: r.deps });

    expect(out.legs).toHaveLength(3);
    expect(out.legBudgetHit).toBe(false);      // three, with headroom. Never routine.
    expect(out.routeKind).toBe('residence');
    expect(out.skillLoaded).toBe('facts/residence');

    // Tool SEQUENCE.
    expect(out.legs.flatMap((l) => l.toolCalls.map((c) => c.name))).toEqual([
      'load_skill', 'lookup_place', 'find_similar_facts', 'saveExtractedFacts',
    ]);

    // The loaded skill is COMPOSED and becomes the later legs' system prompt.
    expect(r.prompts[0]).toContain('You are Mera');
    expect(r.prompts[1]).toBe('GENERIC FACT RULES\n\nRESIDENCE FACT RULES');
    expect(r.prompts[2]).toBe(r.prompts[1]);

    // The proposal carries the RESOLVED chain, not the model's two-field copy.
    expect(out.proposals).toHaveLength(1);
    expect(out.proposals[0].place).toMatchObject({
      locality: 'Alkmaar', countryName: 'Netherlands', bloc: 'EU',
    });
    expect(out.proposals[0].kind).toBe('residence');
    expect(state.turn.turnActive).toBe(false);
  });

  it('a state line carries what the loop established into the next leg', async () => {
    const r = makeDeps([
      res({ content: 'ok', toolCalls: [call('load_skill', { id: 'facts/residence' })] }),
      res({ content: 'ok', toolCalls: [call('lookup_place', { query: 'Alkmaar' })] }),
      res({ content: 'Done.' }),
    ]);
    const out = await runAgentTurn({
      state: createAgentState(PERSONA), userMessage: 'I moved to Alkmaar', deps: r.deps,
    });
    const leg3 = out.legs[2].messages.map((m) => m.content).join('\n');
    expect(leg3).toContain('Place resolved: Alkmaar, North Holland, Netherlands, EU');
    expect(leg3).toContain('Handling: residence');
    // ...and NO prior chat history.
    expect(leg3).not.toContain('Alkmaar, let me note that');
  });
});

// ---------------------------------------------------------------------------
// Conversation 2 — an ambiguous place, resolved by a tap on the NEXT turn.
// ---------------------------------------------------------------------------
describe('conversation 2: an ambiguous place', () => {
  it('asks once, ends the turn, and the tap resolves with no second lookup', async () => {
    const first = makeDeps(
      [
        res({ content: 'ok', toolCalls: [call('load_skill', { id: 'facts/residence' })] }),
        res({
          content: 'Which one did you mean?',
          toolCalls: [
            call('lookup_place', { query: 'the centre' }),
            call('ask_choice', { question: 'Which one?', options: ['Alkmaar', 'Amsterdam'] }),
          ],
        }),
        res({ content: 'should never run' }),
      ],
      [ALKMAAR, AMSTERDAM],
    );

    const state = createAgentState(PERSONA);
    const turn1 = await runAgentTurn({ state, userMessage: 'I moved to the centre', deps: first.deps });

    expect(turn1.legs).toHaveLength(2);               // ask_choice TERMINATES
    expect(first.lookups).toEqual(['the centre']);
    expect(state.turn.pendingChoice?.options.map((o) => o.text)).toEqual(['Alkmaar', 'Amsterdam']);
    expect(state.turn.pendingChoice?.options[0].payload).toEqual(ALKMAAR);
    expect(state.turn.lastTurnAskedQuestion).toBe(true);

    // The tap arrives as an ordinary message on the next turn.
    const second = makeDeps([
      res({
        content: 'Got it.',
        toolCalls: [call('saveExtractedFacts', {
          extracted_user_information: [{ statement: 'Lives in Alkmaar, North Holland, Netherlands, EU' }],
        })],
      }),
    ], [ALKMAAR, AMSTERDAM]);
    await runAgentTurn({ state, userMessage: 'Alkmaar', deps: second.deps });

    expect(second.lookups).toEqual([]);               // NO re-lookup
    expect(state.turn.resolvedChoice?.payload).toEqual(ALKMAAR);
    expect(state.turn.pendingChoice).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Conversation 3 — a correction that wants to delete, and is refused until
// the user has actually confirmed.
// ---------------------------------------------------------------------------
describe('conversation 3: a correction', () => {
  it('REFUSES an unconfirmed delete, and allows it after a real tap', async () => {
    const r = makeDeps([
      res({ content: 'ok', toolCalls: [call('load_skill', { id: 'conversation/correction' })] }),
      res({ content: 'ok', toolCalls: [call('deleteUserFacts', { fact_ids: ['f1'] })] }),
    ]);
    const state = createAgentState(PERSONA);
    await runAgentTurn({ state, userMessage: 'that one is wrong', deps: r.deps });
    expect(r.deletes).toEqual([]);                    // nothing destroyed

    // Now a confirmed choice exists.
    state.turn.resolvedChoice = { question: 'Remove it?', text: 'Yes, remove it', payload: 'f1' };
    const r2 = makeDeps([
      res({ content: 'ok', toolCalls: [call('load_skill', { id: 'conversation/correction' })] }),
      res({ content: 'Removed.', toolCalls: [call('deleteUserFacts', { fact_ids: ['f1'] })] }),
    ]);
    await runAgentTurn({ state, userMessage: 'Yes, remove it', deps: r2.deps });
    expect(r2.deletes).toEqual([['f1']]);
  });
});

// ---------------------------------------------------------------------------
// The background topic call, driven by the kind the conversation chose.
// ---------------------------------------------------------------------------
describe('the topic call follows the conversation', () => {
  it('uses the kind chosen upstream, excludes in the prompt AND vetoes in code', async () => {
    const callModel = jest.fn(async (_req: { systemPrompt: string; messages: { content: string }[] }) =>
      res({ content: '["Alkmaar weather", "Alkmaar housing pressure", "Alkmaar housing"]' }),
    );
    const out = await generateTopicsForFact({
      fact: { statement: 'Lives in Alkmaar, North Holland, Netherlands, EU', placeChain: ALKMAAR },
      skillId: 'topics/residence',
      existingTopics: ['Netherlands rail strikes'],
      declinedTopics: ['Alkmaar weather'],
      deps: {
        callModel,
        loadSkill: (id) => (id in SKILLS ? SKILLS[id] : null),
      },
    });

    // Prompt exclusion: a request.
    const body = callModel.mock.calls[0][0].messages[0].content;
    expect(body).toContain('Netherlands rail strikes');
    expect(body).toContain('Alkmaar weather');

    // Veto: the guarantee. The model returned the declined text anyway.
    expect(out.topics).not.toContain('Alkmaar weather');
    expect(out.dropped.veto).toBe(1);

    // "Alkmaar" is a place name from the chain, so the two housing topics are
    // judged on "pressure" vs nothing -- they do not collapse into one.
    expect(out.topics).toContain('Alkmaar housing pressure');
  });
});
