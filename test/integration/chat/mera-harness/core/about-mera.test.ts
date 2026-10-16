// hindifix A: a skill leg keeps the voice rules, and questions about Mera are
// answered from explainMera on their own skill. Driven through the real loop
// with a scripted model.

import { createAgentState, runAgentTurn, type AgentPersona } from '@/lib/mera-harness/core/core';
import { MULTI_SUBJECT_ARM_ID } from '@/lib/mera-harness/core/arms';
import { EXPLAIN_MERA_TOOL } from '@/lib/mera-harness/core/tool-contracts';
import { brandRule, fixBrandSpelling, voiceRules } from '@/lib/mera-harness/core/router-prompt';
import { leaksInternals } from '@/lib/mera-harness/core/prose';
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

// hindifix F: staging run 20261016-124*-hfE-after. About half the about-mera
// turns called explainMera AGAIN on the answer leg and the prose written beside
// that call became the reply ("I'll pull Mera's reference...", an echo of the
// question); the one answer leg that did not re-call wrote 43 tokens about
// divorce and credit after 3.7KB of English reference text, with the language
// rule buried above the tools block. Once the text has arrived, the next leg is
// the answer: no tools, and a note AFTER the result naming the language.
describe('hindifix F: the about-mera answer leg', () => {
  const ROUTE = res({ content: 'एक पल।', toolCalls: [tc('load_skill', { id: 'conversation/about-mera' })] });
  const SECTIONS = { sections: [{ topic: 'plans_and_limits', text: 'Starter includes 10 MB of cloud reading a day.' }] };
  const CALL = res({ content: 'एक पल।', toolCalls: [tc('explainMera', { topics: ['plans_and_limits'] })] });

  it('is tool-free and ends on a note naming the language and quoting the question', async () => {
    const explainMera = jest.fn(async () => SECTIONS);
    const h = harness([ROUTE, CALL, res({ content: 'स्टार्टर में रोज़ 10 MB मिलते हैं।' })], { explainMera });
    const out = await runAgentTurn({ state: createAgentState(HINDI), userMessage: 'मेरे प्लान में रोज़ कितना मिलता है?', deps: h.deps });
    expect(h.calls[1].tools).toContain('explainMera');
    expect(h.calls[2].tools).toEqual([]);
    const last = h.calls[2].messages[h.calls[2].messages.length - 1];
    expect(last.role).toBe('user');
    expect(last.content).toContain('Hindi');
    // Round 2: "Answer their message" after a tool result read as ambiguous and
    // two answers said the question was cut off. The note quotes it.
    expect(last.content).toContain('मेरे प्लान में रोज़ कितना मिलता है?');
    expect(last.content).toMatch(/only/i);
    expect(out.reply).toBe('स्टार्टर में रोज़ 10 MB मिलते हैं।');
  });

  it('without a language, the note says the language of their message', async () => {
    const h = harness([ROUTE, CALL, res({ content: 'Starter gives 10 MB a day.' })], { explainMera: async () => SECTIONS });
    await runAgentTurn({
      state: createAgentState({ surface: 'CONFIG', facts: [] }),
      userMessage: 'How much do I get a day?',
      deps: h.deps,
    });
    const last = h.calls[2].messages[h.calls[2].messages.length - 1];
    expect(last.content).toContain('the language of their message');
    // Round 1 told every reader "your answer is not [English]", and a Ghent
    // persona's English question was answered in Dutch.
    expect(last.content).not.toMatch(/answer is not/);
  });

  it('an English reader is not told to avoid English', async () => {
    const h = harness([ROUTE, CALL, res({ content: 'Starter gives 10 MB a day.' })], { explainMera: async () => SECTIONS });
    await runAgentTurn({ state: createAgentState({ surface: 'CONFIG', languageName: 'English', facts: [] }), userMessage: 'How much?', deps: h.deps });
    const last = h.calls[2].messages[h.calls[2].messages.length - 1];
    expect(last.content).toContain('in English');
    expect(last.content).not.toMatch(/answer is not/);
  });

  // Staging round 1: leg 1 echoed the question ("Can anyone read the app's
  // code?") and called nothing, and the echo shipped as the answer.
  it('prose before any explainMera call is re-asked once, never shipped', async () => {
    const explainMera = jest.fn(async () => SECTIONS);
    const h = harness(
      [ROUTE, res({ content: "Can anyone read the app's code?" }), CALL, res({ content: 'स्टार्टर में रोज़ 10 MB मिलते हैं।' })],
      { explainMera },
    );
    const out = await runAgentTurn({ state: createAgentState(HINDI), userMessage: 'प्लान?', deps: h.deps });
    expect(explainMera).toHaveBeenCalledTimes(1);
    expect(h.calls[2].messages.some((m) => /explainMera/.test(m.content) && m.role === 'user')).toBe(true);
    expect(out.reply).toBe('स्टार्टर में रोज़ 10 MB मिलते हैं।');
  });

  it('a call written on the answer leg is dropped and never becomes the reply', async () => {
    const explainMera = jest.fn(async () => SECTIONS);
    const h = harness(
      [
        ROUTE,
        CALL,
        res({ content: "I'll pull Mera's reference on how it works.", toolCalls: [tc('explainMera', { topics: ['what_is_mera'] })] }),
        res({ content: 'स्टार्टर में रोज़ 10 MB मिलते हैं।' }),
      ],
      { explainMera },
    );
    const out = await runAgentTurn({ state: createAgentState(HINDI), userMessage: 'मेरे प्लान में रोज़ कितना मिलता है?', deps: h.deps });
    expect(explainMera).toHaveBeenCalledTimes(1);
    expect(out.reply).not.toContain('pull');
  });

  it('an error result keeps explainMera offered for the retry the skill asks for', async () => {
    const h = harness(
      [ROUTE, CALL, res({ content: 'ठीक है।' })],
      { explainMera: async () => ({ error: 'Unknown topic(s): x', availableTopics: ['plans_and_limits'] }) },
    );
    await runAgentTurn({ state: createAgentState(HINDI), userMessage: 'प्लान?', deps: h.deps });
    expect(h.calls[2].tools).toContain('explainMera');
  });

  it('the Hindi brand line rides on skill legs only, positively worded, and never on the router', async () => {
    const h = harness([
      res({ content: 'ठीक है।', toolCalls: [tc('load_skill', { id: 'conversation/question' })] }),
      res({ content: 'नमस्ते।' }),
    ]);
    await runAgentTurn({ state: createAgentState(HINDI), userMessage: 'नमस्ते', deps: h.deps });
    expect(h.calls[0].systemPrompt).not.toContain('मेरा ऐप');
    expect(h.calls[1].systemPrompt).toContain('मेरा ऐप');
    // Round 2: naming the bad spellings in the rule primed them (4 of 9 vs 0).
    expect(h.calls[1].systemPrompt).not.toMatch(/मिरा|मीरा|मिस्टर/);
    expect(h.calls[1].systemPrompt).not.toMatch(/NAME[^\n]*[–—]/);
    expect(voiceRules('Hindi')).not.toContain('मेरा ऐप');
    expect(brandRule('English')).toBe('');
    expect(brandRule(undefined)).toBe('');
  });

  it('a misspelt Hindi brand is rewritten in the reply, unless the user wrote that word', async () => {
    const run = async (msg: string, answer: string) => {
      const h = harness([ROUTE, CALL, res({ content: answer })], { explainMera: async () => SECTIONS });
      return (await runAgentTurn({ state: createAgentState(HINDI), userMessage: msg, deps: h.deps })).reply;
    };
    expect(await run('प्लान?', 'मिरा ऐप में रोज़ 10 MB मिलते हैं।')).toBe('मेरा ऐप में रोज़ 10 MB मिलते हैं।');
    expect(await run('प्लान?', 'मीरा एक न्यूज़ असिस्टेंट है।')).toBe('मेरा ऐप एक न्यूज़ असिस्टेंट है।');
    expect(await run('प्लान?', 'मैरा और मर्रा।')).toBe('मेरा ऐप और मेरा ऐप।');
    expect(await run('प्लान?', 'मिराज नहीं।')).toBe('मिराज नहीं।');
    // A person's name the user typed stays.
    expect(await run('मेरी बेटी मीरा क्या पढ़े?', 'मीरा के लिए 10 MB।')).toBe('मीरा के लिए 10 MB।');
    expect(fixBrandSpelling('Mira reads it.', 'English', '')).toBe('Mira reads it.');
  });
});

// hindifix F: the staging Delhi turn (run 20261016-124853-hfE-after) shipped
// "This is a move. Same key, different place (Delhi vs Jaipur). Set replaces
// to h." as the reply and `replyLeakUnfixed` was false: the model narrated its
// own tool arguments and the leak check knew only tool NAMES and snake_case keys.
describe('hindifix F: narrated tool arguments are a leak', () => {
  const DELHI = 'This is a move. Same key, different place (Delhi vs Jaipur). Set replaces to h.';
  const JAIPUR: AgentPersona = {
    surface: 'CONFIG',
    languageName: 'Hindi',
    facts: [{
      id: 'h',
      statement: 'Lives in Jaipur, Rajasthan, India, Asia',
      attribute: 'location: neighborhood/area, city, and country (preserve specifics)',
    }],
  };
  const DELHI_PLACE: Place = { locality: 'Delhi', admin1: 'Delhi', countryCode: 'IN', countryName: 'India', bloc: 'Asia' };

  it('the detector fires on the exact staging reply and its shapes', () => {
    expect(leaksInternals(DELHI)).toBe(true);
    expect(leaksInternals('Set key to location.')).toBe(true);
    expect(leaksInternals('Same attribute key, so it replaces: h')).toBe(true);
    expect(leaksInternals('I will run webSearch for that.')).toBe(true);
    // Ordinary sentences with the same words stay clean.
    expect(leaksInternals('Delhi replaces your Jaipur home. Tap the card to confirm.')).toBe(false);
    expect(leaksInternals('The key change is that the plan is free.')).toBe(false);
    expect(leaksInternals('You can set alerts to daily in the app.')).toBe(false);
  });

  function replay(over: AgentModelResult[]) {
    return harness(
      [
        res({ content: 'Got it, you live in Delhi.', toolCalls: [tc('load_skill', { id: 'facts/residence' })] }),
        res({ content: '', toolCalls: [tc('lookup_place', { query: 'Delhi' }), tc('find_similar_facts', { kind: 'residence' })] }),
        ...over,
      ],
      {
        lookupPlace: async () => ({ status: 'resolved', places: [DELHI_PLACE] }),
        findSimilarFacts: async () => ({
          candidates: [{ factId: 'h', statement: JAIPUR.facts[0].statement, attribute: JAIPUR.facts[0].attribute ?? null, overlap: 1 }],
        }),
      },
    );
  }

  it('replayed beside the card, the narration is dropped and counted', async () => {
    const save = tc('saveExtractedFacts', {
      extracted_user_information: [{
        statement: 'Lives in Delhi, Delhi, India, Asia',
        questionnaire_attribute: 'location: neighborhood/area, city, and country (preserve specifics)',
        replaces: 'h',
      }],
    });
    const h = replay([res({ content: DELHI, toolCalls: [save] }), res({ content: DELHI }), res({ content: DELHI })]);
    const out = await runAgentTurn({ state: createAgentState(JAIPUR), userMessage: 'मैं दिल्ली में रहता हूँ', deps: h.deps });
    expect(out.proposals.length).toBeGreaterThan(0);
    expect(out.reply).toBe('');
    expect(out.replyLeakUnfixed).toBe(true);
  });

  it('replayed with no card, the narration is replaced by the fallback line', async () => {
    const h = harness(
      [res({ content: 'ठीक है।', toolCalls: [tc('load_skill', { id: 'conversation/question' })] }), res({ content: DELHI }), res({ content: DELHI })],
    );
    const out = await runAgentTurn({ state: createAgentState(JAIPUR), userMessage: 'मेरे बारे में?', deps: h.deps });
    expect(out.reply).not.toBe(DELHI);
    expect(out.reply.length).toBeGreaterThan(0);
    expect(out.replyLeakUnfixed).toBe(true);
  });
});
