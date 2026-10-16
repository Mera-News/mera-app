// hindifix A: a skill leg keeps the voice rules, and questions about Mera are
// answered from explainMera on their own skill. Driven through the real loop
// with a scripted model.

import { createAgentState, runAgentTurn, type AgentPersona } from '@/lib/mera-harness/core/core';
import { MULTI_SUBJECT_ARM_ID } from '@/lib/mera-harness/core/arms';
import { EXPLAIN_MERA_TOOL } from '@/lib/mera-harness/core/tool-contracts';
import { loadSkill, renderSkillIndex, skillIds } from '@/lib/mera-harness/core/skill-loader';
import { PERSONA_SKILL_INDEX } from '@/lib/mera-harness/skills/index.generated';
import type { AgentDeps, AgentModelResult, Place } from '@/lib/mera-harness/core/types';
import { MERA_EXPLAINER_TOPIC_IDS } from '@/lib/news-harness/persona-management/persona-agent-core';

const AMS: Place = {
  locality: 'Amsterdam', admin1: 'North Holland', countryCode: 'NL', countryName: 'Netherlands', bloc: 'EU',
};

function res(over: Partial<AgentModelResult> = {}): AgentModelResult {
  return {
    content: '', toolCalls: [], finishReason: 'stop', truncated: false,
    usage: null, modelSent: 'fake', latencyMs: 1, error: null, ...over,
  };
}
const tc = (name: string, args: unknown) => ({ name, argumentsRaw: JSON.stringify(args) });

const SKILLS: Record<string, string> = {
  'facts/residence': 'RESIDENCE SKILL BODY',
  'facts/interest': 'INTEREST SKILL BODY',
  'facts/profession': 'PROFESSION SKILL BODY',
  'conversation/question': 'QUESTION SKILL BODY',
  'conversation/about-mera': 'ABOUT MERA SKILL BODY',
};

interface Call {
  systemPrompt: string;
  tools: string[];
  messages: { role: string; content: string }[];
}

function harness(script: AgentModelResult[], over: Partial<AgentDeps['tools']> = {}) {
  const calls: Call[] = [];
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
      lookupPlace: async () => ({ status: 'resolved', places: [AMS] }),
      saveExtractedFacts: async () => ({ staged: true }),
      deleteUserFacts: async () => ({ deleted: [] }),
      ...over,
    },
    loadSkill: (id) => SKILLS[id] ?? null,
    skillIds: () => Object.keys(SKILLS),
  };
  return { deps, calls };
}

const HINDI: AgentPersona = { surface: 'ONBOARDING', languageName: 'Hindi', facts: [] };

describe('the voice rules reach every skill leg', () => {
  // A loaded body REPLACED the router prompt, the only place the language rule
  // lived, so every reply written on a skill leg had no language instruction.
  it('a load_skill leg carries the body AND the language', async () => {
    const h = harness([
      res({ content: 'ठीक है।', toolCalls: [tc('load_skill', { id: 'conversation/question' })] }),
      res({ content: 'नमस्ते।' }),
    ]);
    await runAgentTurn({ state: createAgentState(HINDI), userMessage: 'नमस्ते', deps: h.deps });
    expect(h.calls[1].systemPrompt.startsWith('QUESTION SKILL BODY')).toBe(true);
    expect(h.calls[1].systemPrompt).toContain('Hindi');
    expect(h.calls[1].systemPrompt).toContain('PUNCTUATION');
  });

  it('a resumed skill leg carries the language too', async () => {
    const state = createAgentState(HINDI);
    state.turn.lastQuestion = 'Want me to add the Champions League?';
    state.turn.lastSkill = 'facts/interest';
    const h = harness([res({ content: 'ठीक है।' })]);
    await runAgentTurn({ state, userMessage: 'No thanks', deps: h.deps });
    expect(h.calls[0].systemPrompt.startsWith('INTEREST SKILL BODY')).toBe(true);
    expect(h.calls[0].systemPrompt).toContain('Hindi');
  });

  it('the next segment of a multi-subject turn carries the language too', async () => {
    const h = harness([
      res({
        content: 'बर्लिन।',
        toolCalls: [tc('load_skill', { id: 'facts/residence' }), tc('load_skill', { id: 'facts/profession' })],
      }),
      res({ content: 'ठीक है।' }),
      res({ content: 'ठीक है।' }),
    ]);
    await runAgentTurn({
      state: createAgentState(HINDI),
      userMessage: 'PM in Berlin',
      deps: h.deps,
      promptVariant: MULTI_SUBJECT_ARM_ID,
    });
    const prof = h.calls.find((c) => c.systemPrompt.startsWith('PROFESSION SKILL BODY'));
    expect(prof).toBeDefined();
    expect(prof!.systemPrompt).toContain('Hindi');
  });
});

describe('conversation/about-mera answers from explainMera', () => {
  const NOBODY: AgentPersona = { surface: 'CONFIG', languageName: 'English', facts: [] };
  const ROUTE = res({ content: 'One moment.', toolCalls: [tc('load_skill', { id: 'conversation/about-mera' })] });
  // Longer than the generic 4,000-character tool-result cap: three explainer
  // sections are, and leg 2 answers only from what arrives.
  const LONG = `${'x'.repeat(5000)} THE TAIL OF THE SECTION`;

  it('declares explainMera, runs the port, and the next leg reads the whole result', async () => {
    const explainMera = jest.fn(async () => ({ sections: [{ topic: 'privacy_what_we_store', text: LONG }] }));
    const h = harness(
      [
        ROUTE,
        res({ content: 'Let me get that.', toolCalls: [tc('explainMera', { topics: ['privacy_what_we_store'] })] }),
        res({ content: 'Mera keeps very little about you.' }),
      ],
      { explainMera },
    );
    const out = await runAgentTurn({ state: createAgentState(NOBODY), userMessage: 'How does Mera handle my data?', deps: h.deps });
    expect(h.calls[0].tools).not.toContain('explainMera');
    expect(h.calls[1].tools).toContain('explainMera');
    expect(h.calls[1].tools).not.toContain('webSearch');
    expect(explainMera).toHaveBeenCalledWith({ topics: ['privacy_what_we_store'] });
    const toolMsg = h.calls[2].messages.find((m) => m.content.startsWith('explainMera:'));
    expect(toolMsg?.content).toContain('THE TAIL OF THE SECTION');
    expect(out.reply).toBe('Mera keeps very little about you.');
    expect(out.unknownTools).toEqual([]);
  });

  // An answer about what Mera stores is full of "saved" and "kept"; read as a
  // save claim it was re-asked, pushing the model to drop the storage facts
  // the person asked about. Nothing can be proposed on this skill.
  it('an answer about what Mera keeps is not treated as a save claim', async () => {
    const answer = 'Everything you tell me is saved on your phone only. Mera\'s servers keep your email and a daily reading record for 90 days.';
    const h = harness(
      [
        ROUTE,
        res({ content: 'One moment.', toolCalls: [tc('explainMera', { topics: ['privacy_what_we_store'] })] }),
        res({ content: answer }),
      ],
      { explainMera: async () => ({ sections: [{ topic: 'privacy_what_we_store', text: 'x' }] }) },
    );
    const out = await runAgentTurn({ state: createAgentState(NOBODY), userMessage: 'What do you store?', deps: h.deps });
    expect(h.calls).toHaveLength(3);
    expect(out.reply).toBe(answer);
  });

  it('is not declared when the port has no explainMera', async () => {
    const h = harness([ROUTE, res({ content: 'Mera keeps very little.' })]);
    await runAgentTurn({ state: createAgentState(NOBODY), userMessage: 'How does Mera work?', deps: h.deps });
    expect(h.calls[1].tools).not.toContain('explainMera');
  });

  it('is not declared on conversation/question or on a facts skill', async () => {
    const explainMera = jest.fn(async () => ({ sections: [] }));
    for (const id of ['conversation/question', 'facts/interest']) {
      const h = harness(
        [res({ content: 'Sure.', toolCalls: [tc('load_skill', { id })] }), res({ content: 'Done.' })],
        { explainMera },
      );
      await runAgentTurn({ state: createAgentState(NOBODY), userMessage: 'I like chess', deps: h.deps });
      expect(h.calls[1].tools).not.toContain('explainMera');
    }
    expect(explainMera).not.toHaveBeenCalled();
  });

  it('the harness tool names exactly the explainer topic ids', () => {
    const desc = EXPLAIN_MERA_TOOL.function.parameters as unknown as { properties: { topics: { items: { enum: string[] } } } };
    expect([...desc.properties.topics.items.enum]).toEqual([...MERA_EXPLAINER_TOPIC_IDS]);
    expect(JSON.stringify(EXPLAIN_MERA_TOOL)).not.toMatch(/[–—]/);
  });

  it('the skill exists, is routable and is in the router index', () => {
    expect(skillIds()).toContain('conversation/about-mera');
    expect(loadSkill('conversation/about-mera')).toContain('explainMera');
    expect(PERSONA_SKILL_INDEX.find((e) => e.id === 'conversation/about-mera')?.routable).toBe(true);
    expect(renderSkillIndex()).toContain('conversation/about-mera');
    expect(loadSkill('router')).toContain('conversation/about-mera');
    expect(loadSkill('conversation/question')).not.toContain('Learn about Mera');
  });
});
