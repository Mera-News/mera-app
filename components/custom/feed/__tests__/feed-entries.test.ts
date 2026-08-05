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
  extendPinnedIds,
  INITIAL_VISIBLE_FLOOR,
  seenTierOfEntry,
  buildFeedRows,
  DIVIDER_CAUGHT_UP,
  DIVIDER_OPENED,
  stalenessBandPenalty,
  effectiveBand,
  STALE_ONE_BAND_HOURS,
  STALE_TWO_BAND_HOURS,
  type SortedFeed,
} from '../feed-entries';
import { FEED_HALF_LIFE_HOURS } from '@/lib/stores/feed-list-selector';
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

/** Accepts either a raw row array or a `SortedFeed`, so the pre-pin assertions
 *  below read exactly as they did before `sortFeedEntries` grew `pinnedCount`. */
const ids = (entries: FeedListItem[] | SortedFeed) =>
  (Array.isArray(entries) ? entries : entries.rows).map((e) => e.id);
/** The rows of a `SortedFeed` — for assertions that need the array itself. */
const rows = (out: SortedFeed) => out.rows;

const noStates: Record<string, CardStateRecord> = {};
const skipped = (at = 1): CardStateRecord => ({ state: 'skipped', at });
const viewed = (at = 1): CardStateRecord => ({ state: 'viewed', at });

describe('relevanceBandRank', () => {
  // relevance v3 (2026-08-05) band-ladder unification: cutoffs moved off the
  // old private 0.53/0.77 pair onto the unified `bandOf` cutoffs (0.4 RENDER_GATE
  // / 0.6 / 0.8) — see lib/feed-ordering/priority-order.ts.
  it('mirrors the getRelevanceColors thresholds', () => {
    expect(relevanceBandRank(1.2)).toBe(0); // emergency
    expect(relevanceBandRank(0.9)).toBe(1); // high
    expect(relevanceBandRank(0.8)).toBe(1); // high (inclusive edge)
    expect(relevanceBandRank(0.7)).toBe(2); // medium
    expect(relevanceBandRank(0.6)).toBe(2); // medium (inclusive edge)
    expect(relevanceBandRank(0.4)).toBe(3); // low (RENDER_GATE, inclusive edge)
    expect(relevanceBandRank(0.5)).toBe(3); // low
    expect(relevanceBandRank(0.39)).toBe(4); // irrelevant (just below the gate)
    expect(relevanceBandRank(0)).toBe(4);
  });
});

describe('sortFeedEntries', () => {
  it('returns an empty result for an empty feed', () => {
    expect(sortFeedEntries([], noStates, new Set())).toEqual({ rows: [], pinnedCount: 0 });
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
    expect(rows(out)).toHaveLength(4);
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
    const out = rows(sortFeedEntries(data, cardStates, openedArticleIds));
    const boundary = countUnviewed(out, cardStates, openedArticleIds);

    for (const raw of data) {
      const isViewed = isViewedEntry(raw, cardStates, openedArticleIds);
      const idxInOut = out.findIndex((e) => e.id === raw.id);
      if (isViewed) expect(idxInOut).toBeGreaterThanOrEqual(boundary);
      else expect(idxInOut).toBeLessThan(boundary);
    }
  });
});

describe('extendPinnedIds', () => {
  const sorted = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((id) => item(id));

  it('pins 4 rows before the user has scrolled (deepestSeenId null)', () => {
    expect(extendPinnedIds([], sorted, null)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('pins deepest-seen + 1 slack card: 3 rows visible ⇒ 4 pinned ⇒ 5th is dynamic', () => {
    // Rows 0,1,2 visible, row 2 deepest ⇒ indices 0..3 pinned.
    expect(extendPinnedIds([], sorted, 'c')).toEqual(['a', 'b', 'c', 'd']);
    expect(extendPinnedIds([], sorted, 'c')).toHaveLength(INITIAL_VISIBLE_FLOOR + 2);
  });

  it('grows as the user scrolls deeper', () => {
    expect(extendPinnedIds([], sorted, 'e')).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
  });

  it('is MONOTONIC and returns prev by IDENTITY when nothing new is covered', () => {
    const prev = extendPinnedIds([], sorted, 'e'); // 6 long
    // Scrolling back up to row 1 must not shrink the pin...
    const next = extendPinnedIds(prev, sorted, 'b');
    expect(next).toBe(prev); // identity — no re-render
  });

  it('falls back to the floor (never collapses) when the anchor row is gone', () => {
    // The anchor was dropped by hydrate/removeIds and is not in `sorted`.
    expect(extendPinnedIds([], sorted, 'vanished')).toEqual(['a', 'b', 'c', 'd']);
  });

  it('a dropped anchor cannot shrink an existing pin', () => {
    const prev = extendPinnedIds([], sorted, 'f'); // 7 long
    expect(extendPinnedIds(prev, sorted, 'vanished')).toBe(prev);
  });

  it('clamps to the list length when the list is shorter than one screen', () => {
    const short = [item('a'), item('b')];
    expect(extendPinnedIds([], short, null)).toEqual(['a', 'b']);
  });

  it('returns prev by identity for an empty list', () => {
    const prev: string[] = [];
    expect(extendPinnedIds(prev, [], null)).toBe(prev);
  });
});

describe('sortFeedEntries — pinned prefix (the static/dynamic boundary)', () => {
  it('with no pin, output is byte-identical to the pre-pin ordering', () => {
    const data = [item('low', 0.4), item('high', 0.9), item('med', 0.6)];
    const withoutPin = sortFeedEntries(data, noStates, new Set());
    const explicitEmpty = sortFeedEntries(data, noStates, new Set(), []);
    expect(ids(withoutPin)).toEqual(ids(explicitEmpty));
    expect(withoutPin.pinnedCount).toBe(0);
  });

  it('pinned rows keep pinnedIds ORDER even when their tier changed under them', () => {
    // 'p1' is now viewed and 'p2' is low-relevance — both would sink if they
    // were re-sorted. Pinned means pinned: the user read them in this order.
    const data = [item('p1', 0.9), item('p2', 0.35), item('x', 0.85)];
    const out = sortFeedEntries(data, { p1: viewed() }, new Set(), ['p1', 'p2']);
    expect(ids(out)).toEqual(['p1', 'p2', 'x']);
    expect(out.pinnedCount).toBe(2);
  });

  it('the unpinned remainder is still tier- and band-sorted', () => {
    const data = [
      item('p1', 0.4),
      item('u-low', 0.4),
      item('u-high', 0.9),
      item('v-high', 0.9),
    ];
    const out = sortFeedEntries(data, { 'v-high': viewed() }, new Set(), ['p1']);
    expect(ids(out)).toEqual(['p1', 'u-high', 'u-low', 'v-high']);
  });

  it('skips a pinned id missing from data WITHOUT shifting the rest, and pinnedCount counts survivors', () => {
    // 'gone' was dropped by hydrate/removeIds between renders.
    const data = [item('p1', 0.6), item('p2', 0.6), item('x', 0.9)];
    const out = sortFeedEntries(data, noStates, new Set(), ['p1', 'gone', 'p2']);
    expect(ids(out)).toEqual(['p1', 'p2', 'x']);
    // NOT 3 — dividers get placed at this boundary, and using pinnedIds.length
    // would push them past it and into the pinned prefix.
    expect(out.pinnedCount).toBe(2);
  });

  // THE regression assertion for this whole wave: complaints #1 and #3 both
  // reduce to "a new arrival must never render above the boundary".
  it('REGRESSION: a brand-new high-relevance arrival renders at index >= pinnedCount', () => {
    const pinned = ['p1', 'p2', 'p3', 'p4'];
    const data = [
      // The store PREPENDS, so the fresh item leads the incoming array...
      item('fresh', 1.1),
      ...pinned.map((id) => item(id, 0.4)),
    ];
    const out = sortFeedEntries(data, noStates, new Set(), pinned);
    const idx = rows(out).findIndex((e) => e.id === 'fresh');
    expect(idx).toBeGreaterThanOrEqual(out.pinnedCount);
    expect(ids(out)).toEqual(['p1', 'p2', 'p3', 'p4', 'fresh']);
  });

  it('a fresh arrival still leads the DYNAMIC region (top of its band)', () => {
    const data = [item('fresh', 0.9), item('p1', 0.9), item('older', 0.9)];
    const out = sortFeedEntries(data, noStates, new Set(), ['p1']);
    expect(ids(out)).toEqual(['p1', 'fresh', 'older']);
  });

  it('does not mutate the input array', () => {
    const data = [item('a', 0.4), item('b', 0.9)];
    const snapshot = ids(data);
    sortFeedEntries(data, noStates, new Set(), ['b']);
    expect(ids(data)).toEqual(snapshot);
  });

  it('pinning everything leaves an empty dynamic region and drops nothing', () => {
    const data = [item('a', 0.4), item('b', 0.9)];
    const out = sortFeedEntries(data, noStates, new Set(), ['a', 'b']);
    expect(ids(out)).toEqual(['a', 'b']);
    expect(out.pinnedCount).toBe(2);
  });
});

describe('seenTierOfEntry', () => {
  it('0 unseen, 1 card-state only, 2 opened', () => {
    const a = item('a', 0.6, 'art-a');
    expect(seenTierOfEntry(a, noStates, new Set())).toBe(0);
    expect(seenTierOfEntry(a, { a: skipped() }, new Set())).toBe(1);
    expect(seenTierOfEntry(a, noStates, new Set(['art-a']))).toBe(2);
  });

  it('an OPEN outranks a card state (tapping stamps both)', () => {
    const a = item('a', 0.6, 'art-a');
    expect(seenTierOfEntry(a, { a: viewed() }, new Set(['art-a']))).toBe(2);
  });

  it("a 'viewed' card state from a save/thumb/ask is tier 1, NOT tier 2", () => {
    // Those paths stamp cardStates but deliberately record no open, so the card
    // is acknowledged-but-unread.
    const a = item('a', 0.6, 'art-a');
    expect(seenTierOfEntry(a, { a: viewed() }, new Set())).toBe(1);
  });

  it('agrees with isViewedEntry (tier > 0)', () => {
    const a = item('a', 0.6, 'art-a');
    for (const [states, opened] of [
      [noStates, new Set<string>()],
      [{ a: skipped() }, new Set<string>()],
      [noStates, new Set(['art-a'])],
    ] as const) {
      expect(seenTierOfEntry(a, states, opened) > 0).toBe(
        isViewedEntry(a, states, opened),
      );
    }
  });
});

describe('buildFeedRows — the two dividers', () => {
  const tierOf =
    (states: Record<string, CardStateRecord>, opened: Set<string>) => (it: FeedListItem) =>
      seenTierOfEntry(it, states, opened);

  const kinds = (rows: ReturnType<typeof buildFeedRows>['rows']) =>
    rows.map((r) => (r.kind === 'divider' ? r.id : r.id));

  it('splices both dividers at the tier boundaries', () => {
    const data = [item('u', 0.9), item('s', 0.9, 'art-s'), item('o', 0.9, 'art-o')];
    const out = buildFeedRows(data, 0, tierOf({ s: skipped() }, new Set(['art-o'])));
    expect(kinds(out.rows)).toEqual(['u', DIVIDER_CAUGHT_UP, 's', DIVIDER_OPENED, 'o']);
    expect(out.caughtUpIsFooter).toBe(false);
  });

  it('caughtUpIsFooter when nothing below the boundary has been seen', () => {
    const data = [item('u1', 0.9), item('u2', 0.6)];
    const out = buildFeedRows(data, 0, tierOf(noStates, new Set()));
    expect(kinds(out.rows)).toEqual(['u1', 'u2']);
    expect(out.caughtUpIsFooter).toBe(true);
  });

  it('omits divider #2 when nothing was opened', () => {
    const data = [item('u', 0.9), item('s', 0.9, 'art-s')];
    const out = buildFeedRows(data, 0, tierOf({ s: skipped() }, new Set()));
    expect(kinds(out.rows)).toEqual(['u', DIVIDER_CAUGHT_UP, 's']);
  });

  it('emits both dividers in order even when the dynamic region is ALL opened', () => {
    const data = [item('o', 0.9, 'art-o')];
    const out = buildFeedRows(data, 0, tierOf(noStates, new Set(['art-o'])));
    expect(kinds(out.rows)).toEqual([DIVIDER_CAUGHT_UP, DIVIDER_OPENED, 'o']);
  });

  it('NEVER puts a divider inside the pinned prefix, whatever tiers it holds', () => {
    // The prefix is the user's reading order and deliberately mixes tiers.
    const data = [item('p1', 0.9, 'art-p1'), item('p2', 0.9), item('u', 0.9)];
    const out = buildFeedRows(data, 2, tierOf(noStates, new Set(['art-p1'])));
    expect(kinds(out.rows).slice(0, 2)).toEqual(['p1', 'p2']);
    expect(out.rows.slice(0, 2).every((r) => r.kind === 'story')).toBe(true);
  });

  // The scrolled-to-the-bottom case: everything pinned ⇒ empty dynamic region ⇒
  // the caught-up marker is the footer ⇒ the NEXT arrival appears ABOVE it.
  it('a new arrival lands above the caught-up divider once everything is pinned', () => {
    const pinned = [item('p1', 0.9, 'art-p1'), item('p2', 0.9, 'art-p2')];
    const allPinned = buildFeedRows(
      pinned,
      2,
      tierOf(noStates, new Set(['art-p1', 'art-p2'])),
    );
    expect(allPinned.caughtUpIsFooter).toBe(true);

    // ...now one fresh story arrives into the dynamic region.
    const withFresh = buildFeedRows(
      [...pinned, item('fresh', 0.9)],
      2,
      tierOf(noStates, new Set(['art-p1', 'art-p2'])),
    );
    expect(kinds(withFresh.rows)).toEqual(['p1', 'p2', 'fresh']);
    expect(withFresh.caughtUpIsFooter).toBe(true);
  });

  it('clamps a pinnedCount past the end and never drops a story', () => {
    const data = [item('a', 0.9), item('b', 0.6)];
    const out = buildFeedRows(data, 99, tierOf(noStates, new Set()));
    expect(kinds(out.rows)).toEqual(['a', 'b']);
  });

  it('divider ids never collide with story ids (keyExtractor stays unique)', () => {
    const data = [item('u', 0.9), item('s', 0.9, 'art-s'), item('o', 0.9, 'art-o')];
    const out = buildFeedRows(data, 0, tierOf({ s: skipped() }, new Set(['art-o'])));
    const ks = out.rows.map((r) => r.id);
    expect(new Set(ks).size).toBe(ks.length);
  });

  it('returns an empty result for an empty feed', () => {
    const out = buildFeedRows([], 0, tierOf(noStates, new Set()));
    expect(out.rows).toEqual([]);
    expect(out.caughtUpIsFooter).toBe(true);
  });
});

describe('staleness demotion (tier 0 only)', () => {
  const NOW = Date.parse('2026-08-04T12:00:00.000Z');
  const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString();

  /** A FeedListItem with a real `firstPubDate` — the field the card's age label
   *  is rendered from, and what the demotion keys on. */
  function aged(id: string, relevance: number, ageH: number, articleId?: string) {
    const it = item(id, relevance, articleId);
    (it.suggestion as unknown as { firstPubDate: string }).firstPubDate = hoursAgo(ageH);
    return it;
  }

  it('buckets are derived from FEED_HALF_LIFE_HOURS, not hand-picked', () => {
    expect(STALE_ONE_BAND_HOURS).toBe(FEED_HALF_LIFE_HOURS * 2); // 12h
    expect(STALE_TWO_BAND_HOURS).toBe(FEED_HALF_LIFE_HOURS * 4); // 24h
  });

  it('penalty steps at the two boundaries', () => {
    expect(stalenessBandPenalty(0)).toBe(0);
    expect(stalenessBandPenalty(STALE_ONE_BAND_HOURS - 0.1)).toBe(0);
    expect(stalenessBandPenalty(STALE_ONE_BAND_HOURS)).toBe(1);
    expect(stalenessBandPenalty(STALE_TWO_BAND_HOURS - 0.1)).toBe(1);
    expect(stalenessBandPenalty(STALE_TWO_BAND_HOURS)).toBe(2);
    // Unknown age ⇒ NO penalty: a data defect must not bury a story.
    expect(stalenessBandPenalty(Number.POSITIVE_INFINITY)).toBe(0);
    expect(stalenessBandPenalty(Number.NaN)).toBe(0);
  });

  it('demotes an unseen story by one band at 12h and two at 24h', () => {
    expect(effectiveBand(aged('a', 0.9, 1), 0, NOW)).toBe(1); // high, fresh
    expect(effectiveBand(aged('a', 0.9, 13), 0, NOW)).toBe(2); // → medium
    expect(effectiveBand(aged('a', 0.9, 30), 0, NOW)).toBe(3); // → low
  });

  it('EMERGENCY floors at band 1 — a big development still surfaces', () => {
    expect(effectiveBand(aged('e', 1.2, 1), 0, NOW)).toBe(0);
    expect(effectiveBand(aged('e', 1.2, 13), 0, NOW)).toBe(1);
    expect(effectiveBand(aged('e', 1.2, 47), 0, NOW)).toBe(1); // never worse
  });

  it('clamps at the existing bottom band — no new band value is invented', () => {
    expect(effectiveBand(aged('l', 0.35, 30), 0, NOW)).toBe(4);
  });

  it('does NOT touch tiers 1 and 2 — history keeps the order it was read in', () => {
    const old = aged('o', 0.9, 40);
    expect(effectiveBand(old, 1, NOW)).toBe(1);
    expect(effectiveBand(old, 2, NOW)).toBe(1);
  });

  it('does NOT demote a row whose date is missing or unparseable', () => {
    // Opposite of feedScore's rule, on purpose: there an unknown date must not
    // win on freshness; here it must not incur a penalty. Degrade toward showing.
    const noDate = item('x', 0.9);
    expect(effectiveBand(noDate, 0, NOW)).toBe(1); // unchanged high

    const bad = item('y', 0.9);
    (bad.suggestion as unknown as { firstPubDate: string }).firstPubDate = 'not-a-date';
    expect(effectiveBand(bad, 0, NOW)).toBe(1);
  });

  it('falls back to createdAt when firstPubDate is absent (matches the card label)', () => {
    const it = item('z', 0.9);
    (it.suggestion as unknown as { createdAt: string }).createdAt = hoursAgo(30);
    expect(effectiveBand(it, 0, NOW)).toBe(3);
  });

  // The user-visible complaint, end to end.
  it("REGRESSION: today's medium story outranks yesterday's high one", () => {
    const data = [aged('yesterday-high', 0.9, 30), aged('today-med', 0.6, 2)];
    expect(ids(sortFeedEntries(data, noStates, new Set(), [], NOW))).toEqual([
      'today-med',
      'yesterday-high',
    ]);
  });

  it('a fresh HIGH still beats a fresh MEDIUM — relevance still leads', () => {
    const data = [aged('med', 0.6, 1), aged('high', 0.9, 1)];
    expect(ids(sortFeedEntries(data, noStates, new Set(), [], NOW))).toEqual(['high', 'med']);
  });

  it('an aged EMERGENCY still outranks a fresh medium', () => {
    const data = [aged('med-fresh', 0.6, 1), aged('emergency-old', 1.2, 40)];
    expect(ids(sortFeedEntries(data, noStates, new Set(), [], NOW))).toEqual([
      'emergency-old',
      'med-fresh',
    ]);
  });

  it('never reorders across tiers — a stale unseen card still beats a seen one', () => {
    const data = [aged('seen-high', 0.9, 1, 'art-seen'), aged('unseen-stale', 0.9, 40)];
    const out = ids(sortFeedEntries(data, { 'seen-high': viewed() }, new Set(), [], NOW));
    expect(out).toEqual(['unseen-stale', 'seen-high']);
  });

  it('the pinned prefix is immune — pinned rows never re-rank by age', () => {
    const data = [aged('p-stale', 0.9, 40), aged('fresh', 0.9, 1)];
    const out = sortFeedEntries(data, noStates, new Set(), ['p-stale'], NOW);
    expect(ids(out)).toEqual(['p-stale', 'fresh']);
  });

  it('countUnviewed is unaffected — staleness changes the band, never the tier', () => {
    const data = [aged('a', 0.9, 40), aged('b', 0.6, 1)];
    expect(countUnviewed(data, noStates, new Set())).toBe(2);
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
