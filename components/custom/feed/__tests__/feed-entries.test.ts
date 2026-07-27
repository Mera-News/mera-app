// feed-entries — pure partition tests. No RN/DB: exercises the unseen/seen
// split and the injected "All Caught Up" divider.
//
// "Seen" here is card LIFECYCLE STATE (`skipped`/`viewed`) or an exact-article
// open, NEVER the cluster axis — see the REGRESSION test below.

import {
  partitionFeedEntries,
  isSeenEntry,
  isCaughtUpEntry,
  CAUGHT_UP_ENTRY_ID,
  type FeedEntry,
} from '../feed-entries';
import type { CardStateRecord } from '@/lib/stores/feed-order-store';
import type { FeedListItem } from '@/lib/stores/feed-list-selector';
import type { ForYouSuggestion } from '@/lib/stores/for-you-store';

/** Build a FeedListItem whose suggestion carries `articleId` — the key
 *  `isSeenEntry` checks against `openedArticleIds` — and an optional stable
 *  cluster id, which must NEVER be consulted by the partition. */
function item(id: string, articleId?: string, clusterId?: string): FeedListItem {
  const aid = articleId ?? id;
  const clusters = clusterId ? [{ stableClusterId: clusterId }] : [];
  return {
    id,
    suggestion: { _id: id, articleId: aid, clusters } as unknown as ForYouSuggestion,
    memberCount: 1,
    memberIds: [aid],
    breaking: false,
    score: 0.5,
  };
}

/** Ids of the entries, with the divider rendered as the sentinel id. */
const ids = (entries: FeedEntry[]) => entries.map((e) => e.id);

const noStates: Record<string, CardStateRecord> = {};
const skipped = (at = 1): CardStateRecord => ({ state: 'skipped', at });
const viewed = (at = 1): CardStateRecord => ({ state: 'viewed', at });

describe('partitionFeedEntries', () => {
  it('returns an empty array for an empty feed (no lone divider)', () => {
    expect(partitionFeedEntries([], noStates, new Set())).toEqual([]);
  });

  it('all unseen: every item above the divider, divider last', () => {
    const data = [item('a'), item('b'), item('c')];
    const out = partitionFeedEntries(data, noStates, new Set());
    expect(ids(out)).toEqual(['a', 'b', 'c', CAUGHT_UP_ENTRY_ID]);
    expect(isCaughtUpEntry(out[3])).toBe(true);
  });

  it('all seen: divider first, every item below', () => {
    const data = [item('a'), item('b')];
    const cardStates = { a: viewed(), b: skipped() };
    const out = partitionFeedEntries(data, cardStates, new Set());
    expect(ids(out)).toEqual([CAUGHT_UP_ENTRY_ID, 'a', 'b']);
  });

  it('mixed: correct split, and each block preserves its incoming order', () => {
    // Feed priority order a,b,c,d,e. b + d carry lifecycle state ⇒ seen.
    const data = [item('a'), item('b'), item('c'), item('d'), item('e')];
    const cardStates = { b: viewed(), d: skipped() };
    const out = partitionFeedEntries(data, cardStates, new Set());
    expect(ids(out)).toEqual(['a', 'c', 'e', CAUGHT_UP_ENTRY_ID, 'b', 'd']);
  });

  it('a skipped card sinks below the divider', () => {
    const data = [item('a'), item('b')];
    const out = partitionFeedEntries(data, { a: skipped() }, new Set());
    expect(ids(out)).toEqual(['b', CAUGHT_UP_ENTRY_ID, 'a']);
  });

  it('a viewed card sinks below the divider', () => {
    const data = [item('a'), item('b')];
    const out = partitionFeedEntries(data, { a: viewed() }, new Set());
    expect(ids(out)).toEqual(['b', CAUGHT_UP_ENTRY_ID, 'a']);
  });

  it('an exact-article open sinks a card that has no card state', () => {
    const data = [item('a', 'art-1'), item('b', 'art-2')];
    const out = partitionFeedEntries(data, noStates, new Set(['art-1']));
    expect(ids(out)).toEqual(['b', CAUGHT_UP_ENTRY_ID, 'a']);
  });

  it('REGRESSION: an unviewed card whose stableClusterId matches an id in openedArticleIds stays ABOVE', () => {
    // Item 'a' fronts stable cluster "clu-1", and "clu-1" happens to be in
    // openedArticleIds (as if some OTHER article's id collided with this
    // story's cluster id) — but 'a's own articleId ("art-a") was never opened
    // and it carries no card state. The partition must key on articleId only,
    // never the cluster, or a brand-new article in an ongoing story would be
    // pre-sunk the instant any older member of that story was read.
    const data = [item('a', 'art-a', 'clu-1'), item('b', 'art-b')];
    const out = partitionFeedEntries(data, noStates, new Set(['clu-1']));
    expect(ids(out)).toEqual(['a', 'b', CAUGHT_UP_ENTRY_ID]);
  });

  it('isSeenEntry agrees with which block partitionFeedEntries put the item in', () => {
    const data = [item('a'), item('b', 'art-b'), item('c'), item('d', 'art-d', 'clu-d')];
    const cardStates = { a: viewed() };
    const openedArticleIds = new Set(['art-b']);
    const out = partitionFeedEntries(data, cardStates, openedArticleIds);
    const dividerIdx = out.findIndex(isCaughtUpEntry);
    expect(dividerIdx).toBeGreaterThanOrEqual(0);

    for (const raw of data) {
      const seen = isSeenEntry(raw, cardStates, openedArticleIds);
      const idxInOut = out.findIndex((e) => e.id === raw.id);
      if (seen) expect(idxInOut).toBeGreaterThan(dividerIdx);
      else expect(idxInOut).toBeLessThan(dividerIdx);
    }
  });
});

describe('isCaughtUpEntry', () => {
  it('is true only for the divider entry', () => {
    const out = partitionFeedEntries([item('a'), item('b')], { a: viewed() }, new Set());
    // out = [b, DIVIDER, a]
    expect(isCaughtUpEntry(out[0])).toBe(false);
    expect(isCaughtUpEntry(out[1])).toBe(true);
    expect(isCaughtUpEntry(out[2])).toBe(false);
  });
});
