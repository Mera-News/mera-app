// feed-entries — pure partition tests. No RN/DB: exercises the unread/viewed
// split and the injected "All Caught Up" divider.

import {
  partitionFeedEntries,
  isCaughtUpEntry,
  CAUGHT_UP_ENTRY_ID,
  type FeedEntry,
} from '../feed-entries';
import type { FeedListItem } from '@/lib/stores/feed-list-selector';
import type { ForYouSuggestion } from '@/lib/stores/for-you-store';

/** Build a FeedListItem whose suggestion carries `articleId` (= id) and an
 *  optional stable cluster id — the two keys `isSuggestionOpened` matches on. */
function item(id: string, cluster?: string): FeedListItem {
  const clusters = cluster ? [{ stableClusterId: cluster }] : [];
  return {
    id,
    suggestion: { _id: id, articleId: id, clusters } as unknown as ForYouSuggestion,
    memberCount: 1,
    breaking: false,
    score: 0.5,
  };
}

/** Ids of the entries, with the divider rendered as the sentinel id. */
const ids = (entries: FeedEntry[]) => entries.map((e) => e.id);

describe('partitionFeedEntries', () => {
  it('returns an empty array for an empty feed (no lone divider)', () => {
    expect(partitionFeedEntries([], new Set())).toEqual([]);
  });

  it('puts the divider last when nothing is viewed', () => {
    const out = partitionFeedEntries([item('a'), item('b'), item('c')], new Set());
    expect(ids(out)).toEqual(['a', 'b', 'c', CAUGHT_UP_ENTRY_ID]);
    expect(isCaughtUpEntry(out[3])).toBe(true);
  });

  it('puts the divider first when everything is viewed', () => {
    const out = partitionFeedEntries([item('a'), item('b')], new Set(['a', 'b']));
    expect(ids(out)).toEqual([CAUGHT_UP_ENTRY_ID, 'a', 'b']);
  });

  it('splits unread above / viewed below, each keeping the incoming priority order', () => {
    // Feed order a,b,c,d,e (priority). b + d are viewed.
    const data = [item('a'), item('b'), item('c'), item('d'), item('e')];
    const out = partitionFeedEntries(data, new Set(['b', 'd']));
    expect(ids(out)).toEqual(['a', 'c', 'e', CAUGHT_UP_ENTRY_ID, 'b', 'd']);
  });

  it('treats a story opened by its stable cluster id as viewed', () => {
    const data = [item('a', 'clu-1'), item('b')];
    const out = partitionFeedEntries(data, new Set(['clu-1']));
    expect(ids(out)).toEqual(['b', CAUGHT_UP_ENTRY_ID, 'a']);
  });

  it('marks exactly one divider entry', () => {
    const out = partitionFeedEntries([item('a'), item('b')], new Set(['a']));
    expect(out.filter(isCaughtUpEntry)).toHaveLength(1);
  });
});
