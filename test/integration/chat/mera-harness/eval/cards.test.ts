// onemera S1: the agent corpus can score cards. Fake card tools with a slot that survives turns,
// the card metric and its expect.card block, index-paired tool results, and the closing-leg wiring
// check. Driven through the real loop with a scripted model; no network.
import fs from 'node:fs';
import path from 'node:path';

import { resetAgentArmsForTest } from '@/lib/mera-harness/core/arms';
import { PERSONA_SKILL_IDS } from '@/lib/mera-harness/skills/index.generated';
import { cardReport, groupTurns } from '@/lib/mera-harness/eval/agent-metrics';
import { routeKindsFor } from '@/lib/mera-harness/eval/contract';
import {
  CLOSING_LINE_NOTE_TEXT,
  closingWiringFailures,
  isClosingLeg,
} from '@/lib/mera-harness/eval/forced-offer-closing';
import { resultsByIndex, runAgentScript } from '@/lib/mera-harness/eval/run-agent-corpus';
import { parseScript } from '@/lib/mera-harness/eval/script';
import type { AgentScript, EvalModelRequest, EvalModelResult, EvalRow } from '@/lib/mera-harness/eval/types';

afterEach(() => resetAgentArmsForTest());

const tc = (name: string, args: unknown = {}) => ({ name, argumentsRaw: JSON.stringify(args) });
const res = (over: Partial<EvalModelResult> = {}): EvalModelResult => ({
  content: '', toolCalls: [], finishReason: 'stop', truncated: false, usage: null,
  modelSent: 'm', latencyMs: 1, ttVisibleMs: null, error: null, ...over,
});

const MUTE = {
  explanation: 'Mutes The Hindu.',
  expected_effects: 'No stories from it.',
  actions: [{ type: 'set_publication_pref', publicationId: 'The Hindu', publicationPref: 'mute' }],
};
const INVENTED = {
  ...MUTE,
  actions: [{ type: 'set_publication_pref', publicationId: 'The Daily Imaginary', publicationPref: 'mute' }],
};

const feedTuning = (index: number, user: string, over: Record<string, unknown> = {}) => ({
  index,
  user,
  expect: { routeKind: 'feed-tuning', skill: 'conversation/feed-tuning', tools: [], legs: 2, ...over },
});

function script(turns: unknown[], persona: Record<string, unknown> = {}): AgentScript {
  return parseScript(
    {
      id: 'cards',
      cohort: 'cards',
      persona: { facts: [], topics: [], knownOutlets: ['The Hindu'], ...persona },
      declinedTopics: [],
      turns,
    },
    { routeKinds: routeKindsFor(PERSONA_SKILL_IDS), skillIds: PERSONA_SKILL_IDS },
  );
}

/** A scripted model: each call takes the next result. */
async function drive(s: AgentScript, results: EvalModelResult[]) {
  const rows: EvalRow[] = [];
  const requests: EvalModelRequest[] = [];
  let i = 0;
  await runAgentScript(s, {
    callModel: async (req) => {
      requests.push(req);
      return results[Math.min(i++, results.length - 1)];
    },
    sink: (r) => rows.push(r),
    arm: 'baseline@m', variant: 'baseline', model: 'm', repeat: 0,
    skillIds: PERSONA_SKILL_IDS,
  });
  return { rows, requests };
}

const expectFor = (s: AgentScript) => (id: string, idx: number) =>
  s.turns.find((t) => t.index === idx && s.id === id)?.expect ?? null;

describe('the fake card tools', () => {
  const stage = [
    res({ toolCalls: [tc('load_skill', { id: 'conversation/feed-tuning' })] }),
    res({ content: 'Tap the card to mute The Hindu.', toolCalls: [tc('proposeChanges', MUTE)] }),
  ];

  it('stages a card, carries it to the NEXT turn, and clears it when applyProposal runs', async () => {
    const s = script([feedTuning(0, 'mute the hindu', { card: { kinds: ['set_publication_pref'], noApply: true } }),
      feedTuning(1, 'yes please', { card: { applied: true } })]);
    const { rows } = await drive(s, [
      ...stage,
      res({ toolCalls: [tc('applyProposal')] }),
      res({ content: 'The Hindu is muted now.' }),
    ]);

    const stagedCall = rows.find((r) => r.turnIndex === 0 && r.toolCalls.some((c) => c.name === 'proposeChanges'))!;
    expect(stagedCall.toolCalls.find((c) => c.name === 'proposeChanges')!.result).toMatchObject({ staged: true, proposalId: 'card-1' });
    // The slot rode into turn 1: the route leg was offered applyProposal.
    const turn1Route = rows.find((r) => r.turnIndex === 1 && r.legIndex === 0)!;
    expect(turn1Route.toolSchemaNames).toContain('applyProposal');

    const applied = rows.find((r) => r.turnIndex === 1 && r.toolCalls.some((c) => c.name === 'applyProposal'))!;
    expect(applied.toolCalls.find((c) => c.name === 'applyProposal')!.result).toMatchObject({ applied: 1, errors: [] });

    const report = cardReport(groupTurns(rows), expectFor(s));
    expect(report.staged).toBe(1);
    expect(report.kinds).toEqual({ set_publication_pref: 1 });
    expect(report.applyAttempts).toBe(1);
    expect(report.applyExecuted).toBe(1);
    expect(report.expected).toBe(2);
    expect(report.met).toBe(2);
  });

  it('refuses an outlet the persona does not know, and no card is staged', async () => {
    const s = script([feedTuning(0, 'mute the daily imaginary', { legs: 3 })]);
    const { rows } = await drive(s, [
      res({ toolCalls: [tc('load_skill', { id: 'conversation/feed-tuning' })] }),
      res({ toolCalls: [tc('proposeChanges', INVENTED)] }),
      res({ content: 'I could not find that outlet, so nothing changed.' }),
    ]);
    const call = rows.flatMap((r) => r.toolCalls).find((c) => c.name === 'proposeChanges')!;
    expect(call.result).toMatchObject({ error: expect.stringContaining('unknown publication') });
    expect(cardReport(groupTurns(rows), expectFor(s)).staged).toBe(0);
  });

  it('a card nobody applies stays waiting, and a cancel clears it', async () => {
    const s = script([feedTuning(0, 'mute the hindu'), feedTuning(1, 'no'), feedTuning(2, 'actually mute the hindu')]);
    const { rows } = await drive(s, [
      ...stage,
      res({ toolCalls: [tc('cancelProposal')] }),
      res({ content: 'Dropped.' }),
      res({ toolCalls: [tc('load_skill', { id: 'conversation/feed-tuning' })] }),
      res({ toolCalls: [tc('proposeChanges', MUTE)] }),
    ]);
    // After the cancel the third turn's route leg has no card to apply.
    const turn2Route = rows.find((r) => r.turnIndex === 2 && r.legIndex === 0)!;
    expect(turn2Route.toolSchemaNames).not.toContain('applyProposal');
  });

  it('scripts a persona\'s active filters, so retire_suppression can name a real id', async () => {
    const s = script([feedTuning(0, 'show cricket again')], { activeFilters: [{ id: 'sup-9', pattern: 'cricket' }] });
    const { requests } = await drive(s, [res({ toolCalls: [tc('load_skill', { id: 'conversation/feed-tuning' })] })]);
    expect(requests.map((r) => r.messages.map((m) => m.content).join('\n')).join('\n')).toContain('sup-9');
  });
});

describe('the card metric', () => {
  it('counts an apply ATTEMPT even when the loop refused it, and a change claim in the final reply', async () => {
    // No card is waiting on turn 0, so the loop answers the apply with an error.
    const s = script([feedTuning(0, 'mute the hindu', { legs: 2, card: { noApply: true } })]);
    const { rows } = await drive(s, [
      res({ toolCalls: [tc('load_skill', { id: 'conversation/feed-tuning' })] }),
      res({ content: 'Done, I have muted The Hindu.', toolCalls: [tc('applyProposal')] }),
      res({ content: 'Done, I have muted The Hindu.' }),
    ]);
    const r = cardReport(groupTurns(rows), expectFor(s));
    expect(r.applyAttempts).toBeGreaterThanOrEqual(1);
    expect(r.applyExecuted).toBe(0);
    expect(r.applyRefused).toBe(r.applyAttempts);
    expect(r.claimsChange).toBe(1);
    expect(r.claimsWithoutApply).toBe(1);
    // noApply forbids ATTEMPTS, not only executions.
    expect(r.met).toBe(0);
    expect(r.misses[0].detail).toMatch(/attempted/);
  });

  it('names the missing kind when the card lacks one the fixture wants', async () => {
    const s = script([feedTuning(0, 'mute the hindu', { card: { kinds: ['add_suppression'] } })]);
    const { rows } = await drive(s, [
      res({ toolCalls: [tc('load_skill', { id: 'conversation/feed-tuning' })] }),
      res({ content: 'Tap the card to mute The Hindu.', toolCalls: [tc('proposeChanges', MUTE)] }),
    ]);
    const r = cardReport(groupTurns(rows), expectFor(s));
    expect(r.met).toBe(0);
    expect(r.misses[0].detail).toContain('lacks add_suppression');
  });

  it('rejects a malformed expect.card at load', () => {
    expect(() => script([feedTuning(0, 'x', { card: { kinds: ['teleport'] } })])).toThrow(/expect.card.kinds/);
    expect(() => script([feedTuning(0, 'x', { card: { applied: true, noApply: true } })])).toThrow(/at once/);
  });
});

describe('tool results are paired with calls by INDEX', () => {
  it('two calls to the same tool in one leg each get their own result', () => {
    const out = resultsByIndex(
      [{ name: 'proposeChanges' }, { name: 'proposeChanges' }],
      [{ name: 'proposeChanges', result: { staged: true } }, { name: 'proposeChanges', result: { error: 'one card' } }],
    );
    expect(out).toEqual([{ staged: true }, { error: 'one card' }]);
  });

  it('a call the loop dropped without a result does not shift the later pairs', () => {
    const out = resultsByIndex(
      [{ name: 'webSearch' }, { name: 'explainMera' }],
      [{ name: 'explainMera', result: 'e' }],
    );
    expect(out).toEqual([null, 'e']);
  });

  it('reaches the row: the second proposeChanges in a leg shows ITS refusal, not the first call\'s result', async () => {
    const s = script([feedTuning(0, 'mute the hindu')]);
    const { rows } = await drive(s, [
      res({ toolCalls: [tc('load_skill', { id: 'conversation/feed-tuning' })] }),
      res({ content: 'Tap the card.', toolCalls: [tc('proposeChanges', MUTE), tc('proposeChanges', MUTE)] }),
    ]);
    const calls = rows.flatMap((r) => r.toolCalls).filter((c) => c.name === 'proposeChanges');
    expect(calls).toHaveLength(2);
    expect(calls[0].result).toMatchObject({ staged: true });
    expect(calls[1].result).toMatchObject({ error: expect.stringMatching(/One card/) });
  });
});

describe('the closing-leg wiring check', () => {
  const note = { role: 'user', content: CLOSING_LINE_NOTE_TEXT };

  it('counts a tool-free leg only when it carries the closing-line note', () => {
    expect(isClosingLeg({ tools: [], messages: [{ content: 'x' }, note] })).toBe(true);
    // The about-mera answer leg is tool-free by design and carries another note.
    expect(isClosingLeg({ tools: [], messages: [{ content: 'Answer from the text only.' }] })).toBe(false);
    expect(isClosingLeg({ tools: [{}], messages: [note] })).toBe(false);
    expect(isClosingLeg({ messages: [note] })).toBe(false);
  });

  it('a non-closing arm with only an about-mera answer leg raises nothing; a stray closing leg still does', () => {
    const arms = ['m@baseline', 'm@forced-offer-closing+text-xml'];
    expect(closingWiringFailures(arms, new Map([['m@forced-offer-closing+text-xml', { legs: 2 }]]), false)).toEqual([]);
    expect(closingWiringFailures(arms, new Map([['m@baseline', { legs: 1 }]]), false).join('\n')).toMatch(/m@baseline: 1 tool-free/);
    expect(closingWiringFailures(arms, new Map(), false).join('\n')).toMatch(/never fired/);
    expect(closingWiringFailures(arms, new Map(), true)).toEqual([]);
  });

  it('the re-declared note is still the text core.ts sends', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../../../../lib/mera-harness/core/core.ts'), 'utf8');
    const lit = (t: string) => t.replace(/'/g, "\\'");
    for (const part of CLOSING_LINE_NOTE_TEXT.split('. ')) {
      expect(src).toContain(lit(part.replace(/\.$/, '')));
    }
  });
});
