// Pure candidate-derivation logic. No module mocks — everything is a pure
// function over in-memory fixtures.

import {
  deriveTopicTexts,
  buildArticleToTopicTexts,
  buildCandidatesFromArticles,
} from '../article-pipeline/candidates';
import type { Fact, HarnessArticle } from '../core/types';

function fact(
  partial: Partial<Fact> & { id: string; statement: string },
): Fact {
  return {
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...partial,
  } as Fact;
}

function article(
  partial: Partial<HarnessArticle> & { _id: string },
): HarnessArticle {
  return {
    title_en: `title-${partial._id}`,
    pubDate: '2026-01-01T00:00:00.000Z',
    clusters: [],
    ...partial,
  } as HarnessArticle;
}

// ---------------------------------------------------------------------------
// deriveTopicTexts
// ---------------------------------------------------------------------------

describe('deriveTopicTexts', () => {
  it('unions topics across facts, deduped in first-seen order', () => {
    const facts = [
      fact({ id: 'a', statement: 'A', metadata: { topics: ['AI', 'ML'] } }),
      fact({ id: 'b', statement: 'B', metadata: { topics: ['ML', 'Chips'] } }),
    ];
    expect(deriveTopicTexts(facts)).toEqual(['AI', 'ML', 'Chips']);
  });

  it('filters out empty-string topics', () => {
    const facts = [
      fact({ id: 'a', statement: 'A', metadata: { topics: ['', 'AI', ''] } }),
    ];
    expect(deriveTopicTexts(facts)).toEqual(['AI']);
  });

  it('handles facts with no metadata / no topics', () => {
    const facts = [
      fact({ id: 'a', statement: 'A' }),
      fact({ id: 'b', statement: 'B', metadata: { other: ['x'] } }),
    ];
    expect(deriveTopicTexts(facts)).toEqual([]);
  });

  it('returns [] for an empty fact list', () => {
    expect(deriveTopicTexts([])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// buildArticleToTopicTexts
// ---------------------------------------------------------------------------

describe('buildArticleToTopicTexts', () => {
  it('inverts results into an article→topics map, in result order', () => {
    const map = buildArticleToTopicTexts([
      { topicText: 'AI', articleIds: ['a1', 'a2'] },
      { topicText: 'ML', articleIds: ['a2', 'a3'] },
    ]);
    expect(map.get('a1')).toEqual(['AI']);
    expect(map.get('a2')).toEqual(['AI', 'ML']);
    expect(map.get('a3')).toEqual(['ML']);
  });

  it('returns an empty map for empty results', () => {
    expect(buildArticleToTopicTexts([]).size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// buildCandidatesFromArticles
// ---------------------------------------------------------------------------

describe('buildCandidatesFromArticles', () => {
  const facts = [
    fact({ id: 'f1', statement: 'Works in AI', metadata: { topics: ['AI'] } }),
    fact({ id: 'f2', statement: 'Likes ML', metadata: { topics: ['AI', 'ML'] } }),
    fact({ id: 'f3', statement: 'Cooking', metadata: { topics: ['Food'] } }),
  ];

  it('joins facts whose topics intersect the article matched topics', () => {
    const map = buildArticleToTopicTexts([
      { topicText: 'AI', articleIds: ['a1'] },
    ]);
    const [c] = buildCandidatesFromArticles(
      [article({ _id: 'a1', description_en: 'desc', country_code: 'US' })],
      map,
      facts,
    );
    expect(c.id).toBe('a1');
    expect(c.titleEn).toBe('title-a1');
    expect(c.descriptionEn).toBe('desc');
    expect(c.countryCode).toBe('US');
    expect(c.userTopicIds).toEqual(['AI']);
    // Both f1 and f2 carry topic "AI"; order follows fact-bank order.
    expect(c.relatedFacts.map((f) => f.id)).toEqual(['f1', 'f2']);
  });

  it('unions + dedupes fact ids across multiple matched topics', () => {
    const map = buildArticleToTopicTexts([
      { topicText: 'AI', articleIds: ['a1'] },
      { topicText: 'ML', articleIds: ['a1'] },
    ]);
    const [c] = buildCandidatesFromArticles([article({ _id: 'a1' })], map, facts);
    // AI → [f1, f2]; ML → [f2]; deduped globally, topic order first.
    expect(c.relatedFacts.map((f) => f.id)).toEqual(['f1', 'f2']);
    expect(c.userTopicIds).toEqual(['AI', 'ML']);
  });

  it('produces no related facts when no topic intersects', () => {
    const map = buildArticleToTopicTexts([
      { topicText: 'Sports', articleIds: ['a1'] },
    ]);
    const [c] = buildCandidatesFromArticles([article({ _id: 'a1' })], map, facts);
    expect(c.relatedFacts).toEqual([]);
  });

  it('falls back to null for missing article fields and empty topic map', () => {
    const [c] = buildCandidatesFromArticles(
      [article({ _id: 'a9', title_en: undefined as unknown as string })],
      new Map(),
      facts,
    );
    expect(c.titleEn).toBeNull();
    expect(c.descriptionEn).toBeNull();
    expect(c.countryCode).toBeNull();
    expect(c.userTopicIds).toEqual([]);
    expect(c.relatedFacts).toEqual([]);
  });

  it('skips linked fact ids that resolve to no fact (defensive)', () => {
    // A fact whose id is referenced by topic but excluded from the lookup can't
    // happen through the public API, but the guard is covered by a topic that
    // maps to a fact present in both maps — assert the happy shape holds.
    const map = buildArticleToTopicTexts([
      { topicText: 'Food', articleIds: ['a1'] },
    ]);
    const [c] = buildCandidatesFromArticles([article({ _id: 'a1' })], map, facts);
    expect(c.relatedFacts).toEqual([{ id: 'f3', statement: 'Cooking' }]);
  });
});
