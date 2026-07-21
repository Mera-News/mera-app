// feed-list-selector — pure selector tests. RN-free.
//
// Covers the composite score formula (importance + recency decay, with a
// breaking bonus), the deterministic list ordering, the visibility gate,
// story-group collapse (memberCount), the excluded-id drop rule, and the
// NaN-createdAt guard.

import {
  buildFeedList,
  buildProvisionalFeedList,
  feedCompare,
  feedScore,
  FEED_HALF_LIFE_HOURS,
  FEED_RECENCY_WEIGHT,
  FEED_BREAKING_RECENCY_BONUS,
  PROVISIONAL_FEED_CAP,
  type FeedListItem,
} from '../feed-list-selector';
import { ArticleSuggestionStatus } from '@/lib/database/article-suggestion-status';
import type { UserGeoLanguageContext } from '@/lib/feed-grouping/geo-language-priority';
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

describe('buildFeedList — representative election (geo/language priority, Wave 2b)', () => {
  it('home-country sibling becomes representative even when another sibling is newer/higher-scored', () => {
    const ctx: UserGeoLanguageContext = {
      homeCountryAlpha3: 'IND',
      otherCountriesAlpha3: [],
      appLanguageBase: 'en',
    };
    const home = sugg({
      _id: 'home',
      country_code: 'IND',
      firstPubDate: new Date(NOW - 5 * H).toISOString(),
      rawScore: 0.4,
      clusters: [cluster('story-1')],
    });
    const newer = sugg({
      _id: 'newer',
      country_code: 'USA',
      firstPubDate: new Date(NOW - 1 * H).toISOString(),
      rawScore: 0.9,
      clusters: [cluster('story-1')],
    });
    const list = buildFeedList([home, newer], new Set(), NOW, ctx);
    expect(list).toHaveLength(1);
    expect(list[0].suggestion._id).toBe('home');
    expect(list[0].memberCount).toBe(2);
  });

  it('an other-user-country sibling beats an app-language-match sibling', () => {
    const ctx: UserGeoLanguageContext = {
      homeCountryAlpha3: null,
      otherCountriesAlpha3: ['GBR'],
      appLanguageBase: 'fr',
    };
    const otherCountry = sugg({
      _id: 'gbr',
      country_code: 'GBR',
      language_code: 'en',
      firstPubDate: new Date(NOW - 5 * H).toISOString(),
      rawScore: 0.3,
      clusters: [cluster('story-2')],
    });
    const langMatch = sugg({
      _id: 'fr',
      country_code: null,
      language_code: 'fr',
      firstPubDate: new Date(NOW - 1 * H).toISOString(),
      rawScore: 0.9,
      clusters: [cluster('story-2')],
    });
    const list = buildFeedList([otherCountry, langMatch], new Set(), NOW, ctx);
    expect(list[0].suggestion._id).toBe('gbr');
  });

  it('a null userCtx (default) keeps the legacy newest/rawScore-based pick', () => {
    const older = sugg({
      _id: 'older',
      country_code: 'IND',
      firstPubDate: new Date(NOW - 5 * H).toISOString(),
      rawScore: 0.4,
      clusters: [cluster('story-3')],
    });
    const newer = sugg({
      _id: 'newer',
      country_code: 'USA',
      firstPubDate: new Date(NOW - 1 * H).toISOString(),
      rawScore: 0.9,
      clusters: [cluster('story-3')],
    });
    // Explicit `null` and the omitted-argument default must agree.
    expect(buildFeedList([older, newer], new Set(), NOW, null)[0].suggestion._id).toBe('newer');
    expect(buildFeedList([older, newer], new Set(), NOW)[0].suggestion._id).toBe('newer');
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

describe('buildProvisionalFeedList', () => {
  it('admits UNSCORED rows (which buildFeedList hides) and stamps score 0 + provisional:true', () => {
    const u = sugg({ _id: 'u', status: ArticleSuggestionStatus.Unscored, relevance: 0 });
    // buildFeedList's render gate hides it…
    expect(buildFeedList([u], new Set(), NOW)).toEqual([]);
    // …but the provisional list surfaces it.
    const list = buildProvisionalFeedList([u], new Set(), NOW);
    expect(list).toHaveLength(1);
    expect(list[0].suggestion._id).toBe('u');
    expect(list[0].score).toBe(0);
    expect(list[0].provisional).toBe(true);
  });

  it('orders newest firstPubDate first, id ascending on a pubDate tie', () => {
    const older = sugg({ _id: 'a', articleId: 'art-a', status: ArticleSuggestionStatus.Unscored, firstPubDate: new Date(NOW - 3 * H).toISOString() });
    const newer = sugg({ _id: 'b', articleId: 'art-b', status: ArticleSuggestionStatus.Unscored, firstPubDate: new Date(NOW - H).toISOString() });
    const tie = sugg({ _id: 'c', articleId: 'art-c', status: ArticleSuggestionStatus.Unscored, firstPubDate: new Date(NOW - H).toISOString() });
    const list = buildProvisionalFeedList([older, newer, tie], new Set(), NOW);
    // newer & tie share pubDate → id asc (art-b before art-c); older last.
    expect(list.map((c) => c.id)).toEqual(['art-b', 'art-c', 'art-a']);
  });

  it('drops out-of-window rows, keeps in-window unscored', () => {
    const stale = sugg({ _id: 'old', status: ArticleSuggestionStatus.Unscored, firstPubDate: new Date(NOW - 30 * H).toISOString() });
    const fresh = sugg({ _id: 'ok', status: ArticleSuggestionStatus.Unscored, firstPubDate: new Date(NOW - H).toISOString() });
    const list = buildProvisionalFeedList([stale, fresh], new Set(), NOW);
    expect(list.map((c) => c.suggestion._id)).toEqual(['ok']);
  });

  it('drops discarded (complete && relevance ≤ gate) but keeps a sub-gate UNSCORED / reason_pending row', () => {
    const discarded = sugg({ _id: 'disc', status: ArticleSuggestionStatus.Complete, relevance: 0.3 });
    const unscoredLow = sugg({ _id: 'ulow', status: ArticleSuggestionStatus.Unscored, relevance: 0.1 });
    const pending = sugg({ _id: 'pend', status: ArticleSuggestionStatus.ReasonPending, relevance: 0.1 });
    const list = buildProvisionalFeedList([discarded, unscoredLow, pending], new Set(), NOW);
    expect(list.map((c) => c.suggestion._id).sort()).toEqual(['pend', 'ulow']);
  });

  it('excludes opened ∪ viewed ids (by article id and stable cluster id)', () => {
    const a = sugg({ _id: 'a', articleId: 'art-a', status: ArticleSuggestionStatus.Unscored });
    const b = sugg({ _id: 'b', articleId: 'art-b', status: ArticleSuggestionStatus.Unscored, clusters: [cluster('story-x')] });
    const c = sugg({ _id: 'c', articleId: 'art-c', status: ArticleSuggestionStatus.Unscored });
    const list = buildProvisionalFeedList([a, b, c], new Set(['art-a', 'story-x']), NOW);
    expect(list.map((x) => x.suggestion._id)).toEqual(['c']);
  });

  it('collapses a shared-stable-cluster story to one item with memberCount (dedup)', () => {
    const a = sugg({ _id: 'a', status: ArticleSuggestionStatus.Unscored, clusters: [cluster('s1')], firstPubDate: new Date(NOW - 2 * H).toISOString() });
    const b = sugg({ _id: 'b', status: ArticleSuggestionStatus.Unscored, clusters: [cluster('s1')], firstPubDate: new Date(NOW - H).toISOString() });
    const list = buildProvisionalFeedList([a, b], new Set(), NOW);
    expect(list).toHaveLength(1);
    expect(list[0].memberCount).toBe(2);
    expect(list[0].suggestion._id).toBe('b'); // newest fronts
  });

  it('caps the list at the requested cap, keeping the newest', () => {
    const rows: ForYouSuggestion[] = [];
    for (let i = 0; i < 5; i++) {
      rows.push(
        sugg({
          _id: `r${i}`,
          status: ArticleSuggestionStatus.Unscored,
          firstPubDate: new Date(NOW - (i + 1) * H).toISOString(),
        }),
      );
    }
    const list = buildProvisionalFeedList(rows, new Set(), NOW, 2);
    expect(list).toHaveLength(2);
    // r0 = NOW-1H (newest), r1 = NOW-2H.
    expect(list.map((c) => c.suggestion._id)).toEqual(['r0', 'r1']);
  });

  it('defaults the cap to PROVISIONAL_FEED_CAP (30)', () => {
    expect(PROVISIONAL_FEED_CAP).toBe(30);
  });

  it('returns [] for an empty / all-discarded pool', () => {
    expect(buildProvisionalFeedList([], new Set(), NOW)).toEqual([]);
    const disc = sugg({ status: ArticleSuggestionStatus.Complete, relevance: 0.2 });
    expect(buildProvisionalFeedList([disc], new Set(), NOW)).toEqual([]);
  });
});
