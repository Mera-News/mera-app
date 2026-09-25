import {
  FIRST_PROSE_P50_MULTIPLE,
  consecutiveQuestionReport,
  firstProseGate,
  firstProseReport,
  groupTurns,
  inputTokenReport,
  legReport,
  proposalReport,
  proseReport,
  routerReport,
  skillReport,
  thinkingGearReport,
  toolValidityReport,
} from '../agent-metrics';
import type { EvalRow } from '../types';

function row(over: Partial<EvalRow>): EvalRow {
  return {
    scriptId: 's1', cohort: 'good', turnIndex: 0, legIndex: 0, repeat: 0,
    arm: 'baseline', variant: 'baseline', callType: 'agent-route',
    interleaveGroup: 's1:0', promptDeterministic: true, formatRetries: null,
    replyRetries: null, replyClaimUnfixed: null, replyLeakUnfixed: null,
    systemPrompt: 'S', messages: [], toolSchemaNames: [], rawOutput: '',
    toolCalls: [], turnStartedAtMs: 1000, legStartedAtMs: 1000,
    latencyMs: 10, ttVisibleMs: null, thinkingRequested: false, inputTokens: 100,
    usage: { promptTokens: 100, completionTokens: 10, cachedTokens: 0, reasoningTokens: 0 },
    finishReason: 'stop', truncated: false, error: null,
    modelRequested: 'm', modelSent: 'm', endedOn: null, awaitingUser: false,
    routeKind: null, skillLoaded: null, expectedRouteKind: 'none', expectedSkill: 'facts/generic',
    items: null, factKind: null, topics: null, dropped: null,
    ...over,
  };
}

describe('turn grouping', () => {
  it('keeps the terminal topic call out of the leg count', () => {
    const turns = groupTurns([
      row({ legIndex: 0, callType: 'agent-route' }),
      row({ legIndex: 1, callType: 'agent-tool', endedOn: 'settled' }),
      row({ legIndex: 2, callType: 'agent-topicgen' }),
    ]);
    expect(turns).toHaveLength(1);
    expect(turns[0].legs).toHaveLength(2);
    expect(turns[0].topicRows).toHaveLength(1);
  });
});

describe('time to first prose', () => {
  // THE POINT. The routing leg emits no prose, so a per-leg ttVisibleMs cannot
  // see an extra leg spent before the first token. This must.
  it('spans legs: a 3-leg turn whose prose starts in leg 2 exceeds that leg’s own ttVisibleMs', () => {
    const turns = groupTurns([
      row({ legIndex: 0, turnStartedAtMs: 1000, legStartedAtMs: 1000, ttVisibleMs: null }),
      row({ legIndex: 1, turnStartedAtMs: 1000, legStartedAtMs: 3000, ttVisibleMs: null, callType: 'agent-tool' }),
      row({ legIndex: 2, turnStartedAtMs: 1000, legStartedAtMs: 5000, ttVisibleMs: 200, callType: 'agent-tool', endedOn: 'settled' }),
    ]);
    const r = firstProseReport(turns);
    expect(r.byArm.baseline).toEqual([4200]); // 5000 + 200 - 1000
    expect(r.byArm.baseline[0]).toBeGreaterThan(200); // the leg's own figure
  });

  it('a one-leg turn equals its own ttVisibleMs', () => {
    const turns = groupTurns([
      row({ legIndex: 0, turnStartedAtMs: 1000, legStartedAtMs: 1000, ttVisibleMs: 350, callType: 'agent-tool', endedOn: 'settled' }),
    ]);
    expect(firstProseReport(turns).byArm.baseline).toEqual([350]);
  });

  it('EXCLUDES a turn with no prose rather than counting it as zero', () => {
    const turns = groupTurns([
      row({ scriptId: 'a', legIndex: 0, ttVisibleMs: null, endedOn: 'awaiting_user' }),
      row({ scriptId: 'b', legIndex: 0, legStartedAtMs: 1000, ttVisibleMs: 400, endedOn: 'settled' }),
    ]);
    const r = firstProseReport(turns);
    expect(r.turnsWithoutProse).toBe(1);
    expect(r.byArm.baseline).toEqual([400]); // not [0, 400]
  });

  it('gate fails when the agent is slower than the allowed multiple, passes when inside it', () => {
    const control = [100, 100, 100];
    expect(firstProseGate([100 * FIRST_PROSE_P50_MULTIPLE + 1], control).passed).toBe(false);
    expect(firstProseGate([120, 120, 120], control).passed).toBe(true);
  });

  it('always carries the bias note, and its direction', () => {
    expect(firstProseGate([1], [1]).biasNote).toMatch(/understates the agent/);
  });
});

describe('legs', () => {
  const expectFor = () => ({ routeKind: 'fact_capture', skill: 'topics/residence', tools: [], legs: 3 });

  it('does NOT count an early end on transport failure as a mismatch', () => {
    const turns = groupTurns([
      row({ legIndex: 0 }),
      row({ legIndex: 1, endedOn: 'transport_error', error: 'ECONNRESET' }),
    ]);
    const r = legReport(turns, expectFor);
    expect(r.endedOnTransportError).toBe(1);
    expect(r.legCountMismatches).toHaveLength(0);
  });

  it('DOES count a leg-count mismatch on a turn that settled normally', () => {
    const turns = groupTurns([row({ legIndex: 0, endedOn: 'settled' })]);
    expect(legReport(turns, expectFor).legCountMismatches).toHaveLength(1);
  });

  it('separates a cap hit on a fixture that expected fewer legs', () => {
    const turns = groupTurns([
      row({ legIndex: 0 }), row({ legIndex: 1 }), row({ legIndex: 2 }),
      row({ legIndex: 3, endedOn: 'leg_cap' }),
    ]);
    expect(legReport(turns, expectFor).cappedBelowExpectation).toHaveLength(1);
  });
});

describe('router and skill are two alphabets', () => {
  it('reports router accuracy per cohort and never pools it', () => {
    const r = routerReport([
      { cohort: 'good', scriptId: 's', turnIndex: 0, expected: 'fact_capture', actual: 'fact_capture', correct: true },
      { cohort: 'adversarial', scriptId: 's', turnIndex: 0, expected: 'refuse', actual: 'chat', correct: false },
      { cohort: 'adversarial', scriptId: 's', turnIndex: 1, expected: 'refuse', actual: null, correct: false },
    ]);
    expect(r.byCohort.good).toEqual({ n: 1, correct: 1 });
    expect(r.byCohort.adversarial).toEqual({ n: 2, correct: 0 });
    expect(r.unparsed).toBe(1);
    expect(r.confusion.refuse).toEqual({ chat: 1, '(unparsed)': 1 });
  });

  it('separates an invented skill id from a wrong real one', () => {
    const known = ['topics/residence', 'topics/origin'];
    const r = skillReport(
      [
        { expectedSkill: 'topics/residence', loaded: 'topics/residence', routeCorrect: true },
        { expectedSkill: 'topics/residence', loaded: 'topics/origin', routeCorrect: true },
        { expectedSkill: 'topics/residence', loaded: 'topics/invented', routeCorrect: true },
        { expectedSkill: 'topics/residence', loaded: null, routeCorrect: false },
      ],
      known,
    );
    expect(r.outcomes).toEqual({
      correct: 1, 'wrong-id': 1, 'nonexistent-id': 1, 'none-loaded': 1,
    });
    // route right, skill wrong: the two wrong-skill rows whose route was right
    expect(r.routeCorrectSkillWrong).toBe(2);
  });
});

describe('tool validity', () => {
  it('splits unparseable from schema-invalid from unknown-tool', () => {
    const r = toolValidityReport([
      row({ toolCalls: [
        { name: 'lookupPlace', argumentsRaw: '{bad', parsed: null, schemaValid: false, unknownTool: false, result: null },
        { name: 'lookupPlace', argumentsRaw: '{}', parsed: {}, schemaValid: false, unknownTool: false, result: null },
        { name: 'lookupPlace', argumentsRaw: '{"query":"x"}', parsed: { query: 'x' }, schemaValid: true, unknownTool: false, result: null },
        { name: 'teleport', argumentsRaw: '{}', parsed: {}, schemaValid: false, unknownTool: true, result: null },
      ] }),
    ]);
    expect(r.byTool.lookupPlace).toEqual({ calls: 3, unparseable: 1, schemaInvalid: 1 });
    expect(r.unknownToolCalls).toBe(1);
  });
});

describe('consecutive questions', () => {
  it('flags two adjacent awaiting-user turns and names them', () => {
    const turns = groupTurns([
      row({ turnIndex: 0, endedOn: 'awaiting_user' }),
      row({ turnIndex: 1, endedOn: 'awaiting_user' }),
    ]);
    const r = consecutiveQuestionReport(turns);
    expect(r.passed).toBe(false);
    expect(r.pairs).toEqual([{ arm: 'baseline', scriptId: 's1', firstTurn: 0, secondTurn: 1 }]);
  });

  it('passes a single question turn', () => {
    const turns = groupTurns([
      row({ turnIndex: 0, endedOn: 'awaiting_user' }),
      row({ turnIndex: 1, endedOn: 'settled' }),
    ]);
    expect(consecutiveQuestionReport(turns).passed).toBe(true);
  });
});

describe('thinking gear', () => {
  it('flags requested-off that still reasoned, and stays quiet when honoured', () => {
    const r = thinkingGearReport([
      row({ thinkingRequested: false, usage: { promptTokens: 1, completionTokens: 1, cachedTokens: 0, reasoningTokens: 90 } }),
      row({ thinkingRequested: false }),
    ]);
    expect(r.requestedOff).toBe(2);
    expect(r.requestedOffButReasoned).toBe(1);
  });
});

describe('input tokens', () => {
  it('prefers the REAL prompt-token count over the char estimate', () => {
    // The estimate and the billed number disagree by a lot. Preferring the
    // estimate once produced a per-turn total smaller than its own cached
    // subset, which is incoherent and was still reported.
    const turns = groupTurns([
      row({
        legIndex: 0, inputTokens: 300,
        usage: { promptTokens: 1000, completionTokens: 1, cachedTokens: 900, reasoningTokens: 0 },
        endedOn: 'settled',
      }),
    ]);
    const r = inputTokenReport(turns);
    expect(r.perTurn.baseline).toEqual([1000]);
    // The total can never be below its own cached figure.
    expect(r.perTurn.baseline[0]).toBeGreaterThanOrEqual(r.cachedPerTurn.baseline[0]);
  });

  it('falls back to the estimate when the provider reported no usage', () => {
    const turns = groupTurns([row({ legIndex: 0, inputTokens: 300, usage: null, endedOn: 'settled' })]);
    expect(inputTokenReport(turns).perTurn.baseline).toEqual([300]);
  });

  it('sums per turn across legs and keeps cached separate', () => {
    const turns = groupTurns([
      row({ legIndex: 0, inputTokens: 500, usage: { promptTokens: 500, completionTokens: 1, cachedTokens: 400, reasoningTokens: 0 } }),
      row({ legIndex: 1, inputTokens: 300, usage: { promptTokens: 300, completionTokens: 1, cachedTokens: 200, reasoningTokens: 0 }, endedOn: 'settled' }),
    ]);
    const r = inputTokenReport(turns);
    expect(r.perTurn.baseline).toEqual([800]);
    expect(r.cachedPerTurn.baseline).toEqual([600]);
    expect(r.perLeg.baseline).toEqual([500, 300]);
  });
});

describe('prose', () => {
  it('rates the dash rule only over rows that have prose', () => {
    const r = proseReport([
      row({ rawOutput: '' }),
      row({ rawOutput: 'A plain reply.' }),
      row({ rawOutput: 'A reply — with an em dash.' }),
    ]);
    expect(r.rowsWithProse).toBe(2);
    expect(r.bannedDash).toBe(1);
  });
});

describe('proposal expectations (ux2 D8)', () => {
  const saved = (accepted: string[]) => ({
    name: 'saveExtractedFacts', argumentsRaw: '{}', parsed: {}, schemaValid: true, unknownTool: false,
    result: { accepted, rejected: [] },
  });
  const expectFor = () => ({
    routeKind: 'family', skill: 'facts/family', tools: [], legs: 4,
    proposals: [{ statementMatches: ['porto santo', 'parents'], statementExcludes: ['machico'], kind: 'family', placeChain: null, replaces: null }],
  });

  it('passes a statement carrying every match and no exclude', () => {
    const turns = groupTurns([
      row({ legIndex: 2, callType: 'agent-tool', toolCalls: [saved(["Girlfriend's parents live in Porto Santo (Vila Baleira), Madeira"])] }),
    ]);
    const r = proposalReport(turns, expectFor);
    expect(r).toMatchObject({ expected: 1, met: 1, misses: [] });
  });

  it('fails a statement carrying an excluded word, however well it matches', () => {
    const turns = groupTurns([
      row({ legIndex: 2, callType: 'agent-tool', toolCalls: [saved(["Girlfriend's parents live in Porto Santo, Machico, Madeira"])] }),
    ]);
    const r = proposalReport(turns, expectFor);
    expect(r.met).toBe(0);
    expect(r.misses).toHaveLength(1);
  });
});
