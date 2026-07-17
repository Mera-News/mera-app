import {
  getFactSectionStats,
  getTopicYieldStats,
  findTopicOverlapAcrossFacts,
  type FactStatSuggestion,
  type FactStatTopicInfo,
  type FactStatImpression,
  type FactStatTopic,
} from '../fact-stats';

// --- Shared fixtures -------------------------------------------------------

const topicMap = new Map<string, FactStatTopicInfo>([
  ['t1', { factId: 'f1', weight: 0.8, status: 'active', lastSignalAtMs: 1000 }],
  ['t2', { factId: 'f1', weight: 0.5, status: 'active', lastSignalAtMs: 2000 }],
  ['t3', { factId: 'f2', weight: 0.6, status: 'active', lastSignalAtMs: null }],
  ['tneg', { factId: 'f1', weight: -0.5, status: 'active', lastSignalAtMs: null }],
]);

const topicList: FactStatTopic[] = [
  { id: 't1', factId: 'f1', weight: 0.8, status: 'active' },
  { id: 't2', factId: 'f1', weight: 0.5, status: 'active' },
  { id: 't3', factId: 'f2', weight: 0.6, status: 'active' },
  { id: 'tneg', factId: 'f1', weight: -0.5, status: 'active' },
];

const suggestions: FactStatSuggestion[] = [
  // s1 → owner t1 (0.8) → f1; scored ≥ floor
  { id: 'a1', articleId: 'a1', rawScore: 0.5, pubDateMs: 100, matchedTopics: [{ topicId: 't1' }, { topicId: 't2' }] },
  // s2 → owner t2 (0.5) → f1; below floor
  { id: 'a2', articleId: 'a2', rawScore: 0.3, pubDateMs: 200, matchedTopics: [{ topicId: 't2' }] },
  // s3 → owner t3 → f2; scored ≥ floor
  { id: 'a3', articleId: 'a3', rawScore: 0.9, pubDateMs: 300, matchedTopics: [{ topicId: 't3' }] },
  // s4 → owner t1 → f1; unscored (null)
  { id: 'a4', articleId: 'a4', rawScore: null, pubDateMs: 400, matchedTopics: [{ topicId: 't1' }] },
];

const impressions = new Map<string, FactStatImpression>([
  ['a1', { opened: true }],
  ['a2', { opened: false }],
]);

describe('getFactSectionStats', () => {
  const stats = getFactSectionStats({ suggestions, topics: topicMap, impressions, topicList });

  it('joins each suggestion to its highest-weight active topic owner', () => {
    expect(stats.get('f1')!.articleCount).toBe(3); // s1, s2, s4
    expect(stats.get('f2')!.articleCount).toBe(1); // s3
  });

  it('feedCount uses the discardFloor (0.40) threshold', () => {
    // f1: only s1 (0.5) clears; s2 (0.3) and s4 (null) do not.
    expect(stats.get('f1')!.feedCount).toBe(1);
    expect(stats.get('f2')!.feedCount).toBe(1);
  });

  it('averages only non-null raw scores', () => {
    // f1: (0.5 + 0.3) / 2 = 0.4 ; s4's null is excluded.
    expect(stats.get('f1')!.avgRawScore).toBeCloseTo(0.4, 6);
    expect(stats.get('f2')!.avgRawScore).toBeCloseTo(0.9, 6);
  });

  it('tracks newest article, impressions and opens', () => {
    const f1 = stats.get('f1')!;
    expect(f1.lastArticleAtMs).toBe(400);
    expect(f1.impressions).toBe(2); // a1, a2 have rows; a4 has none
    expect(f1.opens).toBe(1); // a1 opened
    expect(stats.get('f2')!.impressions).toBe(0); // a3 has no impression row
  });

  it('counts active + negative topics and the newest last-signal per fact', () => {
    const f1 = stats.get('f1')!;
    expect(f1.activeTopicCount).toBe(3); // t1, t2, tneg
    expect(f1.negativeTopicCount).toBe(1); // tneg
    expect(f1.lastSignalAtMs).toBe(2000); // max(1000, 2000, 0)

    const f2 = stats.get('f2')!;
    expect(f2.activeTopicCount).toBe(1);
    expect(f2.negativeTopicCount).toBe(0);
    expect(f2.lastSignalAtMs).toBe(0);
  });
});

describe('getTopicYieldStats', () => {
  const yields = getTopicYieldStats(suggestions);

  it('credits every matched topic (not just the owner) and averages scored rows', () => {
    expect(yields.get('t1')).toEqual({ articleCount: 2, avgRawScore: 0.5 }); // s1, s4(null)
    expect(yields.get('t2')!.articleCount).toBe(2); // s1, s2
    expect(yields.get('t2')!.avgRawScore).toBeCloseTo(0.4, 6);
    expect(yields.get('t3')).toEqual({ articleCount: 1, avgRawScore: 0.9 });
  });

  it('omits topics no suggestion matched', () => {
    expect(yields.has('tneg')).toBe(false);
  });
});

describe('findTopicOverlapAcrossFacts', () => {
  it('groups a normalized text shared by ≥2 distinct facts, ignoring null-fact + single-fact', () => {
    const groups = findTopicOverlapAcrossFacts([
      { id: 't1', factId: 'f1', normalizedText: 'india news' },
      { id: 't2', factId: 'f2', normalizedText: 'india news' }, // cross-fact dupe
      { id: 't6', factId: null, normalizedText: 'india news' }, // null fact ignored
      { id: 't3', factId: 'f1', normalizedText: 'sports' }, // single topic
      { id: 't4', factId: 'f1', normalizedText: 'weather' },
      { id: 't5', factId: 'f1', normalizedText: 'weather' }, // same fact → not grouped
    ]);
    expect(groups).toEqual([
      { normalizedText: 'india news', topicIds: ['t1', 't2'], factIds: ['f1', 'f2'] },
    ]);
  });

  it('returns an empty list when no text is shared across facts', () => {
    expect(
      findTopicOverlapAcrossFacts([
        { id: 't1', factId: 'f1', normalizedText: 'a' },
        { id: 't2', factId: 'f2', normalizedText: 'b' },
      ]),
    ).toEqual([]);
  });
});
