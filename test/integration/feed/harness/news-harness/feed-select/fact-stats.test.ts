import { findTopicOverlapAcrossFacts } from '@/lib/news-harness/feed-select/fact-stats';

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
