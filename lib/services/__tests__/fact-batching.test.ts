// fact-batching.test.ts — pure per-fact grouping (Round-3 B1).

import {
  groupCandidatesByPrimaryFact,
  MIN_FACT_GROUP,
  type FactGroupingCandidate,
} from '@/lib/services/fact-batching';
import type { TopicSnapshot, FactSnapshot } from '@/lib/news-harness/feed-select';

const cand = (
  id: string,
  topicId: string | null,
  relatedFacts: { id: string; statement: string }[] = [],
): FactGroupingCandidate => ({
  id,
  matchedTopics: topicId ? [{ topicId, text: 't' }] : [],
  relatedFacts,
});

const topic = (factId: string | null, weight = 1): TopicSnapshot => ({
  factId,
  weight,
  highPriority: false,
  status: 'active',
});

const fact = (weight: number | null, createdAtMs = 0, statement?: string): FactSnapshot => ({
  weight,
  createdAtMs,
  statement,
});

describe('groupCandidatesByPrimaryFact', () => {
  it('with empty snapshots, every id lands in one factId:null tail (sequential chunks)', () => {
    const ids = ['a', 'b', 'c'];
    const specs = groupCandidatesByPrimaryFact(
      ids,
      new Map(),
      new Map(),
      new Map(),
      2,
    );
    expect(specs).toEqual([
      { factId: null, factStatement: null, ids: ['a', 'b'] },
      { factId: null, factStatement: null, ids: ['c'] },
    ]);
  });

  it('groups by primary fact, orders fact groups by weight desc, and tails sub-MIN_FACT_GROUP facts', () => {
    // f1 owns 3 (survives), f2 owns 1 (< MIN_FACT_GROUP → tail), plus one orphan.
    const ids = ['a0', 'a1', 'a2', 'b0', 'orphan'];
    const metaById = new Map<string, FactGroupingCandidate>([
      ['a0', cand('a0', 't1', [{ id: 'f1', statement: 'Fact one' }])],
      ['a1', cand('a1', 't1', [{ id: 'f1', statement: 'Fact one' }])],
      ['a2', cand('a2', 't1', [{ id: 'f1', statement: 'Fact one' }])],
      ['b0', cand('b0', 't2', [{ id: 'f2', statement: 'Fact two' }])],
      ['orphan', cand('orphan', null)],
    ]);
    const topics = new Map<string, TopicSnapshot>([
      ['t1', topic('f1')],
      ['t2', topic('f2')],
    ]);
    const facts = new Map<string, FactSnapshot>([
      ['f1', fact(0.5, 0, 'Fact one')],
      ['f2', fact(0.9, 0, 'Fact two')],
    ]);

    expect(MIN_FACT_GROUP).toBe(3);
    const specs = groupCandidatesByPrimaryFact(ids, metaById, topics, facts, 25);

    // Only f1 survives (3 ≥ MIN_FACT_GROUP); its statement comes from relatedFacts.
    // b0 (f2, 1 candidate) + orphan collapse into the null tail, in enqueue order.
    expect(specs).toEqual([
      { factId: 'f1', factStatement: 'Fact one', ids: ['a0', 'a1', 'a2'] },
      { factId: null, factStatement: null, ids: ['b0', 'orphan'] },
    ]);
  });

  it('orders multiple surviving fact groups by fact weight desc, then id asc', () => {
    const mk = (fid: string, n: number) =>
      Array.from({ length: n }, (_, i) => `${fid}-${i}`);
    const ids = [...mk('f1', 3), ...mk('f2', 3)];
    const metaById = new Map<string, FactGroupingCandidate>();
    for (const id of mk('f1', 3)) metaById.set(id, cand(id, 't1', [{ id: 'f1', statement: 'One' }]));
    for (const id of mk('f2', 3)) metaById.set(id, cand(id, 't2', [{ id: 'f2', statement: 'Two' }]));
    const topics = new Map<string, TopicSnapshot>([
      ['t1', topic('f1')],
      ['t2', topic('f2')],
    ]);
    // f2 has the higher fact weight → its group comes first.
    const facts = new Map<string, FactSnapshot>([
      ['f1', fact(0.4)],
      ['f2', fact(0.8)],
    ]);
    const specs = groupCandidatesByPrimaryFact(ids, metaById, topics, facts, 25);
    // Both facts survive; the tail is empty so no null spec is emitted.
    expect(specs.map((s) => s.factId)).toEqual(['f2', 'f1']);
  });
});
