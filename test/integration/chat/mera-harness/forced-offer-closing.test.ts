// The forcedOfferClosing arm (E2EE tool steps item 11), driven through the real loop with
// a scripted model. The arm is OFF in production: this proves the wiring for when it flips,
// and that off is byte-identical to baseline.
import fs from 'node:fs';
import path from 'node:path';
import {
  MAX_AGENT_LEGS,
  createAgentState,
  runAgentTurn,
  type AgentPersona,
} from '@/lib/mera-harness/core/core';
import { resetAgentArmsForTest } from '@/lib/mera-harness/core/arms';
import { claimsSaveHappened } from '@/lib/mera-harness/core/prose';
import type { AgentDeps, AgentModelResult } from '@/lib/mera-harness/core/types';
import { ensureForcedOfferClosingArms } from '@/lib/mera-harness/eval/forced-offer-closing';

// CLOSING_LINE_NOTE is not exported; its tail is matched, and proven to be in core.ts below.
const CLOSING_NOTE_MARK = 'Write ONE short sentence to the user about what you offered';

const mr = (over: Partial<AgentModelResult> = {}): AgentModelResult => ({
  content: '', toolCalls: [], finishReason: 'stop', truncated: false, usage: null,
  modelSent: 'fake', latencyMs: 1, error: null, ...over,
});
const tc = (name: string, args: unknown) => ({ name, argumentsRaw: JSON.stringify(args) });
const SAVE = tc('saveExtractedFacts', { extracted_user_information: [{ statement: 'Plays chess' }] });

const PERSONA: AgentPersona = {
  surface: 'CONFIG',
  languageName: 'English',
  facts: [{ id: 'f1', statement: 'Lives in Amsterdam', attribute: 'location: residence' }],
};
const SKILLS: Record<string, string> = {
  'facts/interest': 'INTEREST SKILL BODY',
  'facts/residence': 'RESIDENCE SKILL BODY',
  'conversation/question': 'QUESTION SKILL BODY',
};

interface Rec { i: number; role: string; tools: string[]; toolChoice: string | undefined; messages: unknown }

const toolName = (t: unknown): string =>
  (t as { function?: { name?: string }; name?: string }).function?.name ?? (t as { name?: string }).name ?? '?';

/** Legs 0..3 are fixed: route (facts/interest), two non-proposing lookups, then the forced
 *  leg (index MAX_AGENT_LEGS-1). `tail` scripts any leg after it. */
async function run(variant: string | undefined, forcedLeg: AgentModelResult, tail: AgentModelResult[]) {
  const script = [
    mr({ content: 'One moment.', toolCalls: [tc('load_skill', { id: 'facts/interest' })] }),
    mr({ toolCalls: [tc('find_similar_facts', { kind: 'interest' })] }),
    mr({ toolCalls: [tc('find_similar_facts', { kind: 'hobby' })] }),
    forcedLeg,
    ...tail,
  ];
  const reqs: Rec[] = [];
  let saves = 0;
  const deps: AgentDeps = {
    callModel: async (req) => {
      const i = reqs.length;
      reqs.push({
        i,
        role: req.role,
        tools: ((req.tools ?? []) as unknown[]).map(toolName),
        toolChoice: req.toolChoice,
        messages: req.messages,
      });
      if (i >= script.length) throw new Error(`UNSCRIPTED request #${i} (loop not bounded)`);
      return script[i];
    },
    tools: {
      findSimilarFacts: async () => ({ candidates: [] }),
      lookupPlace: async () => ({ status: 'no_match', places: [] } as never),
      saveExtractedFacts: async (args) => {
        saves++;
        return { staged: true, pendingFacts: args.extracted_user_information };
      },
      deleteUserFacts: async () => ({ deleted: [] }),
    },
    loadSkill: (id) => SKILLS[id] ?? null,
    skillIds: () => Object.keys(SKILLS),
  };
  const out = await runAgentTurn({
    state: createAgentState(PERSONA),
    userMessage: 'I enjoy playing chess',
    deps,
    promptVariant: variant,
  });
  return { out, reqs, saves: () => saves };
}

type R = Awaited<ReturnType<typeof run>>;

const lastUser = (q: Rec): string => {
  const users = (q.messages as { role: string; content: string }[]).filter((m) => m.role === 'user');
  return users[users.length - 1]?.content ?? '';
};
const statements = (r: R) => r.out.proposals.map((p) => p.statement);

function assertPrefix(r: R) {
  expect(MAX_AGENT_LEGS).toBe(4);
  expect(r.reqs[0].role).toBe('route');
  expect(r.reqs[3].toolChoice).toBe('required');
  expect([...r.reqs[3].tools].sort()).toEqual(['ask_choice', 'saveExtractedFacts']);
}

function assertCase1(r: R) {
  assertPrefix(r);
  expect(r.reqs).toHaveLength(5);
  const c = r.reqs[4];
  expect(c.tools).toEqual([]);
  expect(c.toolChoice).not.toBe('required');
  expect(lastUser(c)).toContain(CLOSING_NOTE_MARK);
  expect(r.out.reply).toBe('Tap the card if you want me to add chess to your interests.');
  expect(r.out.terminalReason).toBe('settled');
  expect(statements(r)).toEqual(['Plays chess']);
  expect(r.saves()).toBe(1);
}

const SILENT_FORCED = mr({ content: '', toolCalls: [SAVE] });
const CLOSING_PROSE = mr({ content: 'Tap the card if you want me to add chess to your interests.' });

describe('forcedOfferClosing arm', () => {
  beforeAll(() => ensureForcedOfferClosingArms());
  afterAll(() => resetAgentArmsForTest());

  it('matches a closing note that really is in core.ts', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../../../lib/mera-harness/core/core.ts'), 'utf8');
    expect(src).toContain(CLOSING_NOTE_MARK);
  });

  it('arm on: a silent forced offer gets exactly one tool-free closing leg, note last', async () => {
    assertCase1(await run('forced-offer-closing', SILENT_FORCED, [CLOSING_PROSE]));
  });

  it('the twin arm behaves identically', async () => {
    assertCase1(await run('forced-offer-closing-twin', SILENT_FORCED, [CLOSING_PROSE]));
  });

  it('baseline: no request after the forced leg, empty reply', async () => {
    const r = await run('baseline', SILENT_FORCED, [CLOSING_PROSE]);
    assertPrefix(r);
    expect(r.reqs).toHaveLength(4);
    expect(r.out.reply).toBe('');
    expect(r.out.terminalReason).toBe('settled');
    expect(r.saves()).toBe(1);
  });

  it('arm on: a call written on the closing leg is dropped', async () => {
    const r = await run('forced-offer-closing', SILENT_FORCED, [
      mr({
        content: 'Tap the card to add chess.',
        toolCalls: [tc('saveExtractedFacts', { extracted_user_information: [{ statement: 'Plays chess often' }] })],
      }),
    ]);
    assertPrefix(r);
    expect(r.reqs).toHaveLength(5);
    expect(r.saves()).toBe(1);
    expect(statements(r)).toEqual(['Plays chess']);
    expect(r.out.legs[4].toolCalls).toEqual([]);
    expect(r.out.reply).toBe('Tap the card to add chess.');
    expect(r.out.terminalReason).toBe('settled');
  });

  it('arm on: an empty closing leg ends the turn', async () => {
    const r = await run('forced-offer-closing', SILENT_FORCED, [mr({ content: '' })]);
    assertPrefix(r);
    expect(r.reqs).toHaveLength(5);
    expect(r.out.reply).toBe('');
    expect(r.saves()).toBe(1);
    expect(r.out.terminalReason).toBe('settled');
  });

  it('arm on: a forced leg that already has prose gets no closing leg', async () => {
    const r = await run('forced-offer-closing', mr({ content: 'Tap the card to add chess.', toolCalls: [SAVE] }), [CLOSING_PROSE]);
    assertPrefix(r);
    expect(r.reqs).toHaveLength(4);
    expect(r.out.reply).toBe('Tap the card to add chess.');
    expect(r.out.terminalReason).toBe('settled');
  });

  describe('arm on: a save claim on the closing leg', () => {
    const claim = "I've saved that for you.";
    const rerun = () =>
      run('forced-offer-closing', SILENT_FORCED, [
        mr({ content: claim }),
        mr({ content: 'Tap the card if you want chess added.' }),
        mr({ content: 'EXTRA LEG 3' }),
      ]);

    it('the claim is a save claim', () => {
      expect(claimsSaveHappened(claim)).toBe(true);
    });

    it('is re-asked ONCE, the re-ask is still tool-free, and the turn settles on the second prose', async () => {
      const r = await rerun();
      assertPrefix(r);
      expect(r.reqs).toHaveLength(6);
      for (const q of r.reqs.slice(4)) {
        expect(q.tools).toEqual([]);
        expect(q.toolChoice).not.toBe('required');
      }
      expect(r.out.reply).toBe('Tap the card if you want chess added.');
      expect(r.out.terminalReason).toBe('settled');
      expect(r.saves()).toBe(1);
    });
  });

  it('arm off is byte-identical to baseline', async () => {
    const wire = (r: R) => r.reqs.map(({ role, tools, toolChoice, messages }) => ({ role, tools, toolChoice, messages }));
    const off = await run(undefined, SILENT_FORCED, [CLOSING_PROSE]);
    const base = await run('baseline', SILENT_FORCED, [CLOSING_PROSE]);
    expect(wire(off)).toEqual(wire(base));
    expect(off.reqs).toHaveLength(4);
    expect(off.out.reply).toBe(base.out.reply);
  });

  it('NEGATIVE CONTROL: the arm-on assertions fail against baseline', async () => {
    const r = await run('baseline', SILENT_FORCED, [CLOSING_PROSE]);
    expect(() => assertCase1(r)).toThrow();
  });
});
