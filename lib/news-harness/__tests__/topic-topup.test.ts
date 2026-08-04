// topic-topup — pure candidate selection, combo-only call, global dedupe (r12 J-P1).

import {
  selectTopupCandidates,
  buildComboOnlyBatchCall,
  planTopupTopicRows,
  TOPUP_FANOUT_CEILING,
  type TopupFactInput,
  type TopupTopicInput,
} from '../persona-management/topic-topup';

const T0 = 1_700_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

const normalize = (s: string) => s.toLowerCase().trim().replace(/\s+/g, ' ');

function fact(id: string, statement: string, ageDays: number): TopupFactInput {
  return { id, statement, createdAtMs: T0 - ageDays * DAY };
}

function topics(
  factId: string,
  count: number,
  ageDays: number,
  active = true,
): TopupTopicInput[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `${factId}-t${i}`,
    factId,
    text: `${factId} topic ${i}`,
    createdAtMs: T0 - ageDays * DAY,
    isActive: active,
  }));
}

describe('selectTopupCandidates — watermark mode', () => {
  const older = fact('f-old', 'Follows Indian cricket', 30);
  const newer = fact('f-new', 'Lives in Bengaluru', 1);

  it('selects a fact whose topics predate a newer fact', () => {
    const out = selectTopupCandidates([older, newer], topics('f-old', 3, 30), {
      nowMs: T0,
    });
    expect(out.map((c) => c.factId)).toEqual(['f-old']);
    expect(out[0].supportingFacts).toEqual(['Lives in Bengaluru']);
  });

  it('does NOT select when no fact is newer than the watermark', () => {
    // Topics minted AFTER both facts existed — nothing to revisit.
    const out = selectTopupCandidates([older, newer], topics('f-old', 3, 0), {
      nowMs: T0,
    });
    expect(out).toEqual([]);
  });

  it('respects the fan-out ceiling — no headroom, no top-up', () => {
    const out = selectTopupCandidates(
      [older, newer],
      topics('f-old', TOPUP_FANOUT_CEILING, 30),
      { nowMs: T0 },
    );
    expect(out).toEqual([]);
  });

  it('never requests more than the remaining headroom', () => {
    const out = selectTopupCandidates(
      [older, newer],
      topics('f-old', TOPUP_FANOUT_CEILING - 1, 30),
      { nowMs: T0 },
    );
    expect(out[0].requestCount).toBe(1); // 8 - 7, below the per-fact max of 2
  });

  it('counts only ACTIVE topics toward the ceiling', () => {
    const retired = topics('f-old', 8, 30, false);
    const out = selectTopupCandidates([older, newer], retired, { nowMs: T0 });
    expect(out).toHaveLength(1); // 8 retired rows do not fill the fan-out
  });

  it('honours a persisted watermark even when rows are older', () => {
    // The KV blob says we already considered this fact against today's fact set,
    // so a run that mints nothing must not re-fire forever.
    const out = selectTopupCandidates([older, newer], topics('f-old', 3, 30), {
      nowMs: T0,
      consideredThroughByFact: new Map([['f-old', T0]]),
    });
    expect(out).toEqual([]);
  });

  it('re-opens a fact once a genuinely newer fact arrives', () => {
    const newest = fact('f-newest', 'Started a new job in Berlin', 0);
    const out = selectTopupCandidates(
      [older, newer, newest],
      topics('f-old', 3, 30),
      { nowMs: T0, consideredThroughByFact: new Map([['f-old', T0 - 0.5 * DAY]]) },
    );
    expect(out.map((c) => c.factId)).toEqual(['f-old']);
    expect(out[0].supportingFacts).toContain('Started a new job in Berlin');
  });

  it('skips facts a higher-priority proposal will delete', () => {
    const out = selectTopupCandidates([older, newer], topics('f-old', 3, 30), {
      nowMs: T0,
      excludeFactIds: new Set(['f-old']),
    });
    expect(out).toEqual([]);
  });

  it('caps facts per sweep and orders oldest-watermark-first', () => {
    const many = Array.from({ length: 10 }, (_, i) =>
      fact(`f${i}`, `Distinct interest ${i}`, 100 - i),
    );
    const trigger = fact('trigger', 'Brand new interest', 0);
    const rows = many.flatMap((f, i) => topics(f.id, 1, 100 - i));

    const out = selectTopupCandidates([...many, trigger], rows, {
      nowMs: T0,
      maxFacts: 3,
    });

    expect(out).toHaveLength(3);
    // f0 is the oldest (100 days) → most stale → revisited first.
    expect(out.map((c) => c.factId)).toEqual(['f0', 'f1', 'f2']);
  });

  it('bounds the supporting facts injected into the prompt', () => {
    const target = fact('target', 'Follows Indian cricket', 90);
    const newOnes = Array.from({ length: 12 }, (_, i) =>
      fact(`n${i}`, `Recent interest ${i}`, 1),
    );
    const out = selectTopupCandidates([target, ...newOnes], topics('target', 1, 90), {
      nowMs: T0,
    });
    expect(out[0].supportingFacts.length).toBeLessThanOrEqual(5);
  });

  it('passes the fact current topic texts as excludeTopics', () => {
    const out = selectTopupCandidates([older, newer], topics('f-old', 2, 30), {
      nowMs: T0,
    });
    expect(out[0].excludeTopics).toEqual(['f-old topic 0', 'f-old topic 1']);
  });

  it('stamps consideredThroughMs so the caller can advance even on zero rows', () => {
    const out = selectTopupCandidates([older, newer], topics('f-old', 3, 30), {
      nowMs: T0,
    });
    expect(out[0].consideredThroughMs).toBe(T0);
  });

  it('produces nothing for a lone fact (no supporting facts to combine)', () => {
    const out = selectTopupCandidates([older], topics('f-old', 1, 30), { nowMs: T0 });
    expect(out).toEqual([]);
  });
});

describe('selectTopupCandidates — fillTo mode (one-time backfill)', () => {
  const a = fact('f-a', 'Follows Indian cricket', 30);
  const b = fact('f-b', 'Lives in Amsterdam', 30);

  it('refills a fact that just lost topics, even with no newer fact', () => {
    // Nothing is newer than the watermark, so watermark mode would decline —
    // but the fact just had topics retired and needs its coverage back.
    const out = selectTopupCandidates([a, b], topics('f-a', 1, 30), {
      mode: 'fillTo',
      fillTargets: new Map([['f-a', 4]]),
      nowMs: T0,
      maxTopicsPerFact: 10,
    });
    expect(out).toHaveLength(1);
    expect(out[0].requestCount).toBe(3); // 4 target - 1 surviving
  });

  it('never fills above the fan-out ceiling', () => {
    const out = selectTopupCandidates([a, b], topics('f-a', 1, 30), {
      mode: 'fillTo',
      fillTargets: new Map([['f-a', 99]]),
      nowMs: T0,
      maxTopicsPerFact: 100,
    });
    expect(out[0].requestCount).toBe(TOPUP_FANOUT_CEILING - 1);
  });

  it('ignores facts with no fill target', () => {
    // Both facts have rows (a fact with none is never a top-up case); only f-b
    // is named as needing a refill, so f-a must be left alone.
    const out = selectTopupCandidates(
      [a, b],
      [...topics('f-a', 1, 30), ...topics('f-b', 1, 30)],
      {
        mode: 'fillTo',
        fillTargets: new Map([['f-b', 3]]),
        nowMs: T0,
      },
    );
    expect(out.map((c) => c.factId)).toEqual(['f-b']);
  });

  it('never tops up a fact that has no topic rows at all', () => {
    // Zero rows means generation is mid-flight or failed — retryTopicGeneration
    // owns that, and without this guard the fact has watermark 0, so every other
    // fact looks "newer" and the just-generated fact gets selected immediately.
    const fresh = fact('f-fresh', 'Just added this interest', 0);
    const out = selectTopupCandidates([a, b, fresh], topics('f-a', 1, 30), {
      nowMs: T0,
    });
    expect(out.map((c) => c.factId)).not.toContain('f-fresh');
  });
});

describe('buildComboOnlyBatchCall', () => {
  const candidate = {
    factId: 'f1',
    statement: 'Follows the Indian national cricket team',
    supportingFacts: ['Lives in Bengaluru'],
    requestCount: 2,
    excludeTopics: ['India cricket news'],
    consideredThroughMs: T0,
  };

  it('emits exactly ONE call, and it is the combo half', () => {
    const call = buildComboOnlyBatchCall(candidate);
    expect(call.id).toBe('topup:f1');
    // The fact-only half never reads other facts, so re-running it would be
    // pure token waste and pure duplicate risk.
    expect(call.system).toContain('combine the Fact');
  });

  it('instructs a ceiling, not a quota', () => {
    const call = buildComboOnlyBatchCall(candidate);
    expect(call.prompt).toContain('Generate at most 2 topics');
    expect(call.prompt).toContain('fewer is correct');
  });

  it('includes the supporting facts and the exclusions', () => {
    const call = buildComboOnlyBatchCall(candidate);
    expect(call.prompt).toContain('Lives in Bengaluru');
    expect(call.prompt).toContain('India cricket news');
  });

  it('reasons, with the raised budget', () => {
    const call = buildComboOnlyBatchCall(candidate);
    expect(call.enableThinking).toBe(true);
    expect(call.maxTokens).toBe(2048);
  });

  it('threads the user location when supplied', () => {
    const call = buildComboOnlyBatchCall(candidate, 'Amsterdam, Netherlands');
    expect(call.prompt).toContain('Amsterdam, Netherlands');
  });
});

describe('planTopupTopicRows — global dedupe', () => {
  it('mints a genuinely new topic', () => {
    const out = planTopupTopicRows(['existing topic'], ['Bengaluru cricket news'], normalize);
    expect(out).toEqual([
      { text: 'Bengaluru cricket news', normalizedText: 'bengaluru cricket news' },
    ]);
  });

  it('skips an exact normalized collision', () => {
    const out = planTopupTopicRows(['bengaluru cricket news'], ['Bengaluru Cricket News'], normalize);
    expect(out).toEqual([]);
  });

  it('skips a NEAR-duplicate — the same topic in different words', () => {
    const out = planTopupTopicRows(
      ['indian cricket team news'],
      ['India cricket team news'],
      normalize,
    );
    expect(out).toEqual([]);
  });

  it('keeps a genuinely different topic that shares some words', () => {
    const out = planTopupTopicRows(
      ['indian cricket team news'],
      ['Bengaluru stadium redevelopment'],
      normalize,
    );
    expect(out).toHaveLength(1);
  });

  it('keeps two topics that merely share a location prefix', () => {
    // 0.40 — comfortably under the 0.6 boundary. These are different interests
    // and collapsing them would silently narrow the feed.
    const out = planTopupTopicRows(
      ['amsterdam expat tech jobs'],
      ['Amsterdam expat childcare'],
      normalize,
    );
    expect(out).toHaveLength(1);
  });

  it('skips the near-synonym family the generation prompt calls out', () => {
    expect(
      planTopupTopicRows(['startup tax'], ['startup tax incentives'], normalize),
    ).toEqual([]);
    expect(
      planTopupTopicRows(['startup funding'], ['startup funding rules'], normalize),
    ).toEqual([]);
  });

  it('KNOWN LIMITATION: bag-of-words misses some restatements', () => {
    // "EU startup regulation" vs "EU startup regulatory changes" scores 0.40.
    // Documented rather than hidden: this check is a backstop, and the prompt's
    // no-near-synonym rule plus excludeTopics are the primary defence.
    const out = planTopupTopicRows(
      ['eu startup regulation'],
      ['EU startup regulatory changes'],
      normalize,
    );
    expect(out).toHaveLength(1);
  });

  it('dedupes within the incoming batch too', () => {
    const out = planTopupTopicRows(
      [],
      ['Bengaluru cricket news', 'bengaluru  CRICKET news'],
      normalize,
    );
    expect(out).toHaveLength(1);
  });

  it('drops empty and whitespace-only texts', () => {
    expect(planTopupTopicRows([], ['', '   '], normalize)).toEqual([]);
  });

  it('respects a GLOBAL exclusion set — a tracked topic blocks the mint', () => {
    // The billing hazard: tracked-topic articles hydrate quota-exempt, so a
    // colliding metered row would silently make that followed story billable.
    const trackedText = 'india pakistan test series';
    const out = planTopupTopicRows(
      [trackedText],
      ['India Pakistan test series'],
      normalize,
    );
    expect(out).toEqual([]);
  });

  it('blocks a text the user just retired (no weekly re-append treadmill)', () => {
    const out = planTopupTopicRows(
      ['amsterdam cricket festival music tech'],
      ['Amsterdam cricket festival music tech'],
      normalize,
    );
    expect(out).toEqual([]);
  });
});
