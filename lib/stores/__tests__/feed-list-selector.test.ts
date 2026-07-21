// feed-list-selector — pure selector tests. RN-free.
//
// Covers the composite score formula (importance + recency decay, with a
// breaking bonus), the deterministic list ordering, the visibility gate,
// story-group collapse (memberCount), the excluded-id drop rule, and the
// NaN-createdAt guard.

import {
  buildFeedList,
  feedCompare,
  feedScore,
  FEED_HALF_LIFE_HOURS,
  FEED_RECENCY_WEIGHT,
  FEED_BREAKING_RECENCY_BONUS,
  type FeedListItem,
} from '../feed-list-selector';
import { ArticleSuggestionStatus } from '@/lib/database/article-suggestion-status';
import type { ClusterMembership, ForYouSuggestion } from '../for-you-store';

const NOW = 1_000_000_000_000; // fixed clock
const H = 3_600_000;

let seq = 0;
function sugg(o: Partial<ForYouSuggestion> = {}): ForYouSuggestion {
  seq += 1;
  const id = o._id ?? `s${seq}`;
  const pub = o.firstPubDate ?? new Date(NOW - H).toISOString();
  return {
    _id: id,
    articleId: o.articleId ?? `art-${id}`,
    clusters: o.clusters ?? [],
    relevance: o.relevance ?? 0.6,
    reason: o.reason ?? 'because',
    status: o.status ?? ArticleSuggestionStatus.Complete,
    country_code: o.country_code ?? null,
    language_code: o.language_code ?? 'en',
    publication_name: o.publication_name ?? 'Pub',
    title_en: o.title_en ?? null,
    title_original: o.title_original ?? null,
    description_en: o.description_en ?? null,
    article_url: o.article_url ?? null,
    image_url: o.image_url ?? null,
    userTopicIds: o.userTopicIds ?? [],
    createdAt: o.createdAt ?? new Date(NOW - H).toISOString(),
    firstPubDate: pub,
    rawScore: o.rawScore ?? 0.5,
    eventType: o.eventType ?? null,
    headlineScope: o.headlineScope ?? null,
    matchedTopics: o.matchedTopics ?? [],
    factIds: o.factIds ?? [],
    scoredAt: o.scoredAt ?? null,
  };
}

function cluster(stableClusterId: string, confidence = 0.9): ClusterMembership {
  return { clusterId: `run-${stableClusterId}`, confidence, stableClusterId };
}

describe('feedScore — formula', () => {
  it('fresh (age 0) rawScore 0.6 outranks 12h-old rawScore 0.9', () => {
    const fresh = sugg({ rawScore: 0.6, createdAt: new Date(NOW).toISOString() });
    const old = sugg({ rawScore: 0.9, createdAt: new Date(NOW - 12 * H).toISOString() });
    expect(feedScore(fresh, NOW)).toBeGreaterThan(feedScore(old, NOW));
  });

  it('fresh breaking (raw 0.9 + bonus) beats a fresh non-breaking rawScore 1.0', () => {
    const breaking = sugg({
      rawScore: 0.9,
      eventType: 'disaster',
      createdAt: new Date(NOW).toISOString(),
    });
    const nonBreaking = sugg({ rawScore: 1.0, createdAt: new Date(NOW).toISOString() });
    expect(feedScore(breaking, NOW)).toBeGreaterThan(feedScore(nonBreaking, NOW));
  });

  it('a 12h-old breaking story loses to a fresh rawScore 1.0 non-breaking story', () => {
    const oldBreaking = sugg({
      rawScore: 0.9,
      eventType: 'disaster',
      createdAt: new Date(NOW - 12 * H).toISOString(),
    });
    const freshNonBreaking = sugg({ rawScore: 1.0, createdAt: new Date(NOW).toISOString() });
    expect(feedScore(freshNonBreaking, NOW)).toBeGreaterThan(feedScore(oldBreaking, NOW));
  });

  it('at age >= 24h, ordering approximates pure importance (decay term is negligible)', () => {
    const hiImportance = sugg({
      rawScore: 0.9,
      eventType: 'disaster', // even with the breaking bonus...
      createdAt: new Date(NOW - 24 * H).toISOString(),
    });
    const loImportance = sugg({
      rawScore: 0.5,
      createdAt: new Date(NOW - 24 * H).toISOString(),
    });
    // Max possible decay contribution at 24h: (0.5 + 0.6) * 2^-4 = 0.06875,
    // far smaller than the 0.4 importance gap, so importance dominates.
    expect(feedScore(hiImportance, NOW)).toBeGreaterThan(feedScore(loImportance, NOW));
    const decayContribution =
      (FEED_RECENCY_WEIGHT + FEED_BREAKING_RECENCY_BONUS) * Math.pow(2, -24 / FEED_HALF_LIFE_HOURS);
    expect(decayContribution).toBeLessThan(0.4);
  });

  it('treats an unparseable createdAt as infinitely old (decay term = 0), not age 0', () => {
    const bad = sugg({ rawScore: 0.7, createdAt: 'not-a-date' });
    expect(feedScore(bad, NOW)).toBeCloseTo(0.7, 10);
  });

  it('clamps rawScore to [0, 1.2] and treats null as 0', () => {
    // Note: the `sugg()` fixture builder's `o.rawScore ?? 0.5` default treats an
    // explicit `null` override as "unset" (same convention as
    // swipe-stack-selector.test.ts), so this constructs the row directly to
    // exercise a genuinely-null rawScore.
    const nullScore: ForYouSuggestion = { ...sugg({ createdAt: new Date(NOW).toISOString() }), rawScore: null };
    expect(feedScore(nullScore, NOW)).toBeCloseTo(0 + FEED_RECENCY_WEIGHT * 1, 10);

    // rawScore 5 clamps to 1.2, but also clears the `isBreaking` threshold
    // (raw > 1.0) on its own, so the breaking bonus applies too.
    const overCap = sugg({ rawScore: 5, createdAt: new Date(NOW).toISOString() });
    expect(feedScore(overCap, NOW)).toBeCloseTo(
      1.2 + (FEED_RECENCY_WEIGHT + FEED_BREAKING_RECENCY_BONUS) * 1,
      10,
    );
  });
});

describe('buildFeedList — visibility gate', () => {
  it('drops unscored, reason_pending, sub-gate and out-of-window rows', () => {
    const unscored = sugg({ _id: 'u', status: ArticleSuggestionStatus.Unscored });
    const pending = sugg({ _id: 'p', status: ArticleSuggestionStatus.ReasonPending });
    const subGate = sugg({ _id: 'g', relevance: 0.3 }); // must be > 0.3
    const stale = sugg({ _id: 'old', firstPubDate: new Date(NOW - 30 * H).toISOString() });
    const good = sugg({ _id: 'ok', relevance: 0.6 });

    const list = buildFeedList([unscored, pending, subGate, stale, good], new Set(), NOW);
    expect(list.map((c) => c.suggestion._id)).toEqual(['ok']);
  });

  it('returns [] for an empty / all-hidden pool', () => {
    expect(buildFeedList([], new Set(), NOW)).toEqual([]);
    const hidden = sugg({ status: ArticleSuggestionStatus.Unscored });
    expect(buildFeedList([hidden], new Set(), NOW)).toEqual([]);
  });
});

describe('buildFeedList — grouping + exclusion', () => {
  it('collapses a shared-stable-cluster story to one item with memberCount', () => {
    const a = sugg({ _id: 'a', clusters: [cluster('story-1')], firstPubDate: new Date(NOW - 2 * H).toISOString() });
    const b = sugg({ _id: 'b', clusters: [cluster('story-1')], firstPubDate: new Date(NOW - H).toISOString() });
    const list = buildFeedList([a, b], new Set(), NOW);
    expect(list).toHaveLength(1);
    expect(list[0].memberCount).toBe(2);
    // newest member (b) fronts the story.
    expect(list[0].suggestion._id).toBe('b');
    expect(list[0].id).toBe('art-b');
  });

  it('excludes a group whose representative is excluded (by article id)', () => {
    const a = sugg({ _id: 'a' });
    const b = sugg({ _id: 'b' });
    const list = buildFeedList([a, b], new Set(['art-a']), NOW);
    expect(list.map((c) => c.suggestion._id)).toEqual(['b']);
  });

  it('excludes a group whose representative is excluded (by stable cluster id)', () => {
    const a = sugg({ _id: 'a', clusters: [cluster('story-x')] });
    const list = buildFeedList([a], new Set(['story-x']), NOW);
    expect(list).toHaveLength(0);
  });

  it('excludes based on the union of opened and viewed ids passed by the caller', () => {
    const a = sugg({ _id: 'a' });
    const b = sugg({ _id: 'b' });
    const c = sugg({ _id: 'c' });
    const excluded = new Set(['art-a', 'art-b']); // opened ∪ viewed
    const list = buildFeedList([a, b, c], excluded, NOW);
    expect(list.map((c) => c.suggestion._id)).toEqual(['c']);
  });
});

describe('buildFeedList — score, breaking flag + frozen score', () => {
  it('marks breaking items and freezes score at build time', () => {
    const breaking = sugg({
      _id: 'brk',
      rawScore: 0.9,
      eventType: 'disaster',
      relevance: 0.9,
      createdAt: new Date(NOW).toISOString(),
    });
    const list = buildFeedList([breaking], new Set(), NOW);
    expect(list[0].breaking).toBe(true);
    expect(list[0].score).toBeCloseTo(feedScore(breaking, NOW), 10);
  });

  it('orders items by feedScore desc', () => {
    const fresh = sugg({ _id: 'fresh', rawScore: 0.6, createdAt: new Date(NOW).toISOString() });
    const old = sugg({ _id: 'old', rawScore: 0.9, createdAt: new Date(NOW - 12 * H).toISOString() });
    const list = buildFeedList([fresh, old], new Set(), NOW);
    expect(list.map((c) => c.suggestion._id)).toEqual(['fresh', 'old']);
  });
});

describe('feedCompare', () => {
  function item(over: Partial<FeedListItem> & { id: string }): FeedListItem {
    return {
      id: over.id,
      memberCount: over.memberCount ?? 1,
      breaking: over.breaking ?? false,
      score: over.score ?? 1,
      suggestion: over.suggestion ?? sugg({ _id: over.id, articleId: over.id }),
    };
  }

  it('breaks score ties on newer firstPubDate first, then id ascending', () => {
    const newer = item({
      id: 'art-z',
      score: 1,
      suggestion: sugg({ _id: 'z', articleId: 'art-z', firstPubDate: new Date(NOW).toISOString() }),
    });
    const older = item({
      id: 'art-a',
      score: 1,
      suggestion: sugg({ _id: 'a', articleId: 'art-a', firstPubDate: new Date(NOW - H).toISOString() }),
    });
    expect([older, newer].sort(feedCompare).map((c) => c.id)).toEqual(['art-z', 'art-a']);
  });

  it('falls back to id ascending when score and firstPubDate both tie', () => {
    const a = item({
      id: 'art-z',
      score: 1,
      suggestion: sugg({ _id: 'z', articleId: 'art-z', firstPubDate: new Date(NOW).toISOString() }),
    });
    const b = item({
      id: 'art-a',
      score: 1,
      suggestion: sugg({ _id: 'a', articleId: 'art-a', firstPubDate: new Date(NOW).toISOString() }),
    });
    expect([a, b].sort(feedCompare).map((c) => c.id)).toEqual(['art-a', 'art-z']);
  });
});
