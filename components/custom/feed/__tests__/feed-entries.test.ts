// feed-entries — pure display-order tests. No RN/DB: exercises the
// unviewed/viewed split, the relevance banding, and the tie-break that keeps the
// store's insert-only order meaningful.
//
// "Viewed" here is card LIFECYCLE STATE (`skipped`/`viewed`) or an exact-article
// open, NEVER the cluster axis — see the REGRESSION test below.

import {
  sortFeedEntries,
  isViewedEntry,
  relevanceBandRank,
  countUnviewed,
} from '../feed-entries';
import type { CardStateRecord } from '@/lib/stores/feed-order-store';
import type { FeedListItem } from '@/lib/stores/feed-list-selector';
import type { ForYouSuggestion } from '@/lib/stores/for-you-store';

/** Build a FeedListItem whose suggestion carries `articleId` — the key
 *  `isViewedEntry` checks against `openedArticleIds` — plus a `relevance` (the
 *  banding input) and an optional stable cluster id, which must NEVER be
 *  consulted by the sort. */
function item(
  id: string,
  relevance = 0.6,
  articleId?: string,
  clusterId?: string,
): FeedListItem {
  const aid = articleId ?? id;
  const clusters = clusterId ? [{ stableClusterId: clusterId }] : [];
  return {
    id,
    suggestion: {
      _id: id,
      articleId: aid,
      relevance,
      clusters,
    } as unknown as ForYouSuggestion,
    memberCount: 1,
    memberIds: [aid],
    breaking: false,
    // Deliberately ANTI-correlated with `relevance`: the sort must band off
    // `suggestion.relevance` (what the worded chip shows), never this composite
    // score, which folds in a recency decay the chip knows nothing about.
    score: 1 - relevance,
  };
}

const ids = (entries: FeedListItem[]) => entries.map((e) => e.id);

const noStates: Record<string, CardStateRecord> = {};
const skipped = (at = 1): CardStateRecord => ({ state: 'skipped', at });
const viewed = (at = 1): CardStateRecord => ({ state: 'viewed', at });

describe('relevanceBandRank', () => {
  it('mirrors the getRelevanceColors thresholds', () => {
    expect(relevanceBandRank(1.2)).toBe(0); // emergency
    expect(relevanceBandRank(0.9)).toBe(1); // high
    expect(relevanceBandRank(0.77)).toBe(1); // high (inclusive edge)
    expect(relevanceBandRank(0.6)).toBe(2); // medium
    expect(relevanceBandRank(0.53)).toBe(2); // medium (inclusive edge)
    expect(relevanceBandRank(0.4)).toBe(3); // low
    expect(relevanceBandRank(0.31)).toBe(3); // low
    expect(relevanceBandRank(0.3)).toBe(4); // irrelevant (exclusive edge)
    expect(relevanceBandRank(0)).toBe(4);
  });
});

describe('sortFeedEntries', () => {
  it('returns an empty array for an empty feed', () => {
    expect(sortFeedEntries([], noStates, new Set())).toEqual([]);
  });

  it('orders unviewed by relevance band, high to low', () => {
    const data = [item('low', 0.4), item('high', 0.9), item('med', 0.6)];
    expect(ids(sortFeedEntries(data, noStates, new Set()))).toEqual([
      'high',
      'med',
      'low',
    ]);
  });

  it('puts every unviewed card above every viewed card, whatever the relevance', () => {
    // The viewed card is HIGH relevance, the unviewed one is LOW — viewed still
    // sinks. Unviewed-first is the outer key.
    const data = [item('viewed-high', 0.9), item('unviewed-low', 0.4)];
    const out = sortFeedEntries(data, { 'viewed-high': viewed() }, new Set());
    expect(ids(out)).toEqual(['unviewed-low', 'viewed-high']);
  });

  it('banded within each block: unviewed high→low, then viewed high→low', () => {
    const data = [
      item('u-low', 0.4),
      item('v-high', 0.9),
      item('u-high', 0.85),
      item('v-low', 0.35),
      item('u-med', 0.6),
      item('v-med', 0.55),
    ];
    const cardStates = { 'v-high': viewed(), 'v-med': skipped(), 'v-low': viewed() };
    expect(ids(sortFeedEntries(data, cardStates, new Set()))).toEqual([
      'u-high',
      'u-med',
      'u-low',
      'v-high',
      'v-med',
      'v-low',
    ]);
  });

  it('keeps the incoming (insert-only) order within a band', () => {
    // All three sit in the same band: the store's prepend order must survive, so
    // a freshly-prepended arrival stays at the top of its band.
    const data = [item('newest', 0.6), item('middle', 0.6), item('oldest', 0.6)];
    expect(ids(sortFeedEntries(data, noStates, new Set()))).toEqual([
      'newest',
      'middle',
      'oldest',
    ]);
  });

  it('does not mutate the input array', () => {
    const data = [item('a', 0.4), item('b', 0.9)];
    const snapshot = ids(data);
    sortFeedEntries(data, noStates, new Set());
    expect(ids(data)).toEqual(snapshot);
  });

  it('a dwell-marked (skipped) card sinks', () => {
    const data = [item('a', 0.6), item('b', 0.6)];
    expect(ids(sortFeedEntries(data, { a: skipped() }, new Set()))).toEqual(['b', 'a']);
  });

  it('an interacted-with (viewed) card sinks', () => {
    const data = [item('a', 0.6), item('b', 0.6)];
    expect(ids(sortFeedEntries(data, { a: viewed() }, new Set()))).toEqual(['b', 'a']);
  });

  it('an exact-article open sinks a card that has no card state', () => {
    const data = [item('a', 0.6, 'art-1'), item('b', 0.6, 'art-2')];
    expect(ids(sortFeedEntries(data, noStates, new Set(['art-1'])))).toEqual(['b', 'a']);
  });

  it('NOTHING is dropped — every input id survives the sort', () => {
    const data = [item('a', 0.9), item('b', 0.4), item('c', 0.6), item('d', 0.2)];
    const out = sortFeedEntries(data, { a: viewed(), c: skipped() }, new Set(['b']));
    expect(out).toHaveLength(4);
    expect([...ids(out)].sort()).toEqual(['a', 'b', 'c', 'd']);
  });

  it('REGRESSION: an unviewed card whose stableClusterId matches an id in openedArticleIds stays ABOVE', () => {
    // Item 'a' fronts stable cluster "clu-1", and "clu-1" happens to be in
    // openedArticleIds (as if some OTHER article's id collided with this story's
    // cluster id) — but 'a's own articleId ("art-a") was never opened and it
    // carries no card state. The sort must key on articleId only, never the
    // cluster, or a brand-new article in an ongoing story would be pre-sunk the
    // instant any older member of that story was read.
    const data = [item('a', 0.6, 'art-a', 'clu-1'), item('b', 0.6, 'art-b')];
    const out = sortFeedEntries(data, noStates, new Set(['clu-1']));
    expect(ids(out)).toEqual(['a', 'b']);
  });

  it('isViewedEntry agrees with which block sortFeedEntries put the item in', () => {
    const data = [
      item('a', 0.6),
      item('b', 0.6, 'art-b'),
      item('c', 0.6),
      item('d', 0.6, 'art-d', 'clu-d'),
    ];
    const cardStates = { a: viewed() };
    const openedArticleIds = new Set(['art-b']);
    const out = sortFeedEntries(data, cardStates, openedArticleIds);
    const boundary = countUnviewed(out, cardStates, openedArticleIds);

    for (const raw of data) {
      const isViewed = isViewedEntry(raw, cardStates, openedArticleIds);
      const idxInOut = out.findIndex((e) => e.id === raw.id);
      if (isViewed) expect(idxInOut).toBeGreaterThanOrEqual(boundary);
      else expect(idxInOut).toBeLessThan(boundary);
    }
  });
});

describe('countUnviewed', () => {
  it('counts rows with neither a card state nor an exact-article open', () => {
    const data = [item('a', 0.6, 'art-a'), item('b', 0.6, 'art-b'), item('c', 0.6)];
    expect(countUnviewed(data, { c: skipped() }, new Set(['art-a']))).toBe(1);
    expect(countUnviewed(data, noStates, new Set())).toBe(3);
    expect(countUnviewed([], noStates, new Set())).toBe(0);
  });
});
