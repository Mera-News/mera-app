import {
  analyzeHygiene,
  HYGIENE_THRESHOLDS,
  type HygieneAnalyzeInput,
  type HygieneFactInput,
  type HygieneTopicInput,
} from '../fact-hygiene';
import { ACTION_NAMES } from '../action-names';

const NOW = 1_700_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

function fact(
  id: string,
  statement: string,
  weight: number | null = null,
): HygieneFactInput {
  return { id, statement, weight, createdAtMs: NOW - 60 * DAY };
}

function topic(
  id: string,
  factId: string | null,
  text: string,
  opts: Partial<HygieneTopicInput> = {},
): HygieneTopicInput {
  return {
    id,
    factId,
    text,
    normalizedText: opts.normalizedText ?? text.toLowerCase().trim().replace(/\s+/g, ' '),
    weight: opts.weight ?? 0.5,
    status: opts.status ?? 'active',
    lastSignalAtMs: opts.lastSignalAtMs ?? NOW,
  };
}

function run(
  partial: Partial<HygieneAnalyzeInput> & Pick<HygieneAnalyzeInput, 'facts' | 'topics'>,
) {
  return analyzeHygiene({ now: NOW, ...partial });
}

describe('duplicate_facts', () => {
  it('flags near-identical statements and deletes the lower-weight fact', () => {
    const facts = [
      fact('f1', 'I love hiking in the mountains', 0.9),
      fact('f2', 'I love hiking in the mountains often', 0.3), // Jaccard 6/7 ≈ 0.86
    ];
    const proposals = run({ facts, topics: [] });
    const dup = proposals.filter((p) => p.kind === 'duplicate_facts');
    expect(dup).toHaveLength(1);
    expect(dup[0].ops).toEqual([{ type: 'delete_fact', factId: 'f2' }]);
    expect(dup[0].invertible).toBe(false);
    expect(dup[0].targetFactIds).toEqual(['f1', 'f2']);
  });

  it('tie on weight keeps the lexicographically smaller id', () => {
    const facts = [
      fact('fb', 'artificial intelligence and machine learning', 0.5),
      fact('fa', 'artificial intelligence and machine learning', 0.5),
    ];
    const proposals = run({ facts, topics: [] });
    const dup = proposals.find((p) => p.kind === 'duplicate_facts');
    expect(dup?.ops).toEqual([{ type: 'delete_fact', factId: 'fb' }]);
  });

  it('flags facts sharing >=2 normalized topic texts (via fact-stats detector)', () => {
    const facts = [fact('f1', 'sports fan stuff'), fact('f2', 'athletics enthusiast')];
    const topics = [
      topic('t1', 'f1', 'Football'),
      topic('t2', 'f1', 'Cricket'),
      topic('t3', 'f2', 'football'), // same normalized as t1
      topic('t4', 'f2', 'cricket'), // same normalized as t2
    ];
    const proposals = run({ facts, topics });
    const dup = proposals.filter((p) => p.kind === 'duplicate_facts');
    expect(dup).toHaveLength(1);
    expect(dup[0].ops[0]).toMatchObject({ type: 'delete_fact' });
  });

  it('does NOT flag facts sharing only 1 topic text', () => {
    const facts = [fact('f1', 'alpha beta gamma'), fact('f2', 'delta epsilon zeta')];
    const topics = [
      topic('t1', 'f1', 'Football'),
      topic('t2', 'f1', 'Tennis'),
      topic('t3', 'f2', 'football'), // only 1 shared
      topic('t4', 'f2', 'Golf'),
    ];
    const proposals = run({ facts, topics });
    expect(proposals.filter((p) => p.kind === 'duplicate_facts')).toHaveLength(0);
  });

  it('emits ONE proposal when both signals fire for the same pair', () => {
    const facts = [
      fact('f1', 'i follow premier league football closely', 0.8),
      fact('f2', 'i follow premier league football closely too', 0.2),
    ];
    const topics = [
      topic('t1', 'f1', 'Football'),
      topic('t2', 'f1', 'Premier League'),
      topic('t3', 'f2', 'football'),
      topic('t4', 'f2', 'premier league'),
    ];
    const proposals = run({ facts, topics });
    expect(proposals.filter((p) => p.kind === 'duplicate_facts')).toHaveLength(1);
  });
});

describe('too_broad_fact', () => {
  function nineActiveTopics(factId: string): HygieneTopicInput[] {
    return Array.from({ length: 9 }, (_, i) => topic(`bt${i}`, factId, `broad topic ${i}`));
  }

  it('proposes a downweight when active topic fan-out exceeds the threshold', () => {
    const facts = [fact('f1', 'general interests across many areas', 0.8)];
    const topics = nineActiveTopics('f1'); // 9 > 8
    const proposals = run({ facts, topics });
    const broad = proposals.filter((p) => p.kind === 'too_broad_fact');
    expect(broad).toHaveLength(1);
    expect(broad[0].invertible).toBe(true);
    expect(broad[0].ops[0]).toEqual({
      type: 'persona_action',
      action: {
        action_type: ACTION_NAMES.SET_FACT_WEIGHT,
        factId: 'f1',
        delta: HYGIENE_THRESHOLDS.tooBroadDownweightDelta,
      },
    });
  });

  it('does not fire at exactly the fan-out threshold (strictly greater)', () => {
    const facts = [fact('f1', 'general interests across many areas', 0.8)];
    const topics = Array.from({ length: 8 }, (_, i) => topic(`bt${i}`, 'f1', `t ${i}`));
    const proposals = run({ facts, topics });
    expect(proposals.filter((p) => p.kind === 'too_broad_fact')).toHaveLength(0);
  });

  it('flags a single-word (generic) statement', () => {
    const facts = [fact('f1', 'News', 0.8)];
    const proposals = run({ facts, topics: [] });
    expect(proposals.filter((p) => p.kind === 'too_broad_fact')).toHaveLength(1);
  });

  it('is suppressed once the fact weight has converged to the floor', () => {
    const facts = [fact('f1', 'News', 0)]; // effWeight 0 == floor
    const proposals = run({ facts, topics: [] });
    expect(proposals.filter((p) => p.kind === 'too_broad_fact')).toHaveLength(0);
  });
});

describe('stale_topic', () => {
  const idle = NOW - (HYGIENE_THRESHOLDS.staleTopicIdleMs + DAY);

  it('proposes retiring an idle low-weight active topic', () => {
    const topics = [topic('t1', null, 'Winter Olympics', { weight: 0.1, lastSignalAtMs: idle })];
    const proposals = run({ facts: [], topics });
    const stale = proposals.filter((p) => p.kind === 'stale_topic');
    expect(stale).toHaveLength(1);
    expect(stale[0].invertible).toBe(true);
    expect(stale[0].ops[0]).toEqual({
      type: 'persona_action',
      action: { action_type: ACTION_NAMES.RETIRE_TOPIC, topicId: 't1' },
    });
  });

  it('does not fire when weight >= staleTopicMaxWeight', () => {
    const topics = [topic('t1', null, 'x', { weight: 0.3, lastSignalAtMs: idle })];
    expect(run({ facts: [], topics }).filter((p) => p.kind === 'stale_topic')).toHaveLength(0);
  });

  it('leaves negative-weight topics alone', () => {
    const topics = [topic('t1', null, 'x', { weight: -0.4, lastSignalAtMs: idle })];
    expect(run({ facts: [], topics }).filter((p) => p.kind === 'stale_topic')).toHaveLength(0);
  });

  it('does not fire when recently signaled', () => {
    const topics = [topic('t1', null, 'x', { weight: 0.1, lastSignalAtMs: NOW - DAY })];
    expect(run({ facts: [], topics }).filter((p) => p.kind === 'stale_topic')).toHaveLength(0);
  });

  it('does not fire when never signaled (null lastSignalAt)', () => {
    const topics = [topic('t1', null, 'x', { weight: 0.1, lastSignalAtMs: null })];
    expect(run({ facts: [], topics }).filter((p) => p.kind === 'stale_topic')).toHaveLength(0);
  });

  it('does not fire for suppressed/retired topics', () => {
    const topics = [
      topic('t1', null, 'x', { weight: 0.1, lastSignalAtMs: idle, status: 'suppressed' }),
    ];
    expect(run({ facts: [], topics }).filter((p) => p.kind === 'stale_topic')).toHaveLength(0);
  });
});

describe('stale_fact', () => {
  it('proposes deleting a fact whose topics are ALL retired/suppressed', () => {
    const facts = [fact('f1', 'defunct interest')];
    const topics = [
      topic('t1', 'f1', 'a', { status: 'retired' }),
      topic('t2', 'f1', 'b', { status: 'suppressed' }),
    ];
    const proposals = run({ facts, topics });
    const stale = proposals.filter((p) => p.kind === 'stale_fact');
    expect(stale).toHaveLength(1);
    expect(stale[0].ops).toEqual([{ type: 'delete_fact', factId: 'f1' }]);
    expect(stale[0].invertible).toBe(false);
  });

  it('does not fire when the fact still has an active topic', () => {
    const facts = [fact('f1', 'live interest')];
    const topics = [
      topic('t1', 'f1', 'a', { status: 'retired' }),
      topic('t2', 'f1', 'b', { status: 'active' }),
    ];
    expect(run({ facts, topics }).filter((p) => p.kind === 'stale_fact')).toHaveLength(0);
  });

  it('does not fire for a fact with zero topics (may still be generating)', () => {
    const facts = [fact('f1', 'brand new fact')];
    expect(run({ facts, topics: [] }).filter((p) => p.kind === 'stale_fact')).toHaveLength(0);
  });

  it('does not also emit too_broad for a fact being deleted', () => {
    // Single-word statement would normally trigger too_broad, but all-retired
    // topics make it a stale_fact delete — the delete wins, no downweight.
    const facts = [fact('f1', 'News', 0.9)];
    const topics = [topic('t1', 'f1', 'a', { status: 'retired' })];
    const proposals = run({ facts, topics });
    expect(proposals.filter((p) => p.kind === 'stale_fact')).toHaveLength(1);
    expect(proposals.filter((p) => p.kind === 'too_broad_fact')).toHaveLength(0);
  });
});

describe('rejected-fingerprint suppression', () => {
  it('never re-proposes a rejected fingerprint', () => {
    const facts = [fact('f1', 'News', 0.8)];
    const first = run({ facts, topics: [] });
    const broad = first.find((p) => p.kind === 'too_broad_fact');
    expect(broad).toBeDefined();

    const second = run({ facts, topics: [], rejectedFingerprints: [broad!.id] });
    expect(second.filter((p) => p.kind === 'too_broad_fact')).toHaveLength(0);
  });

  it('stable fingerprints are reproducible across runs (dedup key)', () => {
    const facts = [fact('f1', 'News', 0.8)];
    const a = run({ facts, topics: [] });
    const b = run({ facts, topics: [] });
    expect(a.map((p) => p.id)).toEqual(b.map((p) => p.id));
  });
});

describe('ordering', () => {
  it('sorts by kind (duplicate, stale_fact, too_broad, stale_topic) then id', () => {
    const facts = [
      fact('f1', 'i really enjoy premier league football matches', 0.8),
      fact('f2', 'i really enjoy premier league football matches now', 0.2),
      fact('f3', 'News', 0.9),
    ];
    const idle = NOW - (HYGIENE_THRESHOLDS.staleTopicIdleMs + DAY);
    const topics = [topic('t1', null, 'quiet', { weight: 0.1, lastSignalAtMs: idle })];
    const proposals = run({ facts, topics });
    const kinds = proposals.map((p) => p.kind);
    // duplicate_facts must precede too_broad_fact which must precede stale_topic.
    expect(kinds.indexOf('duplicate_facts')).toBeLessThan(kinds.indexOf('too_broad_fact'));
    expect(kinds.indexOf('too_broad_fact')).toBeLessThan(kinds.indexOf('stale_topic'));
  });
});
