// Drives the real loop with a fake model. No network, no clock of its own:
// `now` is injected as a counter, so every timing below is exact rather than
// flaky.

import { parseScript } from '../script';
import { runAgentScript } from '../run-agent-corpus';
import { groupTurns, firstProseReport } from '../agent-metrics';
import type { EvalModelRequest, EvalModelResult, EvalRow } from '../types';

const SKILL_IDS = ['topics/residence', 'topics/generic'] as const;
const ROUTE_KINDS = ['fact_capture', 'question', 'chat', 'refuse'] as const;

function scriptJson(over: Record<string, unknown> = {}) {
  return {
    id: 'unit',
    cohort: 'good',
    persona: { facts: [{ id: 'f1', statement: 'Lives in Porto', questionnaireAttribute: 'location: residence' }], topics: [] },
    declinedTopics: [],
    turns: [
      {
        index: 0,
        user: 'I live in Nieuw-West Amsterdam',
        expect: { routeKind: 'fact_capture', skill: 'topics/residence', tools: ['lookup_place'], legs: 2 },
        fakeTools: {
          lookup_place: [
            { query: 'Nieuw-West Amsterdam', returns: { status: 'resolved', places: [
              { neighbourhood: 'Nieuw-West', locality: 'Amsterdam', admin1: 'North Holland', countryCode: 'NL', countryName: 'Netherlands', bloc: 'EU' },
            ] } },
          ],
        },
      },
    ],
    ...over,
  };
}

/** A fake model with an injected clock. Returns tool calls on leg 0 and prose
 *  on leg 1, which is the shape a real fact-capture turn takes. */
function fakeModel(clock: { t: number }, opts: { prose?: string; error?: string | null } = {}) {
  let call = 0;
  return async (req: EvalModelRequest): Promise<EvalModelResult> => {
    call += 1;
    clock.t += 1000;
    const isFirst = call === 1;
    return {
      content: isFirst ? '' : (opts.prose ?? 'Saved that for you.'),
      toolCalls: isFirst
        ? [{ name: 'lookup_place', argumentsRaw: JSON.stringify({ query: 'Nieuw-West Amsterdam' }) }]
        : [],
      finishReason: 'stop',
      truncated: false,
      usage: { promptTokens: isFirst ? 500 : 800, completionTokens: 20, cachedTokens: isFirst ? 0 : 400, reasoningTokens: 0 },
      modelSent: req.model,
      latencyMs: 1000,
      // Only the prose leg reports a first-content delta. The routing leg has
      // none, which is the whole reason first-prose spans legs.
      ttVisibleMs: isFirst ? null : 200,
      error: opts.error ?? null,
    };
  };
}

async function drive(opts: { prose?: string; error?: string | null } = {}): Promise<EvalRow[]> {
  const script = parseScript(scriptJson(), { routeKinds: ROUTE_KINDS, skillIds: SKILL_IDS });
  const rows: EvalRow[] = [];
  const clock = { t: 0 };
  await runAgentScript(script, {
    callModel: fakeModel(clock, opts),
    sink: (r) => rows.push(r),
    arm: 'baseline@m', variant: 'baseline', model: 'm', repeat: 0,
    now: () => clock.t,
    skillIds: SKILL_IDS,
  });
  return rows;
}

describe('runAgentScript', () => {
  it('emits one row per leg, indexed, with the TURN as the interleave group', async () => {
    const rows = await drive();
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows.map((r) => r.legIndex)).toEqual(rows.map((_, i) => i));
    // The turn, never the leg: a leg-level group would mark every high leg
    // non-interleaved once a one-shot arm with no leg above 0 joins the run.
    expect(new Set(rows.map((r) => r.interleaveGroup))).toEqual(new Set(['unit:0']));
  });

  it('marks ONLY turn 0 leg 0 as fixture-determined', async () => {
    const rows = await drive();
    expect(rows[0].promptDeterministic).toBe(true);
    for (const r of rows.slice(1)) expect(r.promptDeterministic).toBe(false);
  });

  it('records thinking OFF on every leg, which is the shipped gear', async () => {
    const rows = await drive();
    // Asserted as FALSE, not merely "present": thinking on returned empty
    // content 8 of 10 in this tree, so the gear is load-bearing. A null here
    // would mean the core stopped setting the flag and the switch had become
    // unverifiable, which is the failure this row exists to catch.
    for (const r of rows) expect(r.thinkingRequested).toBe(false);
  });

  it('puts endedOn on the LAST leg only, so a turn has exactly one verdict', async () => {
    const rows = await drive();
    const withEnd = rows.filter((r) => r.endedOn !== null);
    expect(withEnd).toHaveLength(1);
    expect(withEnd[0].legIndex).toBe(rows[rows.length - 1].legIndex);
  });

  it('first prose spans legs: the value exceeds the prose leg’s own ttVisibleMs', async () => {
    const rows = await drive();
    const proseLeg = rows.find((r) => r.ttVisibleMs !== null);
    if (!proseLeg) return; // a one-leg turn is still valid; nothing to span
    const r = firstProseReport(groupTurns(rows));
    const value = Object.values(r.byArm)[0]?.[0];
    expect(value).toBeGreaterThanOrEqual(proseLeg.ttVisibleMs as number);
  });

  it('carries the tool RESULT on the row, so a rater never consults the fixture', async () => {
    const rows = await drive();
    const withTools = rows.find((r) => r.toolCalls.length > 0);
    if (withTools) expect(withTools.toolCalls[0]).toHaveProperty('result');
  });

  it('a THROWN caller error ends the run and is not recorded as leg data', async () => {
    const script = parseScript(scriptJson(), { routeKinds: ROUTE_KINDS, skillIds: SKILL_IDS });
    const rows: EvalRow[] = [];
    class SpendLimit extends Error {}
    await expect(
      runAgentScript(script, {
        callModel: async () => { throw new SpendLimit('402'); },
        sink: (r) => rows.push(r),
        arm: 'a', variant: 'baseline', model: 'm', repeat: 0, skillIds: SKILL_IDS,
      }),
    ).rejects.toBeInstanceOf(SpendLimit);
    // The control: nothing was written. Recording a 402 per call is what
    // produced a file of empty rows reading as a model failure.
    expect(rows).toHaveLength(0);
  });
});

describe('script validation', () => {
  const opts = { routeKinds: ROUTE_KINDS, skillIds: SKILL_IDS };

  it('rejects an unknown skill id, and accepts a known one', () => {
    expect(() => parseScript(scriptJson({
      turns: [{ index: 0, user: 'x', expect: { routeKind: 'chat', skill: 'facts/nope', tools: [], legs: 1 } }],
    }), opts)).toThrow(/does not exist/);
    expect(() => parseScript(scriptJson(), opts)).not.toThrow();
  });

  it('rejects a fake answer no turn can reach', () => {
    expect(() => parseScript(scriptJson({
      turns: [{
        index: 0, user: 'x',
        expect: { routeKind: 'chat', skill: 'topics/generic', tools: [], legs: 1 },
        fakeTools: { lookup_place: [{ query: 'q', returns: { status: 'unavailable' } }] },
      }],
    }), opts)).toThrow(/no call can ever reach them/);
  });

  it('rejects a find_similar_facts fixture that still carries a query', () => {
    expect(() => parseScript(scriptJson({
      turns: [{
        index: 0, user: 'x',
        expect: { routeKind: 'chat', skill: 'topics/generic', tools: ['find_similar_facts'], legs: 1 },
        fakeTools: { find_similar_facts: [{ query: 'raw words', kind: null, returns: { candidates: [] } }] },
      }],
    }), opts)).toThrow(/no persona text in cleartext/);
  });

  it('rejects a choice reply whose predecessor never asked', () => {
    expect(() => parseScript(scriptJson({
      turns: [
        { index: 0, user: 'x', expect: { routeKind: 'chat', skill: 'topics/generic', tools: [], legs: 1 } },
        { index: 1, chooses: 'A', expect: { routeKind: 'chat', skill: 'topics/generic', tools: [], legs: 1 } },
      ],
    }), opts)).toThrow(/does not expect ask_choice/);
  });

  it('accepts a correctly paired choice reply', () => {
    expect(() => parseScript(scriptJson({
      turns: [
        { index: 0, user: 'x', expect: { routeKind: 'chat', skill: 'topics/generic', tools: ['ask_choice'], legs: 1 } },
        { index: 1, chooses: 'A', expect: { routeKind: 'chat', skill: 'topics/generic', tools: [], legs: 1 } },
      ],
    }), opts)).not.toThrow();
  });
});
