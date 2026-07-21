// swipe-stack-selector — pure selector tests (Round-4 P2). RN-free.
//
// Covers the visibility gate, story-group collapse (memberCount), opened-rep
// exclusion, breaking detection, and the deck ordering (breaking → rawScore
// desc → pubDate desc → id asc).

import {
  buildSwipeStack,
  deckCompare,
  type SwipeDeckCandidate,
} from '../swipe-stack-selector';
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

describe('buildSwipeStack — visibility gate', () => {
  it('drops unscored, reason_pending, sub-gate and out-of-window rows', () => {
    const unscored = sugg({ _id: 'u', status: ArticleSuggestionStatus.Unscored });
    const pending = sugg({ _id: 'p', status: ArticleSuggestionStatus.ReasonPending });
    const subGate = sugg({ _id: 'g', relevance: 0.3 }); // must be > 0.3
    const stale = sugg({ _id: 'old', firstPubDate: new Date(NOW - 30 * H).toISOString() });
    const good = sugg({ _id: 'ok', relevance: 0.6 });

    const deck = buildSwipeStack([unscored, pending, subGate, stale, good], new Set(), NOW);
    expect(deck.map((c) => c.suggestion._id)).toEqual(['ok']);
  });

  it('returns [] for an empty / all-hidden pool', () => {
    expect(buildSwipeStack([], new Set(), NOW)).toEqual([]);
    const hidden = sugg({ status: ArticleSuggestionStatus.Unscored });
    expect(buildSwipeStack([hidden], new Set(), NOW)).toEqual([]);
  });
});

describe('buildSwipeStack — grouping + opened exclusion', () => {
  it('collapses a shared-stable-cluster story to one candidate with memberCount', () => {
    const a = sugg({ _id: 'a', clusters: [cluster('story-1')], firstPubDate: new Date(NOW - 2 * H).toISOString() });
    const b = sugg({ _id: 'b', clusters: [cluster('story-1')], firstPubDate: new Date(NOW - H).toISOString() });
    const deck = buildSwipeStack([a, b], new Set(), NOW);
    expect(deck).toHaveLength(1);
    expect(deck[0].memberCount).toBe(2);
    // newest member (b) fronts the story.
    expect(deck[0].suggestion._id).toBe('b');
    expect(deck[0].id).toBe('art-b');
  });

  it('excludes a group whose representative is already opened (by article id)', () => {
    const a = sugg({ _id: 'a' });
    const b = sugg({ _id: 'b' });
    const deck = buildSwipeStack([a, b], new Set(['art-a']), NOW);
    expect(deck.map((c) => c.suggestion._id)).toEqual(['b']);
  });

  it('excludes a group whose representative is opened (by stable cluster id)', () => {
    const a = sugg({ _id: 'a', clusters: [cluster('story-x')] });
    const deck = buildSwipeStack([a], new Set(['story-x']), NOW);
    expect(deck).toHaveLength(0);
  });
});

describe('buildSwipeStack — deck ordering', () => {
  it('pins breaking first, then rawScore desc, then pubDate desc, then id asc', () => {
    const breaking = sugg({ _id: 'brk', rawScore: 0.85, eventType: 'disaster', relevance: 0.9 });
    const hiRaw = sugg({ _id: 'hi', rawScore: 0.95 });
    const midRaw = sugg({ _id: 'mid', rawScore: 0.6, firstPubDate: new Date(NOW - 5 * H).toISOString() });
    const midNewer = sugg({ _id: 'midNew', rawScore: 0.6, firstPubDate: new Date(NOW - H).toISOString() });

    const deck = buildSwipeStack([midRaw, hiRaw, breaking, midNewer], new Set(), NOW);
    expect(deck.map((c) => c.suggestion._id)).toEqual(['brk', 'hi', 'midNew', 'mid']);
    expect(deck[0].breaking).toBe(true);
  });
});

describe('deckCompare', () => {
  function cand(over: Partial<SwipeDeckCandidate> & { id: string }): SwipeDeckCandidate {
    return {
      id: over.id,
      memberCount: over.memberCount ?? 1,
      breaking: over.breaking ?? false,
      suggestion: over.suggestion ?? sugg({ _id: over.id, articleId: over.id }),
    };
  }

  it('breaks ties on id ascending', () => {
    const a = cand({ id: 'art-z', suggestion: sugg({ _id: 'z', articleId: 'art-z', rawScore: 0.5, firstPubDate: new Date(NOW).toISOString() }) });
    const b = cand({ id: 'art-a', suggestion: sugg({ _id: 'a', articleId: 'art-a', rawScore: 0.5, firstPubDate: new Date(NOW).toISOString() }) });
    expect([a, b].sort(deckCompare).map((c) => c.id)).toEqual(['art-a', 'art-z']);
  });
});
