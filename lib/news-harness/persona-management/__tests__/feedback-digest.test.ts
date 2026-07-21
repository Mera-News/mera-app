import {
  analyzeFeedback,
  DIGEST_CONSTANTS,
  type DigestAnalyzeInput,
  type DigestSignal,
} from '../feedback-digest';
import { ACTION_NAMES } from '../action-names';

const NOW = 1_700_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

function signal(
  id: string,
  sentiment: 'like' | 'dislike',
  opts: {
    title?: string;
    topics?: { topicId?: string; text: string }[];
    relevance?: number;
    eventType?: string;
    category?: string;
    publication?: string;
    treePath?: string[];
  } = {},
): DigestSignal {
  return {
    id,
    sentiment,
    title: opts.title ?? `story ${id}`,
    createdAtMs: NOW - DAY,
    context: {
      ...(opts.topics ? { matchedTopics: opts.topics } : {}),
      ...(typeof opts.relevance === 'number' ? { relevance: opts.relevance } : {}),
      ...(opts.eventType ? { eventType: opts.eventType } : {}),
      ...(opts.category ? { category: opts.category } : {}),
      ...(opts.publication ? { publication: opts.publication } : {}),
    },
    ...(opts.treePath ? { treePath: opts.treePath } : {}),
  };
}

function run(partial: Partial<DigestAnalyzeInput> & Pick<DigestAnalyzeInput, 'signals'>) {
  return analyzeFeedback({ topics: [], now: NOW, ...partial });
}

describe('path-mapped candidates', () => {
  it('like + a_lot_more → strong topic boost (auto)', () => {
    const c = run({
      signals: [signal('r1', 'like', { topics: [{ topicId: 't1', text: 'Climate' }], treePath: ['more_about_topic', 'a_lot_more'] })],
    });
    expect(c).toHaveLength(1);
    expect(c[0].kind).toBe('topic_up');
    expect(c[0].confidence).toBe('auto');
    expect(c[0].ops[0]).toMatchObject({
      action_type: ACTION_NAMES.SET_TOPIC_WEIGHT,
      topicId: 't1',
      delta: DIGEST_CONSTANTS.pathBoostStrong,
    });
    expect(c[0].fingerprint).toBe('topic_up:t1');
  });

  it('like + a_bit_more → mild boost', () => {
    const c = run({
      signals: [signal('r1', 'like', { topics: [{ topicId: 't1', text: 'Climate' }], treePath: ['more_about_topic', 'a_bit_more'] })],
    });
    expect(c[0].ops[0].delta).toBe(DIGEST_CONSTANTS.pathBoostMild);
  });

  it('dislike + wrong_topic → topic down (auto)', () => {
    const c = run({
      signals: [signal('r1', 'dislike', { topics: [{ topicId: 't1', text: 'Cricket' }], treePath: ['suggestion', 'not_related', 'wrong_topic'] })],
    });
    expect(c[0].kind).toBe('topic_down');
    expect(c[0].ops[0].delta).toBe(DIGEST_CONSTANTS.pathLowerTopic);
    expect(c[0].confidence).toBe('auto');
  });

  it('dislike + not_important → mild down', () => {
    const c = run({
      signals: [signal('r1', 'dislike', { topics: [{ topicId: 't1', text: 'Cricket' }], treePath: ['suggestion', 'not_important'] })],
    });
    expect(c[0].ops[0].delta).toBe(DIGEST_CONSTANTS.pathLowerMild);
  });

  it('dislike + this_kind_of_event → suppression (review)', () => {
    const c = run({
      signals: [signal('r1', 'dislike', { eventType: 'earnings-call', treePath: ['not_important_to_me', 'this_kind_of_event'] })],
    });
    expect(c[0].kind).toBe('suppress');
    expect(c[0].confidence).toBe('review');
    expect(c[0].ops[0]).toMatchObject({ action_type: ACTION_NAMES.ADD_SUPPRESSION, suppressionPattern: 'earnings-call' });
    expect(c[0].fingerprint).toBe('suppress:evt:earnings-call');
  });

  it('dislike + too_many → title-keyword suppression (review)', () => {
    const c = run({
      signals: [signal('r1', 'dislike', { title: 'Celebrity gossip roundup weekly', treePath: ['suggestion', 'too_many'] })],
    });
    expect(c[0].kind).toBe('suppress');
    expect(c[0].ops[0].suppressionKeywords?.length).toBeGreaterThan(0);
  });

  it('like + more_from_publication with a publication id → publication boost (auto)', () => {
    const c = run({
      signals: [signal('r1', 'like', { publication: 'pub-123', treePath: ['more_from_publication'] })],
    });
    expect(c[0].kind).toBe('publication_up');
    expect(c[0].confidence).toBe('auto');
  });

  it('unmappable leaf (openChat/geo without geo text) → no candidate', () => {
    const c = run({
      signals: [signal('r1', 'dislike', { treePath: ['suggestion', 'not_related', 'something_else'] })],
    });
    expect(c).toHaveLength(0);
  });
});

describe('verdict-only aggregation', () => {
  it('≥2 dislikes on a matched topic → down-weight', () => {
    const c = run({
      signals: [
        signal('r1', 'dislike', { topics: [{ topicId: 't1', text: 'Cricket' }], relevance: 0.7 }),
        signal('r2', 'dislike', { topics: [{ topicId: 't1', text: 'Cricket' }], relevance: 0.8 }),
      ],
    });
    const down = c.find((x) => x.kind === 'topic_down');
    expect(down).toBeDefined();
    expect(down!.ops[0].delta).toBe(DIGEST_CONSTANTS.aggregateDislikeDelta);
    expect(down!.sourceRowIds).toEqual(['r1', 'r2']);
  });

  it('≥3 dislikes, all low relevance → retire candidate (review) not down-weight', () => {
    const c = run({
      signals: [
        signal('r1', 'dislike', { topics: [{ topicId: 't1', text: 'Cricket' }], relevance: 0.2 }),
        signal('r2', 'dislike', { topics: [{ topicId: 't1', text: 'Cricket' }], relevance: 0.3 }),
        signal('r3', 'dislike', { topics: [{ topicId: 't1', text: 'Cricket' }], relevance: 0.1 }),
      ],
    });
    const retire = c.find((x) => x.kind === 'retire_topic');
    expect(retire).toBeDefined();
    expect(retire!.confidence).toBe('review');
    expect(c.find((x) => x.kind === 'topic_down')).toBeUndefined();
  });

  it('≥2 likes on a matched topic → up-weight', () => {
    const c = run({
      signals: [
        signal('r1', 'like', { topics: [{ topicId: 't1', text: 'Space' }] }),
        signal('r2', 'like', { topics: [{ topicId: 't1', text: 'Space' }] }),
      ],
    });
    expect(c.find((x) => x.kind === 'topic_up')?.ops[0].delta).toBe(DIGEST_CONSTANTS.aggregateLikeDelta);
  });

  it('≥2 dislikes sharing an event-type → suppression', () => {
    const c = run({
      signals: [
        signal('r1', 'dislike', { eventType: 'obituary' }),
        signal('r2', 'dislike', { eventType: 'obituary' }),
      ],
    });
    expect(c.find((x) => x.kind === 'suppress' && x.fingerprint === 'suppress:evt:obituary')).toBeDefined();
  });

  it('skips aggregation on already-retired topics', () => {
    const c = run({
      signals: [
        signal('r1', 'dislike', { topics: [{ topicId: 't1', text: 'Cricket' }] }),
        signal('r2', 'dislike', { topics: [{ topicId: 't1', text: 'Cricket' }] }),
      ],
      topics: [{ id: 't1', text: 'Cricket', normalizedText: 'cricket', weight: 0.2, status: 'retired', highPriority: false }],
    });
    expect(c).toHaveLength(0);
  });
});

describe('conflict detection', () => {
  it('a retire candidate lists liked stories sharing the topic → review', () => {
    const c = run({
      signals: [
        signal('r1', 'dislike', { topics: [{ topicId: 't1', text: 'AI' }], relevance: 0.2 }),
        signal('r2', 'dislike', { topics: [{ topicId: 't1', text: 'AI' }], relevance: 0.1 }),
        signal('r3', 'dislike', { topics: [{ topicId: 't1', text: 'AI' }], relevance: 0.3 }),
        signal('r4', 'like', { title: 'A breakthrough in AI research', topics: [{ topicId: 't1', text: 'AI' }] }),
      ],
    });
    const retire = c.find((x) => x.kind === 'retire_topic');
    expect(retire).toBeDefined();
    expect(retire!.conflictsWith.length).toBe(1);
    expect(retire!.conflictsWith[0].title).toContain('AI research');
    expect(retire!.confidence).toBe('review');
  });
});

describe('fingerprint stability + rejected filtering', () => {
  const base: DigestSignal[] = [
    signal('r1', 'dislike', { eventType: 'obituary' }),
    signal('r2', 'dislike', { eventType: 'obituary' }),
  ];

  it('produces the same fingerprint across runs', () => {
    const a = run({ signals: base });
    const b = run({ signals: base });
    expect(a[0].fingerprint).toBe(b[0].fingerprint);
  });

  it('rejected fingerprints are filtered out', () => {
    const a = run({ signals: base });
    const fp = a[0].fingerprint;
    const b = run({ signals: base, rejectedFingerprints: [fp] });
    expect(b.find((x) => x.fingerprint === fp)).toBeUndefined();
  });
});

describe('caps', () => {
  it('caps auto ≤ 8 and review ≤ 5', () => {
    const signals: DigestSignal[] = [];
    // 12 distinct topics, each with 2 likes → 12 auto topic_up candidates.
    for (let i = 0; i < 12; i++) {
      signals.push(signal(`up-a-${i}`, 'like', { topics: [{ topicId: `t${i}`, text: `Topic${i}` }] }));
      signals.push(signal(`up-b-${i}`, 'like', { topics: [{ topicId: `t${i}`, text: `Topic${i}` }] }));
    }
    // 7 distinct event-types, each disliked twice → 7 review suppressions.
    for (let i = 0; i < 7; i++) {
      signals.push(signal(`ev-a-${i}`, 'dislike', { eventType: `evt${i}` }));
      signals.push(signal(`ev-b-${i}`, 'dislike', { eventType: `evt${i}` }));
    }
    const c = run({ signals });
    expect(c.filter((x) => x.confidence === 'auto').length).toBe(DIGEST_CONSTANTS.maxAutoCandidates);
    expect(c.filter((x) => x.confidence === 'review').length).toBe(DIGEST_CONSTANTS.maxReviewCandidates);
  });
});

export {};
