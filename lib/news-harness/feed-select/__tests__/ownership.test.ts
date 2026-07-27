// feed-select/ownership — pure fact-ownership + display-bucket cores.
// RN-free: no DB/store imports; consumes plain projections. Ported from the
// deleted sections.test.ts in Round-3 C3 (the ownership + bucketOf cases).

import {
  resolveOwningFact,
  resolveOwningFactLenient,
  resolveOwnership,
  bucketOf,
  type ScoredSuggestionProjection,
  type TopicSnapshot,
  type FactSnapshot,
} from '../ownership';

// --- factories ------------------------------------------------------------

let seq = 0;
function sugg(o: Partial<ScoredSuggestionProjection> = {}): ScoredSuggestionProjection {
  seq += 1;
  return {
    id: o.id ?? `s${seq}`,
    rawScore: o.rawScore ?? 0.5,
    relevance: o.relevance ?? 0.6,
    pubDateMs: o.pubDateMs ?? 1_000,
    title: o.title ?? null,
    clusterMemberships: o.clusterMemberships ?? [],
    stableClusterId: o.stableClusterId,
    eventType: o.eventType,
    headlineScope: o.headlineScope,
    headlineLocationId: o.headlineLocationId,
    matchedTopics: o.matchedTopics ?? [],
  };
}

function topic(o: Partial<TopicSnapshot> & { factId: string | null }): TopicSnapshot {
  return { weight: 0.8, highPriority: false, status: 'active', ...o };
}

function fact(o: Partial<FactSnapshot> = {}): FactSnapshot {
  return { weight: 1, createdAtMs: 100, statement: 'A fact', ...o };
}

// --- bucketOf -------------------------------------------------------------

describe('bucketOf', () => {
  it('maps relevance to display tiers', () => {
    expect(bucketOf(1.1)).toBe('EMERGENCY');
    expect(bucketOf(0.8)).toBe('HIGH');
    expect(bucketOf(0.6)).toBe('MEDIUM');
    expect(bucketOf(0.4)).toBe('LOW');
    expect(bucketOf(0.39)).toBe('UNSCORED');
    expect(bucketOf(null)).toBe('UNSCORED');
    expect(bucketOf(-1)).toBe('UNSCORED');
  });
});

// --- owning-fact tie-break chain -----------------------------------------

describe('resolveOwningFact tie-break chain', () => {
  const HP = 1.25;

  it('1: higher fact.weight wins when factScore ties', () => {
    const topics = new Map([
      ['t1', topic({ factId: 'f1', weight: 0.5 })],
      ['t2', topic({ factId: 'f2', weight: 1.0 })],
    ]);
    const facts = new Map([
      ['f1', fact({ weight: 1.0, createdAtMs: 100 })],
      ['f2', fact({ weight: 0.5, createdAtMs: 100 })],
    ]);
    const rep = sugg({
      matchedTopics: [
        { topicId: 't1', text: 'a' },
        { topicId: 't2', text: 'b' },
      ],
    });
    expect(resolveOwningFact(rep, topics, facts, HP)).toBe('f1');
  });

  it('2: more matched topics (breadth) wins when score+weight tie', () => {
    const topics = new Map([
      ['t1a', topic({ factId: 'f1', weight: 0.5 })],
      ['t1b', topic({ factId: 'f1', weight: 0.5 })],
      ['t2', topic({ factId: 'f2', weight: 0.5 })],
    ]);
    const facts = new Map([
      ['f1', fact({ weight: 1.0, createdAtMs: 100 })],
      ['f2', fact({ weight: 1.0, createdAtMs: 100 })],
    ]);
    const rep = sugg({
      matchedTopics: [
        { topicId: 't1a', text: 'a' },
        { topicId: 't1b', text: 'b' },
        { topicId: 't2', text: 'c' },
      ],
    });
    expect(resolveOwningFact(rep, topics, facts, HP)).toBe('f1');
  });

  it('3: older fact wins when score+weight+breadth tie', () => {
    const topics = new Map([
      ['t1', topic({ factId: 'f1', weight: 0.5 })],
      ['t2', topic({ factId: 'f2', weight: 0.5 })],
    ]);
    const facts = new Map([
      ['f1', fact({ weight: 1.0, createdAtMs: 500 })], // newer
      ['f2', fact({ weight: 1.0, createdAtMs: 100 })], // older → wins
    ]);
    const rep = sugg({
      matchedTopics: [
        { topicId: 't1', text: 'a' },
        { topicId: 't2', text: 'b' },
      ],
    });
    expect(resolveOwningFact(rep, topics, facts, HP)).toBe('f2');
  });

  it('4: lexicographic fact id is the final tiebreak', () => {
    const topics = new Map([
      ['tb', topic({ factId: 'fB', weight: 0.5 })],
      ['ta', topic({ factId: 'fA', weight: 0.5 })],
    ]);
    const facts = new Map([
      ['fA', fact({ weight: 1.0, createdAtMs: 100 })],
      ['fB', fact({ weight: 1.0, createdAtMs: 100 })],
    ]);
    const rep = sugg({
      matchedTopics: [
        { topicId: 'tb', text: 'b' },
        { topicId: 'ta', text: 'a' },
      ],
    });
    expect(resolveOwningFact(rep, topics, facts, HP)).toBe('fA');
  });

  it('high_priority lifts w_eff via HP_MULT (score break)', () => {
    const topics = new Map([
      ['t1', topic({ factId: 'f1', weight: 0.5, highPriority: true })], // 0.5×1×1.25=0.625
      ['t2', topic({ factId: 'f2', weight: 0.5 })], // 0.5
    ]);
    const facts = new Map([
      ['f1', fact({ weight: 1.0 })],
      ['f2', fact({ weight: 1.0 })],
    ]);
    const rep = sugg({
      matchedTopics: [
        { topicId: 't1', text: 'a' },
        { topicId: 't2', text: 'b' },
      ],
    });
    expect(resolveOwningFact(rep, topics, facts, HP)).toBe('f1');
  });

  it('ignores non-active topics and negative-only matches (no owning fact)', () => {
    const topics = new Map([
      ['t1', topic({ factId: 'f1', weight: 0.5, status: 'suppressed' })],
      ['t2', topic({ factId: 'f2', weight: -0.8 })], // negative → w_eff ≤ 0
    ]);
    const facts = new Map([
      ['f1', fact()],
      ['f2', fact()],
    ]);
    const rep = sugg({
      matchedTopics: [
        { topicId: 't1', text: 'a' },
        { topicId: 't2', text: 'b' },
      ],
    });
    expect(resolveOwningFact(rep, topics, facts, HP)).toBeNull();
  });
});

// --- ownership classification (owned / orphan / negative) -----------------

describe('resolveOwnership classification', () => {
  const HP = 1.25;

  it('deleted owning fact → orphan (degradable)', () => {
    const topics = new Map([['t-ai', topic({ factId: 'f-ai' })]]);
    const facts = new Map<string, FactSnapshot>(); // f-ai deleted
    const s = sugg({ matchedTopics: [{ topicId: 't-ai', text: 'AI' }] });
    expect(resolveOwnership(s, topics, facts, HP).kind).toBe('orphan');
  });

  it('null factId topic → orphan', () => {
    const topics = new Map([['t', topic({ factId: null })]]);
    const s = sugg({ matchedTopics: [{ topicId: 't', text: 'x' }] });
    expect(resolveOwnership(s, topics, new Map(), HP).kind).toBe('orphan');
  });

  it('effective weight exactly 0 with an active fact → orphan (no signal)', () => {
    const topics = new Map([['t0', topic({ factId: 'f0', weight: 0 })]]);
    const facts = new Map([['f0', fact()]]);
    const s = sugg({ matchedTopics: [{ topicId: 't0', text: 'x' }] });
    expect(resolveOwnership(s, topics, facts, HP).kind).toBe('orphan');
  });

  it('negative match (effective weight < 0) → negative (suppression)', () => {
    const topics = new Map([['tn', topic({ factId: 'fn', weight: -0.8 })]]);
    const facts = new Map([['fn', fact()]]);
    const s = sugg({ matchedTopics: [{ topicId: 'tn', text: 'x' }] });
    expect(resolveOwnership(s, topics, facts, HP).kind).toBe('negative');
  });

  it('active positive fact → owned', () => {
    const topics = new Map([['t', topic({ factId: 'f', weight: 0.8 })]]);
    const facts = new Map([['f', fact()]]);
    const s = sugg({ matchedTopics: [{ topicId: 't', text: 'x' }] });
    expect(resolveOwnership(s, topics, facts, HP)).toEqual({ kind: 'owned', factId: 'f' });
  });
});

describe('resolveOwningFactLenient (Dashboard: zero-signal folds in)', () => {
  const HP = 1.25;

  it('effective weight exactly 0 with an active fact → OWNS that fact (unlike strict)', () => {
    const topics = new Map([['t0', topic({ factId: 'f0', weight: 0 })]]);
    const facts = new Map([['f0', fact()]]);
    const s = sugg({ matchedTopics: [{ topicId: 't0', text: 'x' }] });
    // Strict orphans it; lenient folds it into f0.
    expect(resolveOwnership(s, topics, facts, HP).kind).toBe('orphan');
    expect(resolveOwningFactLenient(s, topics, facts, HP)).toBe('f0');
  });

  it('active positive fact still wins (same as strict)', () => {
    const topics = new Map([['t', topic({ factId: 'f', weight: 0.8 })]]);
    const facts = new Map([['f', fact()]]);
    const s = sugg({ matchedTopics: [{ topicId: 't', text: 'x' }] });
    expect(resolveOwningFactLenient(s, topics, facts, HP)).toBe('f');
  });

  it('a positive fact beats a zero-signal one', () => {
    const topics = new Map([
      ['tp', topic({ factId: 'fp', weight: 0.5 })],
      ['tz', topic({ factId: 'fz', weight: 0 })],
    ]);
    const facts = new Map([['fp', fact()], ['fz', fact()]]);
    const s = sugg({
      matchedTopics: [{ topicId: 'tz', text: 'z' }, { topicId: 'tp', text: 'p' }],
    });
    expect(resolveOwningFactLenient(s, topics, facts, HP)).toBe('fp');
  });

  it('factless (retired topic / null factId / deleted fact) → null (dropped)', () => {
    const retired = new Map([['t', topic({ factId: 'f', status: 'retired' })]]);
    const nullFact = new Map([['t', topic({ factId: null })]]);
    const deleted = new Map([['t', topic({ factId: 'gone' })]]);
    const facts = new Map([['f', fact()]]);
    const s = sugg({ matchedTopics: [{ topicId: 't', text: 'x' }] });
    expect(resolveOwningFactLenient(s, retired, facts, HP)).toBeNull();
    expect(resolveOwningFactLenient(s, nullFact, new Map(), HP)).toBeNull();
    expect(resolveOwningFactLenient(s, deleted, new Map(), HP)).toBeNull();
  });

  it('negative-only match → null (suppression stays dropped)', () => {
    const topics = new Map([['tn', topic({ factId: 'fn', weight: -0.8 })]]);
    const facts = new Map([['fn', fact()]]);
    const s = sugg({ matchedTopics: [{ topicId: 'tn', text: 'x' }] });
    expect(resolveOwningFactLenient(s, topics, facts, HP)).toBeNull();
  });
});
