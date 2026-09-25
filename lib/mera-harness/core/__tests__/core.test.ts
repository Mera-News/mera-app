import {
  MAX_AGENT_LEGS,
  MAX_FORMAT_RETRIES,
  MAX_REPLY_RETRIES,
  REPLY_LEAK_FALLBACK,
  bindChoicePayloads,
  createAgentState,
  reconcilePlaceChain,
  runAgentTurn,
  type AgentPersona,
} from '../core';
import { toolsForLeg } from '../tool-contracts';
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
    loadSkill: (id) => (SKILLS[id] ?? null),
    skillIds: () => Object.keys(SKILLS),
  };
  return { deps, calls };
}

/** The fixture library. It held ONE id, so every test routing anywhere else
 *  silently produced "no skill loaded" and was really exercising a load
 *  failure. */
const SKILLS: Record<string, string> = {
  'facts/residence': 'RESIDENCE SKILL BODY',
  'facts/interest': 'INTEREST SKILL BODY',
  'facts/family': 'FAMILY SKILL BODY',
  'facts/profession': 'PROFESSION SKILL BODY',
  'facts/origin': 'ORIGIN SKILL BODY',
  'conversation/question': 'QUESTION SKILL BODY',
  'conversation/correction': 'CORRECTION SKILL BODY',
};

const tc = (name: string, args: unknown) => ({ name, argumentsRaw: JSON.stringify(args) });

describe('the arm reaches the leg it claims to change', () => {
  // THE DEFECT THIS EXISTS FOR. `arms.test.ts` asserted that `router-v1` carried
  // a different `routerPrompt` VALUE, and it did. Nothing asserted that the
  // value reached the model, and it did not: `promptVariant` was declared on
  // RunAgentTurnParams, passed by the eval runner, and never read. Three corpus
  // runs (g2b, G2c, G2d, 2,101 rows) compared the shipped configuration against
  // itself under four arm names.
  //
  // So this test reads the OUTGOING request, not the registry.
  it('a routerPrompt arm changes the leg-0 system prompt', async () => {
    const base = scriptedDeps([modelResult({ content: 'ok' })]);
    await runAgentTurn({ state: createAgentState(PERSONA), userMessage: 'hi', deps: base.deps });

    const armed = scriptedDeps([modelResult({ content: 'ok' })]);
    await runAgentTurn({
      state: createAgentState(PERSONA),
      userMessage: 'hi',
      deps: armed.deps,
      promptVariant: 'router-v1',
    });

    expect(base.calls[0].systemPrompt).not.toBe(armed.calls[0].systemPrompt);
  });

  it('an UNKNOWN arm throws rather than quietly scoring the control', async () => {
    const { deps } = scriptedDeps([modelResult({ content: 'ok' })]);
    await expect(
      runAgentTurn({
        state: createAgentState(PERSONA),
        userMessage: 'hi',
        deps,
        promptVariant: 'no-such-arm',
      }),
    ).rejects.toThrow(/Unknown agent arm/);
  });
});

describe('the bounded loop', () => {
  // THIS TEST USED TO ASSERT THE BUG. "A text-only turn is exactly ONE leg"
  // described a route leg answering in prose and ending the turn, which is what
  // 90 of 308 G2d route legs did: the user's message landed, nothing routed,
  // nothing was proposed, and the row read as settled. Prose is not a route.
  it('a route leg that answers in prose is RE-ASKED, not accepted', async () => {
    const { deps, calls } = scriptedDeps([modelResult({ content: 'Hello there.' })]);
    const out = await runAgentTurn({ state: createAgentState(PERSONA), userMessage: 'hi', deps });

    expect(out.formatRetries).toBe(MAX_FORMAT_RETRIES);
    expect(out.legs).toHaveLength(1 + MAX_FORMAT_RETRIES);
    expect(out.terminalReason).toBe('no-route');
    // The re-ask names the violation and the legal ids, in the same
    // conversation, the way mini-swe-agent appends its FormatError.
    const retryNote = calls[1].messages[calls[1].messages.length - 1].content;
    expect(retryNote).toContain('routed nothing');
    expect(retryNote).toContain('facts/interest');
    // A re-ask must not cost the turn a leg of real work.
    expect(out.legBudgetHit).toBe(false);
  });

  // THE DROPPED REFERENT. Measured on G3: an answer to the previous turn's
  // question arrived with the question nowhere in context, so the model was
  // classifying a fragment. These assert the text makes the round trip.
  it('carries the previous turn\'s question into the next turn\'s state line', async () => {
    const state = createAgentState(PERSONA);

    const first = scriptedDeps([
      modelResult({ content: 'Got it, Porto. Is that correct?' }),
    ]);
    await runAgentTurn({ state, userMessage: 'I moved to Porto', deps: first.deps });
    expect(state.turn.lastQuestion).toBe('Is that correct?');

    const second = scriptedDeps([modelResult({ content: 'ok' })]);
    await runAgentTurn({
      state,
      userMessage: 'Mostly the older road bridges over the Douro',
      deps: second.deps,
    });
    const stateMsg = second.calls[0].messages.find((m) => m.content.startsWith('<state>'));
    expect(stateMsg?.content).toContain('Is that correct?');
    // The false assertion is gone: the loop cannot tell a typed answer from a
    // non-answer, so it no longer claims one.
    expect(stateMsg?.content).not.toContain('They did not answer');
  });

  it('keeps only the trailing question, not the acknowledgement before it', async () => {
    const state = createAgentState(PERSONA);
    const { deps } = scriptedDeps([
      modelResult({ content: 'Nieuw-West, noted. What do you do for work?' }),
    ]);
    await runAgentTurn({ state, userMessage: 'I live in Nieuw-West', deps });
    expect(state.turn.lastQuestion).toBe('What do you do for work?');
  });

  it('records no question when the turn did not ask one', async () => {
    const state = createAgentState(PERSONA);
    const { deps } = scriptedDeps([modelResult({ content: 'Saved that for you.' })]);
    await runAgentTurn({ state, userMessage: 'I live in Porto', deps });
    expect(state.turn.lastQuestion).toBeNull();
  });

  // RUNNING OUT OF LEGS IS NOT FAILING. G3 labelled 16 of 18 finished turns as
  // capped because the proposal landed on the last leg and said nothing.
  it('a turn that proposed and then ran out of legs is settled, not capped', async () => {
    const save = modelResult({
      toolCalls: [
        {
          name: 'saveExtractedFacts',
          argumentsRaw: JSON.stringify({
            extracted_user_information: [{ statement: 'Lives in Porto' }],
          }),
        },
      ],
    });
    const { deps } = scriptedDeps([
      modelResult({
        content: 'Porto, one moment.',
        toolCalls: [
          { name: 'load_skill', argumentsRaw: JSON.stringify({ id: 'facts/residence' }) },
        ],
      }),
      save,
      save,
      save,
    ]);
    const out = await runAgentTurn({
      state: createAgentState(PERSONA),
      userMessage: 'I moved to Porto',
      deps,
    });

    expect(out.terminalReason).toBe('settled');
    // The UI must not show a cap message for a turn that did its work.
    expect(out.legCapped).toBe(false);
    // One closing-sentence leg after the proposal, never a stream of them.
    expect(out.legs.length).toBeLessThan(MAX_AGENT_LEGS);
  });

  it('a turn that proposed nothing and ran out of legs is still a cap', async () => {
    const spin = modelResult({
      toolCalls: [
        { name: 'lookup_place', argumentsRaw: JSON.stringify({ query: 'Porto' }) },
      ],
    });
    const { deps } = scriptedDeps([
      modelResult({
        content: 'Porto, one moment.',
        toolCalls: [
          { name: 'load_skill', argumentsRaw: JSON.stringify({ id: 'facts/residence' }) },
        ],
      }),
      spin,
      spin,
      spin,
      spin,
    ]);
    const out = await runAgentTurn({
      state: createAgentState(PERSONA),
      userMessage: 'I moved to Porto',
      deps,
    });

    // The LAST leg of a facts turn is the forced offer, so a turn that spun to
    // the cap has had its forced leg and ends `no-proposal`, not `leg-cap`.
    expect(out.forcedProposal).toBe(true);
    expect(out.terminalReason).toBe('no-proposal');
    expect(out.legBudgetHit).toBe(true);
  });

  // ---- THE REPLY GATE --------------------------------------------------
  // Measured on G4: 10% of turns told the user something was saved while a card
  // was still waiting to be tapped, and 4.3% put the state block, a tool name or
  // third-person narration into the bubble.
  const SAVE_TOOL = tc('saveExtractedFacts', {
    extracted_user_information: [{ statement: 'Lives in Porto' }],
  });

  function claimingTurn(finalReplies: string[]) {
    return scriptedDeps([
      modelResult({ content: 'Porto, one moment.', toolCalls: [tc('load_skill', { id: 'facts/residence' })] }),
      modelResult({ content: '', toolCalls: [SAVE_TOOL] }),
      ...finalReplies.map((content) => modelResult({ content })),
    ]);
  }

  it('re-asks once when the final reply claims a save, and keeps the corrected one', async () => {
    const { deps, calls } = claimingTurn([
      "Got it, I've noted that.",
      'Got it, Porto. What do you do for work?',
    ]);
    const out = await runAgentTurn({
      state: createAgentState(PERSONA), userMessage: 'I moved to Porto', deps,
    });

    expect(out.replyRetries).toBe(1);
    expect(out.replyClaimUnfixed).toBe(false);
    expect(out.reply).toBe('Got it, Porto. What do you do for work?');
    expect(out.terminalReason).toBe('settled');
    // The correction is named back in the SAME conversation, mini-swe-agent's
    // FormatError shape, and it must say what was wrong.
    const note = calls[calls.length - 1].messages.map((m) => m.content).join(' ');
    expect(note).toContain('Nothing is saved until the user taps');
    // A wording mistake must not cost the turn a leg of real work.
    expect(out.legBudgetHit).toBe(false);
    expect(out.proposals).toHaveLength(1);
  });

  it('keeps a save claim that survives its correction, and counts it', async () => {
    const { deps } = claimingTurn(["Got it, I've noted that.", 'Noted, all done.']);
    const out = await runAgentTurn({
      state: createAgentState(PERSONA), userMessage: 'I moved to Porto', deps,
    });

    expect(out.replyRetries).toBe(MAX_REPLY_RETRIES);
    expect(out.replyClaimUnfixed).toBe(true);
    // KEPT, not rewritten: a slightly wrong word beside a visible card beats a
    // mangled sentence, and the residue stays measurable.
    expect(out.reply).toBe('Noted, all done.');
    expect(out.proposals).toHaveLength(1);
  });

  it('replaces a leak that survives its correction, because scaffolding must not ship', async () => {
    const leak = "I'll extract the fact about their residence from your message.";
    const { deps } = claimingTurn([leak, leak]);
    const out = await runAgentTurn({
      state: createAgentState(PERSONA), userMessage: 'I moved to Porto', deps,
    });

    expect(out.replyLeakUnfixed).toBe(true);
    // A card is on screen (this turn staged one), so the leak is dropped
    // rather than replaced with a question (ux1 C4).
    expect(out.reply).toBe('');
    expect(out.reply).not.toContain('their residence');
  });

  it('does not gate an intermediate leg, whose prose the user never sees', async () => {
    // The ROUTER ACKNOWLEDGEMENT claims a save and is then overwritten by the
    // final reply. Gating it would spend a leg correcting discarded text, and
    // the gate sits at the settle decision precisely so it cannot.
    const { deps } = scriptedDeps([
      modelResult({
        content: 'Noted, Porto.',
        toolCalls: [tc('load_skill', { id: 'facts/residence' })],
      }),
      modelResult({ content: '', toolCalls: [SAVE_TOOL] }),
      modelResult({ content: 'Got it, Porto. What do you do for work?' }),
    ]);
    const out = await runAgentTurn({
      state: createAgentState(PERSONA), userMessage: 'I moved to Porto', deps,
    });

    expect(out.replyRetries).toBe(0);
    expect(out.reply).toBe('Got it, Porto. What do you do for work?');
  });

  it('spends no retry on a clean reply', async () => {
    const { deps } = claimingTurn(['Got it, Porto. What do you do for work?']);
    const out = await runAgentTurn({
      state: createAgentState(PERSONA), userMessage: 'I moved to Porto', deps,
    });
    expect(out.replyRetries).toBe(0);
    expect(out.replyClaimUnfixed).toBe(false);
    expect(out.replyLeakUnfixed).toBe(false);
  });

  it('keeps its budget separate from the route budget', async () => {
    // A turn that burned both route retries must still be able to fix its reply.
    const { deps } = scriptedDeps([
      modelResult({ content: 'Hmm.' }),
      modelResult({ content: 'Still hmm.' }),
      modelResult({ content: 'Porto.', toolCalls: [tc('load_skill', { id: 'facts/residence' })] }),
      modelResult({ content: '', toolCalls: [SAVE_TOOL] }),
      modelResult({ content: "I've noted that." }),
      modelResult({ content: 'Got it, Porto.' }),
    ]);
    const out = await runAgentTurn({
      state: createAgentState(PERSONA), userMessage: 'I moved to Porto', deps,
    });
    expect(out.formatRetries).toBe(MAX_FORMAT_RETRIES);
    expect(out.replyRetries).toBe(1);
    expect(out.reply).toBe('Got it, Porto.');
  });

  // ---- THE TOOL PAYLOAD MATCHES THE GUIDELINE -------------------------
  // On device, "Delete all facts" was refused in prose with "please open the
  // app and tap the trash can icon": the router sends deletion to
  // conversation/correction, whose body says to call deleteUserFacts, and the
  // prefix test handed writers only to facts/*. A skill told to write must be
  // given the means.
  function toolNamesFor(skillId: string): string[] {
    return toolsForLeg({ skillLoaded: skillId }).map(
      (t) => (t as { function: { name: string } }).function.name,
    );
  }

  it('offers both writers to the skill whose job is deletion', () => {
    const names = toolNamesFor('conversation/correction');
    expect(names).toContain('deleteUserFacts');
    expect(names).toContain('saveExtractedFacts');
  });

  it('still offers both writers to a facts skill', () => {
    const names = toolNamesFor('facts/residence');
    expect(names).toContain('deleteUserFacts');
    expect(names).toContain('saveExtractedFacts');
  });

  // The widening is exactly one skill, not "every conversation/* leg".
  it('withholds the writers from a skill that only answers', () => {
    const names = toolNamesFor('conversation/question');
    expect(names).not.toContain('deleteUserFacts');
    expect(names).not.toContain('saveExtractedFacts');
  });

  it('never offers load_skill once a skill is loaded', () => {
    for (const id of ['conversation/correction', 'facts/residence', 'conversation/question']) {
      expect(toolNamesFor(id)).not.toContain('load_skill');
    }
  });

  // THE GATE IS UNCHANGED BY THE WIDENING. Offering the tool makes the
  // CONFIRMATION reachable, never a silent wipe.
  it('a correction turn still cannot delete without a confirmed choice', async () => {
    const deleteUserFacts = jest.fn(async () => ({ deleted: ['f1'] }));
    const { deps } = scriptedDeps(
      [
        modelResult({
          content: 'Right, removing that.',
          toolCalls: [tc('load_skill', { id: 'conversation/correction' })],
        }),
        modelResult({
          content: 'Done.',
          toolCalls: [tc('deleteUserFacts', { fact_ids: ['location: residence'] })],
        }),
      ],
      { deleteUserFacts },
    );
    await runAgentTurn({
      state: createAgentState(PERSONA), userMessage: 'delete all facts', deps,
    });
    expect(deleteUserFacts).not.toHaveBeenCalled();
  });

  // A CORRECT REFUSAL IS NOT A FAILURE. On device, "I'm travelling to Hawaii"
  // got exactly the right answer (a trip is not a residence change) and was
  // painted with the cap error box, because the turn proposed nothing.
  it('a turn that answered well but proposed nothing is settled, not capped', async () => {
    const answer = modelResult({
      content: "Since Hawaii is a trip rather than your home, I won't update your residence.",
    });
    const { deps } = scriptedDeps([
      modelResult({
        content: 'Hawaii, one moment.',
        toolCalls: [tc('load_skill', { id: 'conversation/question' })],
      }),
      answer, answer, answer, answer,
    ]);
    const out = await runAgentTurn({
      state: createAgentState(PERSONA), userMessage: "I'm travelling to Hawaii", deps,
    });

    expect(out.terminalReason).toBe('settled');
    expect(out.legCapped).toBe(false);
    expect(out.proposals).toHaveLength(0);
  });

  it('a turn that ran out of legs with NOTHING to show is still a cap', async () => {
    // Silent tool spinning: no proposal and no prose, so there is nothing the
    // user could read as an answer.
    const spin = modelResult({
      content: '',
      toolCalls: [tc('lookup_place', { query: 'Porto' })],
    });
    const { deps } = scriptedDeps([
      modelResult({
        content: 'Porto, one moment.',
        toolCalls: [tc('load_skill', { id: 'facts/residence' })],
      }),
      spin, spin, spin, spin,
    ]);
    const out = await runAgentTurn({
      state: createAgentState(PERSONA), userMessage: 'I moved to Porto', deps,
    });

    // Its last leg was the forced offer (see B13 below), which produced
    // nothing: counted as `no-proposal`, and still rendered as a terminal.
    expect(out.forcedProposal).toBe(true);
    expect(out.terminalReason).toBe('no-proposal');
    expect(out.legBudgetHit).toBe(true);
  });

  // A CONTROL THAT HAS BEEN TIDIED UP MEASURES NOTHING. These assert that
  // `pre-enforcement` really is the configuration the 38% and the 99 no-route
  // legs came from, not a partly-fixed version of it wearing the label.
  it('the pre-enforcement arm reproduces the loop as it was measured', async () => {
    const { deps, calls } = scriptedDeps([modelResult({ content: 'Hello there.' })]);
    const out = await runAgentTurn({
      state: createAgentState(PERSONA),
      userMessage: 'hi',
      deps,
      promptVariant: 'pre-enforcement',
    });

    // Ends on prose, in one leg, with no route and no re-ask. The bug, intact.
    expect(out.legs).toHaveLength(1);
    expect(out.formatRetries).toBe(0);
    expect(out.skillLoaded).toBeNull();
    expect(out.terminalReason).toBe('settled');
    // And the route leg carries all four discovery tools again.
    const toolNames = (calls[0].tools as { function: { name: string } }[])
      .map((d) => d.function.name)
      .sort();
    expect(toolNames).toEqual([
      'ask_choice', 'find_similar_facts', 'load_skill', 'lookup_place',
    ]);
    // Including the sentence they were obeying.
    expect(calls[0].systemPrompt).toMatch(/No row matches: answer briefly and stop/);
  });

  it('prose settles normally ONCE a skill is loaded', async () => {
    const { deps } = scriptedDeps([
      modelResult({ content: 'ok', toolCalls: [tc('load_skill', { id: 'facts/residence' })] }),
      modelResult({ content: 'Hello there.' }),
    ]);
    const out = await runAgentTurn({ state: createAgentState(PERSONA), userMessage: 'hi', deps });
    expect(out.formatRetries).toBe(0);
    expect(out.reply).toBe('Hello there.');
  });

  it('a preamble PLUS load_skill continues; it does not settle on leg 1', async () => {
    // The whole acknowledgement design rests on this ordering: a leg with text
    // AND a forcing call must continue, or every fact turn becomes one leg with
    // no skill loaded.
    const { deps, calls } = scriptedDeps([
      modelResult({ content: 'Nieuw-West, let me note that.', toolCalls: [tc('load_skill', { id: 'facts/residence' })] }),
      modelResult({
        // Not "Saved that one." on purpose: that trips the reply gate and buys a
        // correction leg, which would make this ordering test measure the gate.
        content: 'That one is on a card for you.',
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
    //
    // SILENT after the route leg, on purpose. The loop cannot tell "spun and
    // then answered well" from "spun uselessly": both are prose after routing
    // with no proposal. It resolves that in the user's favour, so a turn that
    // spun AND produced prose now settles, and only a turn with nothing to show
    // still reports the cap. The cost is that a genuinely stuck turn which
    // emitted filler reads as settled; the user still sees that filler and can
    // ask again, where the old rule painted a correct refusal as an error.
    const { deps } = scriptedDeps([
      modelResult({ content: 'a', toolCalls: [tc('load_skill', { id: 'facts/residence' })] }),
      modelResult({ content: '', toolCalls: [tc('lookup_place', { query: 'Alkmaar' })] }),
      modelResult({ content: '', toolCalls: [tc('lookup_place', { query: 'Hoorn' })] }),
      modelResult({ content: '', toolCalls: [tc('lookup_place', { query: 'Utrecht' })] }),
    ]);
    const out = await runAgentTurn({ state: createAgentState(PERSONA), userMessage: 'hi', deps });
    expect(out.legs).toHaveLength(MAX_AGENT_LEGS);
    expect(out.legBudgetHit).toBe(true);
    // A facts turn's last leg is the forced offer; with nothing offered the
    // turn is `no-proposal`, a terminal the UI still renders.
    expect(out.terminalReason).toBe('no-proposal');
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
    // Routes FIRST: `lookup_place` is not on the route leg's payload any more,
    // so a turn that opens with one is exercising the no-route path instead of
    // the repeat rule this test is about.
    const { deps } = scriptedDeps([
      modelResult({ content: 'r', toolCalls: [tc('load_skill', { id: 'conversation/question' })] }),
      modelResult({ content: 'a', toolCalls: [tc('lookup_place', { query: 'Alkmaar' })] }),
      modelResult({ content: 'b', toolCalls: [tc('lookup_place', { query: 'Alkmaar' })] }),
    ]);
    const out = await runAgentTurn({ state: createAgentState(PERSONA), userMessage: 'hi', deps });
    expect(out.legs).toHaveLength(3);
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

  it('a malformed tool call is never executed', async () => {
    const { deps } = scriptedDeps([
      modelResult({ content: 'text', toolCalls: [{ name: 'load_skill', argumentsRaw: '{"id":' }] }),
    ]);
    const out = await runAgentTurn({ state: createAgentState(PERSONA), userMessage: 'hi', deps });
    expect(out.legs[0].toolResults[0].result).toEqual({ error: 'malformed arguments' });
    // An unparseable route and an absent route are the same thing from the
    // loop's side: the leg was asked for a route and did not produce one.
    expect(out.formatRetries).toBe(MAX_FORMAT_RETRIES);
    expect(out.terminalReason).toBe('no-route');
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
    // Consumed by the turn that answered, not left set for the conversation.
    expect(state.turn.resolvedChoice).toBeNull();
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
    expect(out.legs[0].toolResults[0].result).toMatchObject({ error: expect.stringMatching(/card asks the user to confirm/) });
  });

  // Owner ruling ux1 Q1: a SAME-KEY replace needs no chip (the card is the
  // consent). A keyless or cross-key one still does, which is what this pins.
  it('a keyless `replaces` is dropped unless a choice was actually confirmed', async () => {
    const { deps } = scriptedDeps([
      modelResult({
        content: 'ok',
        toolCalls: [tc('saveExtractedFacts', {
          // NOT a home: a new home always targets the home on file (ux1
          // batch 5), so a home statement would not test this guard.
          extracted_user_information: [{ statement: 'Works at Zalando', replaces: 'f1' }],
        })],
      }),
    ]);
    const out = await runAgentTurn({ state: createAgentState(PERSONA), userMessage: 'I work at Zalando', deps });
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
    // TRUE FOR THE WHOLE OF EVERY LEG, however many legs the turn takes. The
    // count is not the invariant; never being false mid-turn is.
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((v) => v === true)).toBe(true);
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
      modelResult({ content: 'ok', toolCalls: [tc('load_skill', { id: 'facts/interest' })] }),
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

  // The route leg used to carry all four discovery tools, and 9 of G2d's 99
  // no-route legs discharged "call a tool" with one of the other three. The
  // route leg has one job, so it gets one tool.
  it('the ROUTER leg offers load_skill and NOTHING else', async () => {
    const { deps, calls } = scriptedDeps([modelResult({ content: 'hi' })]);
    await runAgentTurn({ state: createAgentState(PERSONA), userMessage: 'hi', deps });
    expect(names(calls[0].tools)).toEqual(['load_skill']);
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

  // NAMED FOR THE SKILL, not the group: conversation/correction DOES get both
  // writers, because deleting is its job.
  it('a conversation/question leg offers no writer: there is nothing to save', async () => {
    const { deps, calls } = scriptedDeps([
      modelResult({ content: 'ok', toolCalls: [tc('load_skill', { id: 'conversation/question' })] }),
      modelResult({ content: 'answer' }),
    ]);
    await runAgentTurn({ state: createAgentState(PERSONA), userMessage: 'how?', deps });
    expect(names(calls[1].tools)).not.toContain('saveExtractedFacts');
  });
});

// ---------------------------------------------------------------------------
// Three defects reported from TestFlight, each tested THROUGH runAgentTurn
// rather than against the pure helper, because all three were failures of
// where a correct check was wired rather than of the check itself.
// ---------------------------------------------------------------------------

describe('TestFlight regressions', () => {
  const tc2 = (name: string, args: Record<string, unknown>) => ({
    name,
    argumentsRaw: JSON.stringify(args),
  });

  const RESIDENT: AgentPersona = {
    surface: 'CONFIG',
    languageName: 'English',
    facts: [
      {
        id: 'home',
        statement: 'Lives in Amsterdam, North Holland, The Netherlands, EU',
        attribute: 'location: residence',
      },
    ],
  };

  it('refuses a cross-subject replace and offers the fact as a plain add', async () => {
    // "My girlfriend's parents live in Porto Santo" resolved to Vila Baleira
    // and was offered as a replacement for the user's OWN home. The user had
    // confirmed a choice, so the existing confirmed-choice guard passed it.
    const { deps } = scriptedDeps([
      modelResult({
        content: 'One moment.',
        toolCalls: [tc2('load_skill', { id: 'facts/residence' })],
      }),
      modelResult({
        content: '',
        toolCalls: [
          tc2('saveExtractedFacts', {
            extracted_user_information: [
              {
                statement: "Girlfriend's parents live in Vila Baleira, Madeira, Portugal, EU",
                replaces: 'home',
              },
            ],
          }),
        ],
      }),
      modelResult({ content: 'Here is the reading to confirm.' }),
    ]);
    const state = createAgentState(RESIDENT);
    // The turn HAS a confirmed choice, which is what made the old guard pass.
    state.turn.resolvedChoice = { question: 'Which one?', text: 'Vila Baleira', payload: null };

    const out = await runAgentTurn({
      state,
      userMessage: 'My girlfriends parents live in Porto Santo',
      deps,
    });

    expect(out.proposals).toHaveLength(1);
    expect(out.proposals[0].replaces).toBeNull();
    expect(out.refusedReplaces).toBe(1);
  });

  it('still honours a replace when both facts are about the same subject', async () => {
    // The guard must not cost a real move.
    const { deps } = scriptedDeps([
      modelResult({
        content: 'One moment.',
        toolCalls: [tc2('load_skill', { id: 'facts/residence' })],
      }),
      modelResult({
        content: '',
        toolCalls: [
          tc2('saveExtractedFacts', {
            extracted_user_information: [
              { statement: 'Lives in Berlin, Germany, EU', replaces: 'home' },
            ],
          }),
        ],
      }),
      modelResult({ content: 'Here is the reading to confirm.' }),
    ]);
    const state = createAgentState(RESIDENT);
    state.turn.resolvedChoice = { question: 'Which one?', text: 'Berlin', payload: null };

    const out = await runAgentTurn({ state, userMessage: 'I moved to Berlin', deps });

    expect(out.proposals[0].replaces).toBe('home');
    expect(out.refusedReplaces).toBe(0);
  });

  it('offers ONE card when the model proposes the same statement twice', async () => {
    // Two identical "Which one did you mean?" cards, both blocking the
    // composer. `existingStatements` only held facts already on file, so it
    // could not see a repeat within the turn.
    const { deps } = scriptedDeps([
      modelResult({
        content: 'One moment.',
        toolCalls: [tc2('load_skill', { id: 'facts/family' })],
      }),
      modelResult({
        content: '',
        toolCalls: [
          tc2('saveExtractedFacts', {
            extracted_user_information: [
              { statement: 'Parents live in Bhopal, Madhya Pradesh, India, Asia' },
              { statement: 'Parents live in Bhopal, Madhya Pradesh, India, Asia' },
            ],
          }),
        ],
      }),
      modelResult({ content: 'Here is the reading to confirm.' }),
    ]);

    const out = await runAgentTurn({
      state: createAgentState(PERSONA),
      userMessage: 'my parents live in bhopal jk road',
      deps,
    });

    expect(out.proposals).toHaveLength(1);
  });

  // THE SHIPPED PATH. `handleSaveExtractedFacts` builds the cards from
  // `extracted_user_information`, never from `proposals`, so asserting only on
  // `out.proposals` would pass while the user still sees the wrong card. These
  // two assert on what the TOOL was handed.
  it('hands the TOOL a list with the refused replace stripped', async () => {
    const seen: Record<string, unknown>[] = [];
    const { deps } = scriptedDeps(
      [
        modelResult({ content: 'One moment.', toolCalls: [tc2('load_skill', { id: 'facts/residence' })] }),
        modelResult({
          content: '',
          toolCalls: [
            tc2('saveExtractedFacts', {
              extracted_user_information: [
                {
                  statement: "Girlfriend's parents live in Vila Baleira, Madeira, Portugal, EU",
                  questionnaire_attribute: 'location: residence',
                  replaces: 'home',
                },
              ],
            }),
          ],
        }),
        modelResult({ content: 'Here is the reading to confirm.' }),
      ],
      {
        saveExtractedFacts: async (args: Record<string, unknown>) => {
          seen.push(...(args.extracted_user_information as Record<string, unknown>[]));
          return { staged: true };
        },
      },
    );
    const state = createAgentState(RESIDENT);
    state.turn.resolvedChoice = { question: 'Which one?', text: 'Vila Baleira', payload: null };

    await runAgentTurn({ state, userMessage: 'My girlfriends parents live in Porto Santo', deps });

    expect(seen).toHaveLength(1);
    expect(seen[0].replaces).toBeUndefined();
    // Untouched: the card owns these, not the loop.
    expect(seen[0].questionnaire_attribute).toBe('location: residence');
  });

  it('hands the TOOL one entry when the model sent the same statement twice', async () => {
    const seen: Record<string, unknown>[] = [];
    const { deps } = scriptedDeps(
      [
        modelResult({ content: 'One moment.', toolCalls: [tc2('load_skill', { id: 'facts/family' })] }),
        modelResult({
          content: '',
          toolCalls: [
            tc2('saveExtractedFacts', {
              extracted_user_information: [
                { statement: 'Parents live in Bhopal, Madhya Pradesh, India, Asia' },
                { statement: 'Parents live in Bhopal, Madhya Pradesh, India, Asia' },
              ],
            }),
          ],
        }),
        modelResult({ content: 'Here is the reading to confirm.' }),
      ],
      {
        saveExtractedFacts: async (args: Record<string, unknown>) => {
          seen.push(...(args.extracted_user_information as Record<string, unknown>[]));
          return { staged: true };
        },
      },
    );

    await runAgentTurn({
      state: createAgentState(PERSONA),
      userMessage: 'my parents live in bhopal jk road',
      deps,
    });

    expect(seen).toHaveLength(1);
  });

  // THE WORST PATH FOUND SO FAR, and it takes TWO turns to reproduce, which is
  // why no single-turn test caught it. The subject has to survive the question.
  it('resumes the asking skill on a chip tap, so the subject survives the question', async () => {
    const state = createAgentState(RESIDENT);

    // Turn 1: routed correctly to family, asks which Porto Santo.
    const { deps: t1 } = scriptedDeps([
      modelResult({ content: 'Porto Santo, one moment.', toolCalls: [tc2('load_skill', { id: 'facts/family' })] }),
      modelResult({
        content: '',
        toolCalls: [
          tc2('ask_choice', {
            question: 'Which Porto Santo did you mean?',
            options: ['Porto Santo Stefano', 'Vila Baleira'],
          }),
        ],
      }),
    ]);
    const first = await runAgentTurn({
      state,
      userMessage: 'my girlfriends parents live in porto santo',
      deps: t1,
    });
    expect(first.terminalReason).toBe('awaiting-user');
    expect(state.turn.lastSkill).toBe('facts/family');

    // Turn 2: the tap. The router used to see a bare place name beside a
    // residence fact and send it to facts/residence, which then proposed
    // "Lives in Vila Baleira" as a REPLACEMENT for the user's own home.
    const { deps: t2 } = scriptedDeps([
      modelResult({
        content: '',
        toolCalls: [
          tc2('saveExtractedFacts', {
            extracted_user_information: [
              { statement: "Girlfriend's parents live in Vila Baleira, Madeira, Portugal, EU" },
            ],
          }),
        ],
      }),
      modelResult({ content: 'Here is the reading to confirm.' }),
    ]);
    const second = await runAgentTurn({ state, userMessage: 'Vila Baleira', deps: t2 });

    expect(second.resumedSkill).toBe(true);
    expect(second.skillLoaded).toBe('facts/family');
    // No leg was spent re-routing a tap.
    expect(second.legs[0].toolCalls[0].name).toBe('saveExtractedFacts');
  });

  it('carries the ORIGINAL message into the resumed turn, not just the chip', async () => {
    // Resuming the skill without the subject moves the bug rather than fixing
    // it. Measured on device: facts/family resumed correctly and then proposed
    // "Lives in Bhopal" for the USER, because the word "parents" existed only
    // in the previous turn's message and a chip tap replaces the message with
    // its own label.
    const state = createAgentState(PERSONA);
    const { deps: t1 } = scriptedDeps([
      modelResult({ content: 'Bhopal, one moment.', toolCalls: [tc2('load_skill', { id: 'facts/family' })] }),
      modelResult({
        content: '',
        toolCalls: [
          tc2('ask_choice', {
            question: 'Which Bhopal did you mean?',
            options: ['Bhopal, Madhya Pradesh', 'Bhopal Taluka'],
          }),
        ],
      }),
    ]);
    await runAgentTurn({ state, userMessage: 'my parents live in bhopal', deps: t1 });

    const { deps: t2, calls } = scriptedDeps([
      modelResult({ content: '', toolCalls: [tc2('saveExtractedFacts', { extracted_user_information: [{ statement: 'Parents live in Bhopal, Madhya Pradesh, India, Asia' }] })] }),
      modelResult({ content: 'Here is the reading to confirm.' }),
    ]);
    await runAgentTurn({ state, userMessage: 'Bhopal, Madhya Pradesh', deps: t2 });

    const firstLeg = calls[0].messages.map((m) => m.content).join('\n');
    expect(firstLeg).toContain('my parents live in bhopal');
  });

  it('does NOT inject the earlier message on an ordinary turn', async () => {
    const state = createAgentState(PERSONA);
    state.turn.lastUserMessage = 'my parents live in bhopal';
    const { deps, calls } = scriptedDeps([
      modelResult({ content: 'One moment.', toolCalls: [tc2('load_skill', { id: 'facts/profession' })] }),
      modelResult({ content: '', toolCalls: [tc2('saveExtractedFacts', { extracted_user_information: [{ statement: 'Works as a software engineer' }] })] }),
      modelResult({ content: 'Here is the reading to confirm.' }),
    ]);

    await runAgentTurn({ state, userMessage: 'I work as a software engineer', deps });

    const firstLeg = calls[0].messages.map((m) => m.content).join('\n');
    expect(firstLeg).not.toContain('my parents live in bhopal');
  });

  it('the choice is CONSUMED, so the turn after it routes normally again', async () => {
    // `resolvedChoice` was set and never cleared, so it stayed true for the
    // rest of the conversation. Everything gated on it widened from "the user
    // confirmed this turn" to "the user has confirmed something, once": the
    // destructive `replaces` gate, the delete gate, and (once the resume
    // landed) the routing itself. Measured on the simulator: after one
    // disambiguation, "I am interested in music festivals" resumed
    // `facts/profession`.
    const state = createAgentState(PERSONA);
    const { deps: t1 } = scriptedDeps([
      modelResult({ content: 'One moment.', toolCalls: [tc2('load_skill', { id: 'facts/profession' })] }),
      modelResult({
        content: '',
        toolCalls: [tc2('ask_choice', { question: 'Which one?', options: ['Engineer', 'Founder'] })],
      }),
    ]);
    await runAgentTurn({ state, userMessage: 'I am an entrepreneur', deps: t1 });

    // Turn 2 answers the chip and RESUMES.
    const { deps: t2 } = scriptedDeps([
      modelResult({ content: '', toolCalls: [tc2('saveExtractedFacts', { extracted_user_information: [{ statement: 'Entrepreneur' }] })] }),
      modelResult({ content: 'Here is the reading.' }),
    ]);
    const answered = await runAgentTurn({ state, userMessage: 'Founder', deps: t2 });
    expect(answered.resumedSkill).toBe(true);

    // Turn 3 is a NEW subject and must route for itself.
    const { deps: t3 } = scriptedDeps([
      modelResult({ content: 'One moment.', toolCalls: [tc2('load_skill', { id: 'facts/interest' })] }),
      modelResult({ content: '', toolCalls: [tc2('saveExtractedFacts', { extracted_user_information: [{ statement: 'Interested in music festivals' }] })] }),
      modelResult({ content: 'Here is the reading.' }),
    ]);
    const third = await runAgentTurn({ state, userMessage: 'I am interested in music festivals', deps: t3 });

    expect(third.resumedSkill).toBe(false);
    expect(third.skillLoaded).toBe('facts/interest');
  });

  it('a KEYLESS replace is refused once the confirmation belongs to an EARLIER turn', async () => {
    // The `replaces` gate reads the same flag, so a single tap anywhere in the
    // conversation used to leave it open for good. Keyless on purpose: a
    // same-key replace passes on the card's own consent (ux1 Q1), so only a
    // replace without a matching key still depends on this turn's tap.
    const state = createAgentState(RESIDENT);
    state.turn.resolvedChoice = { question: 'Which one?', text: 'Berlin', payload: null };
    state.turn.lastSkill = 'facts/residence';

    const { deps: t1 } = scriptedDeps([
      modelResult({ content: '', toolCalls: [tc2('saveExtractedFacts', { extracted_user_information: [{ statement: 'Lives in Berlin, Germany, EU', replaces: 'home' }] })] }),
      modelResult({ content: 'Here is the reading.' }),
    ]);
    const first = await runAgentTurn({ state, userMessage: 'Berlin', deps: t1 });
    expect(first.proposals[0].replaces).toBe('home');

    // A LATER turn proposing a replace has no confirmation of its own.
    const { deps: t2 } = scriptedDeps([
      modelResult({ content: 'One moment.', toolCalls: [tc2('load_skill', { id: 'facts/residence' })] }),
      // Not a home statement: a new HOME always targets the home on file
      // (ux1 batch 5); this pins the keyless cross-key case.
      modelResult({ content: '', toolCalls: [tc2('saveExtractedFacts', { extracted_user_information: [{ statement: 'Works in Porto, Portugal, EU', replaces: 'home' }] })] }),
      modelResult({ content: 'Here is the reading.' }),
    ]);
    const second = await runAgentTurn({ state, userMessage: 'I might work in Porto', deps: t2 });

    expect(second.proposals[0].replaces).toBeNull();
  });

  it('does NOT resume when the message is not the answer to a pending choice', async () => {
    // A fresh statement after an unanswered question must still route.
    const state = createAgentState(RESIDENT);
    state.turn.lastSkill = 'facts/family';
    const { deps } = scriptedDeps([
      modelResult({ content: 'One moment.', toolCalls: [tc2('load_skill', { id: 'facts/profession' })] }),
      modelResult({ content: '', toolCalls: [tc2('saveExtractedFacts', { extracted_user_information: [{ statement: 'Works as a software engineer' }] })] }),
      modelResult({ content: 'Here is the reading to confirm.' }),
    ]);

    const out = await runAgentTurn({ state, userMessage: 'I work as a software engineer', deps });

    expect(out.resumedSkill).toBe(false);
    expect(out.skillLoaded).toBe('facts/profession');
  });

  it('scrubs a leaking reply on a terminal that never reaches the settle gate', async () => {
    // The reply gate sits just before the settle `break`, so a turn that ends
    // any other way returned its prose unchecked. Reported: a turn answered
    // with an invented copy of its own system prompt.
    const INVENTED_PROMPT =
      'You are a skilled assistant specializing in personal fact extraction. '
      + 'Strict Rules: make exactly one saveExtractedFacts call per turn. '
      + 'If the message contains no offerable facts, call it with an empty array.';

    // A facts skill that proposes nothing ends on `no-proposal`, never on the
    // settle path.
    const { deps } = scriptedDeps([
      modelResult({
        content: 'One moment.',
        toolCalls: [tc2('load_skill', { id: 'facts/interest' })],
      }),
      modelResult({ content: INVENTED_PROMPT }),
      modelResult({ content: INVENTED_PROMPT }),
      modelResult({ content: INVENTED_PROMPT }),
      modelResult({ content: INVENTED_PROMPT }),
    ]);

    const out = await runAgentTurn({
      state: createAgentState(PERSONA),
      userMessage: "I'm building an ai news app",
      deps,
    });

    expect(out.terminalReason).not.toBe('settled');
    expect(out.reply).toBe(REPLY_LEAK_FALLBACK);
    expect(out.replyLeakUnfixed).toBe(true);
  });
});
