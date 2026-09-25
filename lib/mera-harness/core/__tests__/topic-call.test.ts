import {
  MAX_TOPICS_PER_FACT,
  buildTopicUserMessage,
  generateTopicsForFact,
  parseTopics,
  parseTopicsDetailed,
  topicSkillForAttribute,
} from '../topic-call';
import type { AgentModelResult } from '../types';

function res(content: string): AgentModelResult {
  return {
    content, toolCalls: [], finishReason: 'stop', truncated: false,
    usage: null, modelSent: 'fake', latencyMs: 1, error: null,
  };
}

type Req = { systemPrompt: string; role: string; enableThinking: boolean; maxTokens: number; messages: { content: string }[] };

function depsReturning(content: string) {
  const callModel = jest.fn(async (_req: Req) => res(content));
  return { callModel, loadSkill: (id: string) => `SKILL:${id}` };
}

const FACT = { statement: 'Lives in Alkmaar, North Holland, Netherlands', questionnaireAttribute: 'location: residence' };

describe('the terminal topic call', () => {
  it('uses the composed guideline for the kind chosen UPSTREAM as the whole system prompt', async () => {
    const deps = depsReturning('["Alkmaar housing", "Netherlands rail strikes"]');
    await generateTopicsForFact({ fact: FACT, skillId: 'topics/residence', deps });
    const req = deps.callModel.mock.calls[0][0];
    expect(req.systemPrompt).toBe('SKILL:topics/residence');
    expect(req.role).toBe('topicgen');
    // Thinking OFF, measured: ON returned empty content on 8 of 10 probes.
    expect(req.enableThinking).toBe(false);
    expect(req.maxTokens).toBe(600);
  });

  it('an UNKNOWN skillId falls back to the group generic rather than failing', async () => {
    // inference_jobs is durable: a job enqueued before an OTA outlives the
    // build that named its skill.
    const deps = { callModel: jest.fn(async (_req: Req) => res('["x y"]')), loadSkill: (id: string) => (id === 'topics/generic' ? 'GENERIC' : null) };
    const out = await generateTopicsForFact({ fact: FACT, skillId: 'topics/from-the-future', deps });
    const req = deps.callModel.mock.calls[0][0];
    expect(req.systemPrompt).toBe('GENERIC');
    expect(out.topics).toEqual(['x y']);
  });

  it('a MISSING skillId also falls back, with no throw', async () => {
    const deps = { callModel: jest.fn(async (_req: Req) => res('["x y"]')), loadSkill: (id: string) => (id === 'topics/generic' ? 'GENERIC' : null) };
    await expect(generateTopicsForFact({ fact: FACT, deps })).resolves.toBeDefined();
  });
});

describe('exclusions reach the prompt', () => {
  it('existing AND declined texts both land in the exclusion block', async () => {
    const deps = depsReturning('[]');
    await generateTopicsForFact({
      fact: FACT,
      skillId: 'topics/residence',
      existingTopics: ['Alkmaar hospital news', 'Netherlands energy prices'],
      declinedTopics: ['Alkmaar weather', 'Dutch football'],
      deps,
    });
    const req = deps.callModel.mock.calls[0][0];
    const body = req.messages[0].content;
    for (const t of ['Alkmaar hospital news', 'Netherlands energy prices', 'Alkmaar weather', 'Dutch football']) {
      expect(body).toContain(t);
    }
  });

  it('emits NO exclusion block when there is nothing to exclude', () => {
    const msg = buildTopicUserMessage({ fact: FACT, deps: { callModel: jest.fn() } } as never);
    expect(msg).not.toContain('Do NOT repeat');
  });
});

// A non-residence guideline, so the residence place-term guarantee (tested on
// its own below) does not add a topic to what these cases count.
const VETO_SKILL = 'topics/interest';

describe('THE VETO: the database is advisory, this is the guarantee', () => {
  it('a declined text the model returns ANYWAY never reaches the caller', async () => {
    // The failure this guards is precisely "the model ignored the prompt":
    // shown an exclude list it still returns an existing topic with a scope
    // word bolted on.
    const deps = depsReturning('["Alkmaar weather", "Alkmaar housing pressure"]');
    const out = await generateTopicsForFact({
      fact: FACT,
      skillId: VETO_SKILL,
      declinedTopics: ['Alkmaar weather'],
      deps,
    });
    expect(out.topics).toEqual(['Alkmaar housing pressure']);
    expect(out.dropped.veto).toBe(1);
  });

  it('matches on NORMALISED form, or the veto silently passes everything', async () => {
    const deps = depsReturning('["  ALKMAAR   Weather  "]');
    const out = await generateTopicsForFact({
      fact: FACT, skillId: VETO_SKILL, declinedTopics: ['alkmaar weather'], deps,
    });
    expect(out.topics).toEqual([]);
    expect(out.dropped.veto).toBe(1);
  });

  it('reports veto and filter drops SEPARATELY so "done with zero" is explainable', async () => {
    const deps = depsReturning('["Alkmaar weather", "Rotterdam port logistics", "Rotterdam logistics port"]');
    const out = await generateTopicsForFact({
      fact: FACT, skillId: VETO_SKILL, declinedTopics: ['Alkmaar weather'], deps,
    });
    expect(out.dropped).toEqual({ veto: 1, filter: 1 });
    expect(out.topics).toEqual(['Rotterdam port logistics']);
    expect(out.filterDrops[0].duplicateOf).toBe('Rotterdam port logistics');
  });
});

describe('ceiling and parsing', () => {
  it('caps at MAX_TOPICS_PER_FACT and nowhere lower', async () => {
    const many = Array.from({ length: 20 }, (_, i) => `subject${i} news item`);
    const out = await generateTopicsForFact({
      fact: FACT, skillId: VETO_SKILL, deps: depsReturning(JSON.stringify(many)),
    });
    expect(out.topics).toHaveLength(MAX_TOPICS_PER_FACT);
  });

  it('honours a skill body asking for 10 without clamping to something smaller', async () => {
    const ten = Array.from({ length: 10 }, (_, i) => `distinct${i} subject here`);
    const out = await generateTopicsForFact({
      fact: FACT, skillId: VETO_SKILL, deps: depsReturning(JSON.stringify(ten)),
    });
    expect(out.topics).toHaveLength(10);
  });

  it('the dedupe arm can be switched OFF for measurement', async () => {
    const dup = '["Rotterdam port logistics", "Rotterdam logistics port"]';
    const on = await generateTopicsForFact({ fact: FACT, deps: depsReturning(dup) });
    const off = await generateTopicsForFact({ fact: FACT, deps: depsReturning(dup), dedupe: 'off' });
    expect(on.topics).toHaveLength(1);
    expect(off.topics).toHaveLength(2);
  });

  it('recovers a JSON array embedded in prose, and returns [] on junk', () => {
    expect(parseTopics('Sure! ["a b", "c d"] hope that helps')).toEqual(['a b', 'c d']);
    expect(parseTopics('no json at all')).toEqual([]);
    expect(parseTopics('')).toEqual([]);
  });
});

describe('decoding, with the discipline the scoring decoder uses', () => {
  it('a BARE array parses and is not flagged as prose-wrapped', () => {
    const d = parseTopicsDetailed('["a b", "c d"]');
    expect(d.topics).toEqual(['a b', 'c d']);
    expect(d.proseAroundArray).toBe(false);
  });

  it('recovers an array WRAPPED IN PROSE and flags it', () => {
    // 42% of skill-arm rows looked like this and the old decoder scored them
    // as no usable set.
    const d = parseTopicsDetailed(
      'Let me think about the ladder first.\n\nHere are the topics:\n["Alkmaar housing", "Spain rail strikes"]\n\nThat covers both rungs.',
    );
    expect(d.topics).toEqual(['Alkmaar housing', 'Spain rail strikes']);
    expect(d.proseAroundArray).toBe(true);
  });

  it('takes the LAST array, not the first, when the model reasons out loud', () => {
    // The old non-greedy regex matched the FIRST bracket run and returned the
    // model's scratch list as if it were the answer.
    const d = parseTopicsDetailed(
      'I considered ["Alkmaar", "Hoorn"] but settled on ["Alkmaar housing", "Alkmaar transport"]',
    );
    expect(d.topics).toEqual(['Alkmaar housing', 'Alkmaar transport']);
  });

  it('FAILS CLOSED on a truncated array rather than returning a partial set', () => {
    const d = parseTopicsDetailed('Here they are:\n["Alkmaar housing", "Spain rail str');
    expect(d.topics).toEqual([]);
    expect(d.proseAroundArray).toBe(false);
  });

  it('a bracket INSIDE a topic string does not unbalance the scan', () => {
    const d = parseTopicsDetailed('Answer: ["housing [draft] rules", "rail strikes"]');
    expect(d.topics).toEqual(['housing [draft] rules', 'rail strikes']);
  });

  it('surfaces proseAroundArray on the outcome so P6 can count it', async () => {
    const deps = depsReturning('Thinking...\n["Alkmaar housing"]');
    const out = await generateTopicsForFact({ fact: FACT, skillId: 'topics/residence', deps });
    expect(out.proseAroundArray).toBe(true);
    expect(out.topics).toEqual(['Alkmaar housing']);
  });
});

describe('ux2 F1: isolated per fact', () => {
  it('the prompt carries this fact only, never other facts or a location line', async () => {
    const deps = depsReturning('["a"]');
    await generateTopicsForFact({
      fact: FACT,
      skillId: 'topics/residence',
      // A caller that still passes other facts must not reach the prompt.
      ...({ otherFacts: ['Works as a nurse', 'From India'] } as object),
      deps,
    });
    const msg = deps.callModel.mock.calls[0][0].messages[0].content;
    expect(msg).not.toMatch(/Other user facts|nurse|India|User location/);
    expect(msg).toContain('Alkmaar');
  });

  it('picks the topic guideline from the attribute when the caller named none', () => {
    expect(topicSkillForAttribute('location: neighborhood/area, city, and country (preserve specifics)')).toBe('topics/residence');
    expect(topicSkillForAttribute('background: country of origin')).toBe('topics/origin');
    expect(topicSkillForAttribute('profession: job role and industry')).toBe('topics/profession');
    expect(topicSkillForAttribute('family: parents location')).toBe('topics/family');
    expect(topicSkillForAttribute('teams_following')).toBe('topics/interest');
    expect(topicSkillForAttribute(null)).toBe('topics/generic');
    expect(topicSkillForAttribute('something else')).toBe('topics/generic');
  });

  it('a residence fact always gets a topic in the user\'s own place term', async () => {
    const deps = depsReturning('["Vila Baleira safety", "Madeira ferry strikes"]');
    const out = await generateTopicsForFact({
      fact: { statement: 'Lives in Porto Santo (Vila Baleira), Madeira, Portugal, EU' },
      skillId: 'topics/residence',
      deps,
    });
    expect(out.topics.some((t) => t.includes('Porto Santo'))).toBe(true);
  });

  it('adds nothing when a topic already names the user\'s term', async () => {
    const deps = depsReturning('["Porto Santo ferry"]');
    const out = await generateTopicsForFact({
      fact: { statement: "Girlfriend's parents live in Porto Santo (Vila Baleira), Madeira, Portugal, EU" },
      skillId: 'topics/family',
      deps,
    });
    expect(out.topics).toEqual(['Porto Santo ferry']);
  });
});
