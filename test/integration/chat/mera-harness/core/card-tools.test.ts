// Cards in the cloud loop (onemera S1): a filter or source change is staged on a card, applied by a
// tap or by the user agreeing in words, or dropped. Driven through the real loop with a scripted model.
import { createAgentState, runAgentTurn, type AgentPersona } from '@/lib/mera-harness/core/core';
import { registerAgentArm, resetAgentArmsForTest } from '@/lib/mera-harness/core/arms';
import { buildRouterPrompt } from '@/lib/mera-harness/core/router-prompt';
import { skillIndexRows, skillThinking, skillTools } from '@/lib/mera-harness/core/skill-loader';
import { SKILL_TOOL_ORDER, toolsForLeg } from '@/lib/mera-harness/core/tool-contracts';
import { KNOWN_SKILL_TOOLS } from '@/lib/mera-harness/skills/generate';
import type { AgentDeps, AgentModelRequest, AgentModelResult } from '@/lib/mera-harness/core/types';

function res(over: Partial<AgentModelResult> = {}): AgentModelResult {
  return {
    content: '', toolCalls: [], finishReason: 'stop', truncated: false,
    usage: null, modelSent: 'fake', latencyMs: 1, error: null, ...over,
  };
}
const tc = (name: string, args: unknown = {}) => ({ name, argumentsRaw: JSON.stringify(args) });

const SKILLS: Record<string, string> = {
  'conversation/feed-tuning': 'FEED TUNING BODY',
  'conversation/question': 'QUESTION BODY',
  'facts/interest': 'INTEREST BODY',
};

const PERSONA: AgentPersona = { surface: 'CONFIG', languageName: 'English', facts: [] };
const MUTE = {
  explanation: 'Mutes the outlet.',
  expected_effects: 'No stories from it.',
  actions: [{ type: 'set_publication_pref', publicationId: 'The Hindu', publicationPref: 'mute' }],
};

function harness(script: AgentModelResult[], over: Partial<AgentDeps['tools']> = {}) {
  const requests: AgentModelRequest[] = [];
  const port = {
    proposeChanges: jest.fn(async () => ({ staged: true, proposalId: 'p-1', actions: MUTE.actions })),
    applyProposal: jest.fn(async () => ({ applied: 1, errors: [], summaries: ['Muted The Hindu'], changeLogIds: ['c1'] })),
    cancelProposal: jest.fn(async () => ({ cancelled: true })),
  };
  let i = 0;
  const deps: AgentDeps = {
    callModel: async (req) => {
      requests.push(req);
      return script[Math.min(i++, script.length - 1)];
    },
    tools: {
      findSimilarFacts: async () => ({ candidates: [] }),
      lookupPlace: async () => ({ status: 'no_match', query: '' }),
      saveExtractedFacts: async () => ({ staged: true }),
      deleteUserFacts: async () => ({ deleted: [] }),
      ...port,
      ...over,
    },
    loadSkill: (id) => SKILLS[id] ?? null,
    skillIds: () => Object.keys(SKILLS),
  };
  return { deps, requests, port };
}

const names = (req: AgentModelRequest) => ((req.tools ?? []) as { function: { name: string } }[]).map((t) => t.function.name);
const stateOf = (req: AgentModelRequest) => req.messages[0]?.content ?? '';

afterEach(() => resetAgentArmsForTest());

describe('staging a card', () => {
  it('ends the turn on the leg that staged it, keeps that leg\'s sentence and remembers the staging skill', async () => {
    const { deps, requests, port } = harness([
      res({ content: 'Got it, The Hindu.', toolCalls: [tc('load_skill', { id: 'conversation/feed-tuning' })] }),
      res({ content: 'Tap the card to mute The Hindu.', toolCalls: [tc('proposeChanges', MUTE)] }),
    ]);
    const state = createAgentState(PERSONA);

    const out = await runAgentTurn({ state, userMessage: 'mute the hindu', deps });

    expect(port.proposeChanges).toHaveBeenCalledWith(MUTE);
    expect(requests).toHaveLength(2);
    expect(names(requests[1])).toEqual(['proposeChanges']);
    expect(out.terminalReason).toBe('awaiting-user');
    expect(out.reply).toBe('Tap the card to mute The Hindu.');
    expect(state.turn.lastCard).toEqual({ proposalId: 'p-1', skill: 'conversation/feed-tuning', turn: 1 });
  });

  it('one card per turn: a second card and a chip question beside it are refused', async () => {
    const { deps, port } = harness([
      res({ toolCalls: [tc('load_skill', { id: 'conversation/feed-tuning' })] }),
      res({
        content: 'Tap the card.',
        toolCalls: [tc('proposeChanges', MUTE), tc('proposeChanges', MUTE), tc('ask_choice', { question: 'Which?', options: ['a', 'b'] })],
      }),
    ]);
    const out = await runAgentTurn({ state: createAgentState(PERSONA), userMessage: 'mute the hindu', deps });

    expect(port.proposeChanges).toHaveBeenCalledTimes(1);
    const results = out.legs[1].toolResults.map((r) => r.result as Record<string, unknown>);
    expect(results[1].error).toMatch(/One card/);
    expect(results[2].error).toMatch(/card is already on screen/);
  });

  it('a refused card is not a card: the turn is not ended by it', async () => {
    const { deps } = harness(
      [
        res({ toolCalls: [tc('load_skill', { id: 'conversation/feed-tuning' })] }),
        res({ toolCalls: [tc('proposeChanges', MUTE)] }),
        res({ content: 'I could not find that outlet, so nothing changed.' }),
      ],
      { proposeChanges: async () => ({ error: 'no applicable actions' }) },
    );
    const state = createAgentState(PERSONA);
    const out = await runAgentTurn({ state, userMessage: 'mute the daily imaginary', deps });

    expect(out.terminalReason).toBe('settled');
    expect(out.reply).toBe('I could not find that outlet, so nothing changed.');
    expect(state.turn.lastCard).toBeNull();
  });

  it('a sentence beside the card claiming the change already happened is rewritten on one tool-free leg', async () => {
    const { deps, requests, port } = harness([
      res({ toolCalls: [tc('load_skill', { id: 'conversation/feed-tuning' })] }),
      res({ content: 'Done, I have muted The Hindu.', toolCalls: [tc('proposeChanges', MUTE)] }),
      res({ content: 'Tap the card to mute The Hindu.', toolCalls: [tc('proposeChanges', MUTE)] }),
    ]);
    const out = await runAgentTurn({ state: createAgentState(PERSONA), userMessage: 'mute the hindu', deps });

    expect(requests).toHaveLength(3);
    expect(names(requests[2])).toEqual([]);
    expect(requests[2].messages.map((m) => m.content).join('\n')).toContain('says the change already happened');
    expect(port.proposeChanges).toHaveBeenCalledTimes(1);
    expect(out.reply).toBe('Tap the card to mute The Hindu.');
    expect(out.replyRetries).toBe(1);
    expect(out.terminalReason).toBe('awaiting-user');
  });

  it('a true future sentence beside the card is not a claim', async () => {
    const { deps, requests } = harness([
      res({ toolCalls: [tc('load_skill', { id: 'conversation/feed-tuning' })] }),
      res({ content: 'Once you tap the card, The Hindu will be muted.', toolCalls: [tc('proposeChanges', MUTE)] }),
    ]);
    await runAgentTurn({ state: createAgentState(PERSONA), userMessage: 'mute the hindu', deps });
    expect(requests).toHaveLength(2);
  });
});

describe('answering a waiting card', () => {
  const pending = (appliable: boolean, chooseOne = false) => ({ id: 'p-1', summary: 'Mute The Hindu', chooseOne, appliable });

  it('the route leg carries apply and drop while the card is the newest ask, and an apply resumes the staging skill', async () => {
    const { deps, requests, port } = harness([
      res({ content: 'Okay.', toolCalls: [tc('applyProposal')] }),
      res({ content: 'I have muted The Hindu.' }),
    ]);
    const state = createAgentState(PERSONA);
    state.turn.lastCard = { proposalId: 'p-1', skill: 'conversation/feed-tuning', turn: 0 };
    state.pendingProposal = pending(true);

    const out = await runAgentTurn({ state, userMessage: 'ja, doe maar', deps });

    expect(names(requests[0])).toEqual(['load_skill', 'applyProposal', 'cancelProposal']);
    expect(stateOf(requests[0])).toContain('A card is waiting for the user: "Mute The Hindu"');
    expect(port.applyProposal).toHaveBeenCalledTimes(1);
    expect(requests[1].systemPrompt.startsWith('FEED TUNING BODY')).toBe(true);
    expect(stateOf(requests[1])).toContain('You applied the waiting card this turn');
    // The apply went through, so "I have muted" is true and is not re-asked.
    expect(out.replyRetries).toBe(0);
    expect(out.reply).toBe('I have muted The Hindu.');
  });

  it('a card only a tap applies offers no apply, and the line says to tap', async () => {
    const { deps, requests } = harness([
      res({ content: 'Tap the one you want on the card above.', toolCalls: [tc('load_skill', { id: 'conversation/feed-tuning' })] }),
      res({ content: 'Tap the one you want on the card above.' }),
    ]);
    const state = createAgentState(PERSONA);
    state.pendingProposal = pending(false, true);

    await runAgentTurn({ state, userMessage: 'the second one', deps });

    expect(names(requests[0])).toEqual(['load_skill', 'cancelProposal']);
    expect(names(requests[1])).toEqual(['proposeChanges', 'cancelProposal']);
    expect(stateOf(requests[1])).toContain('It offers options, and only a tap on the card applies it');
  });

  it('an apply the model calls anyway on a tap-only card is refused and applies nothing', async () => {
    const { deps, port } = harness([
      res({ toolCalls: [tc('load_skill', { id: 'conversation/feed-tuning' })] }),
      res({ toolCalls: [tc('applyProposal')] }),
      res({ content: 'Tap the one you want on the card above.' }),
    ]);
    const state = createAgentState(PERSONA);
    state.pendingProposal = pending(false, true);

    await runAgentTurn({ state, userMessage: 'yes', deps });
    expect(port.applyProposal).not.toHaveBeenCalled();
  });

  it('a chip question newer than the card wins: no card tools on the route leg, and the plain yes resumes its skill', async () => {
    const { deps, requests } = harness([res({ content: 'Offered.', toolCalls: [tc('saveExtractedFacts', { extracted_user_information: [{ statement: 'Plays chess' }] })] })]);
    const state = createAgentState(PERSONA);
    state.turn.turnNumber = 5;
    state.turn.lastCard = { proposalId: 'p-1', skill: 'conversation/feed-tuning', turn: 3 };
    state.turn.pendingChoice = { question: 'Chess as a player?', options: [{ text: 'a', payload: null }, { text: 'b', payload: null }] };
    state.turn.choiceTurn = 5;
    state.turn.lastQuestion = 'Shall I add chess?';
    state.turn.lastSkill = 'facts/interest';
    state.pendingProposal = pending(true);

    const out = await runAgentTurn({ state, userMessage: 'yes', deps });

    expect(out.typedYesResume).toBe(true);
    expect(names(requests[0])).not.toContain('applyProposal');
  });

  it('a card newer than the chip question takes the yes: the older question is not resumed', async () => {
    const { deps, requests } = harness([res({ content: 'Okay.', toolCalls: [tc('applyProposal')] }), res({ content: 'Muted.' })]);
    const state = createAgentState(PERSONA);
    state.turn.turnNumber = 5;
    state.turn.lastCard = { proposalId: 'p-1', skill: 'conversation/feed-tuning', turn: 5 };
    state.turn.pendingChoice = { question: 'Chess as a player?', options: [{ text: 'a', payload: null }, { text: 'b', payload: null }] };
    state.turn.choiceTurn = 4;
    state.turn.lastQuestion = 'Shall I add chess?';
    state.turn.lastSkill = 'facts/interest';
    state.pendingProposal = pending(true);

    const out = await runAgentTurn({ state, userMessage: 'yes', deps });

    expect(out.typedYesResume).toBe(false);
    expect(names(requests[0])).toContain('applyProposal');
  });

  it('a decline drops the card', async () => {
    const { deps, port } = harness([res({ toolCalls: [tc('cancelProposal')] }), res({ content: 'Left as it was.' })]);
    const state = createAgentState(PERSONA);
    state.turn.lastCard = { proposalId: 'p-1', skill: 'conversation/feed-tuning', turn: 0 };
    state.pendingProposal = pending(true);

    const out = await runAgentTurn({ state, userMessage: 'nee laat maar', deps });
    expect(port.cancelProposal).toHaveBeenCalledTimes(1);
    expect(out.reply).toBe('Left as it was.');
  });

  it('no card tools at all when the device offers none', async () => {
    const { deps, requests } = harness([res({ toolCalls: [tc('load_skill', { id: 'conversation/feed-tuning' })] }), res({ content: 'Sorry.' })], {
      proposeChanges: undefined, applyProposal: undefined, cancelProposal: undefined,
    });
    const state = createAgentState(PERSONA);
    state.pendingProposal = pending(true);
    await runAgentTurn({ state, userMessage: 'mute the hindu', deps });
    expect(names(requests[0])).toEqual(['load_skill']);
    expect(names(requests[1])).toEqual([]);
  });
});

describe('filters on card legs only', () => {
  it('lists the active filters with their ids on a feed-tuning leg and not on a question leg', async () => {
    const { deps, requests } = harness([
      res({ toolCalls: [tc('load_skill', { id: 'conversation/feed-tuning' })] }),
      res({ content: 'Tap the card.', toolCalls: [tc('proposeChanges', MUTE)] }),
    ]);
    const state = createAgentState(PERSONA);
    state.activeFilters = [{ id: 's1', pattern: 'crypto' }];
    await runAgentTurn({ state, userMessage: 'show me crypto again', deps });

    const text = (req: AgentModelRequest) => req.messages.map((m) => m.content).join('\n');
    expect(text(requests[0])).not.toContain('<filters>');
    expect(text(requests[1])).toContain('<filters>\n- [s1] crypto\n</filters>');
  });
});

describe('per-skill tools and thinking', () => {
  it('the generator\'s tool list and the payload order are one list', () => {
    expect([...KNOWN_SKILL_TOOLS]).toEqual([...SKILL_TOOL_ORDER]);
  });

  it('every shipped skill\'s tools: list gives exactly the payload the built-in rule gave', () => {
    for (const row of skillIndexRows()) {
      if (row.id === 'conversation/feed-tuning') continue;
      const opts = { skillLoaded: row.id, webSearch: true, explainMera: true, cards: true, pendingCard: { appliable: true } };
      const listed = toolsForLeg({ ...opts, skillTools: skillTools(row.id) }).map((t) => t.function.name);
      const fallback = toolsForLeg({ ...opts, skillTools: null }).map((t) => t.function.name);
      expect([row.id, listed]).toEqual([row.id, fallback]);
    }
  });

  it('feed-tuning carries the card tools and nothing that writes a fact', () => {
    const tools = toolsForLeg({ skillLoaded: 'conversation/feed-tuning', skillTools: skillTools('conversation/feed-tuning'), cards: true, pendingCard: { appliable: true } });
    expect(tools.map((t) => t.function.name)).toEqual(['proposeChanges', 'applyProposal', 'cancelProposal']);
  });

  it('no shipped skill runs thinking on, and the route leg never does', async () => {
    for (const row of skillIndexRows()) expect([row.id, skillThinking(row.id)]).toEqual([row.id, false]);
    const { deps, requests } = harness([res({ toolCalls: [tc('load_skill', { id: 'conversation/feed-tuning' })] }), res({ content: 'Hm.' })]);
    await runAgentTurn({ state: createAgentState(PERSONA), userMessage: 'x', deps });
    expect(requests.map((r) => r.enableThinking)).toEqual([false, false]);
  });
});

describe('the hideSkills arm (a step\'s control)', () => {
  it('drops the skill from the index and answers a load of it as unknown', async () => {
    registerAgentArm({ id: 'pre-cards', description: 'control', hideSkills: ['conversation/feed-tuning'] });
    expect(buildRouterPrompt({ surface: 'CONFIG', arm: 'pre-cards' })).not.toContain('conversation/feed-tuning');
    expect(buildRouterPrompt({ surface: 'CONFIG' })).toContain('conversation/feed-tuning');

    const { deps } = harness([
      res({ toolCalls: [tc('load_skill', { id: 'conversation/feed-tuning' })] }),
      res({ toolCalls: [tc('load_skill', { id: 'conversation/question' })] }),
      res({ content: 'Hi.' }),
    ]);
    const out = await runAgentTurn({ state: createAgentState(PERSONA), userMessage: 'mute x', deps, promptVariant: 'pre-cards' });
    expect(out.legs[0].toolResults[0].result).toMatchObject({ error: 'unknown skill id' });
    expect((out.legs[0].toolResults[0].result as { availableSkills: string[] }).availableSkills).not.toContain('conversation/feed-tuning');
  });

  it('routerBody replaces the shipped procedure', () => {
    registerAgentArm({ id: 'new-router', description: 'candidate', routerBody: 'NEW ROUTER PROCEDURE' });
    const prompt = buildRouterPrompt({ surface: 'CONFIG', arm: 'new-router' });
    expect(prompt).toContain('NEW ROUTER PROCEDURE');
    expect(prompt).not.toContain('## This turn, you are the router');
  });
});
