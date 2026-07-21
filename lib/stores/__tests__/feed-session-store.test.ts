// feed-session-store — session order-state tests. RN-free (imports only the pure
// feedCompare + FeedListItem type via feed-list-selector).
//
// Covers: rebuild (order reset + verdicts cleared), ingest (append-only — the
// existing order is byte-for-byte preserved, new ids appended feedCompare-sorted,
// nothing removed, known rows refreshed), onTabFocus resume-vs-rebuild rules
// (empty / idle>15min / fully-consumed → rebuild, else ingest), and the verdict
// mirror (setVerdict / setPath).

import {
  FEED_RESNAPSHOT_IDLE_MS,
  useFeedSessionStore,
} from '../feed-session-store';
import type { FeedListItem } from '../feed-list-selector';
import type { ForYouSuggestion } from '../for-you-store';

function item(
  id: string,
  over: { score?: number; pubMs?: number } = {},
): FeedListItem {
  const suggestion = {
    _id: id,
    articleId: id,
    firstPubDate: new Date(over.pubMs ?? 1_000).toISOString(),
  } as unknown as ForYouSuggestion;
  return {
    id,
    suggestion,
    memberCount: 1,
    breaking: false,
    score: over.score ?? 0.5,
  };
}

const store = () => useFeedSessionStore.getState();

beforeEach(() => {
  store().reset();
});

describe('rebuild', () => {
  it('lays out the order, indexes items, and stamps lastActiveAt', () => {
    store().rebuild([item('a'), item('b')]);
    const s = store();
    expect(s.order).toEqual(['a', 'b']);
    expect(Object.keys(s.itemsById).sort()).toEqual(['a', 'b']);
    expect(s.lastActiveAt).not.toBeNull();
  });

  it('clears any recorded verdicts', () => {
    store().rebuild([item('a')]);
    store().setVerdict('a', 'like');
    store().rebuild([item('b')]);
    expect(store().order).toEqual(['b']);
    expect(store().verdicts).toEqual({});
  });
});

describe('ingest — append-only', () => {
  it('preserves the existing order byte-for-byte and appends new ids feedCompare-sorted', () => {
    store().rebuild([item('a', { score: 1.0 }), item('b', { score: 0.9 })]);
    const before = store().order;
    // d (0.5) and c (0.8) are new — c must sort ahead of d among the appended.
    store().ingest([
      item('a', { score: 1.0 }),
      item('b', { score: 0.9 }),
      item('d', { score: 0.5 }),
      item('c', { score: 0.8 }),
    ]);
    expect(store().order).toEqual(['a', 'b', 'c', 'd']);
    // Existing prefix untouched.
    expect(store().order.slice(0, 2)).toEqual(before);
  });

  it('never removes an existing entry that is absent from the new items', () => {
    store().rebuild([item('a'), item('b')]);
    store().ingest([item('b')]); // a not present
    expect(store().order).toEqual(['a', 'b']);
  });

  it('refreshes the row data of a known id in place', () => {
    store().rebuild([item('a', { score: 1 })]);
    store().ingest([item('a', { score: 2 })]);
    expect(store().itemsById.a.score).toBe(2);
    expect(store().order).toEqual(['a']);
  });
});

describe('onTabFocus — resume vs rebuild', () => {
  it('rebuilds when the order is empty (relaunch)', () => {
    store().onTabFocus([item('a'), item('b')]);
    expect(store().order).toEqual(['a', 'b']);
  });

  it('rebuilds (clears verdicts) after > 15 min idle', () => {
    store().rebuild([item('a'), item('b')]);
    store().setVerdict('a', 'like');
    const t = store().lastActiveAt ?? 0;
    store().onTabFocus([item('a'), item('b')], t + FEED_RESNAPSHOT_IDLE_MS + 1);
    expect(store().verdicts).toEqual({});
  });

  it('resumes (ingest) when not idle — keeps verdicts and appends new ids', () => {
    store().rebuild([item('a'), item('b')]);
    store().setVerdict('a', 'like');
    const t = store().lastActiveAt ?? 0;
    store().onTabFocus([item('a'), item('b'), item('c')], t + 1_000);
    expect(store().order).toEqual(['a', 'b', 'c']);
    expect(store().verdicts.a).toEqual({ verdict: 'like', path: [] });
  });

  it('rebuilds when every laid-out row is verdicted or no longer live (consumed)', () => {
    store().rebuild([item('a')]);
    store().setVerdict('a', 'like'); // a consumed
    const t = store().lastActiveAt ?? 0;
    store().onTabFocus([item('b')], t + 1_000); // a gone from live pool, b fresh
    expect(store().order).toEqual(['b']);
    expect(store().verdicts).toEqual({});
  });
});

describe('verdict mirror', () => {
  it('sets and paths verdicts; flip keeps the existing path', () => {
    store().rebuild([item('a')]);
    store().setVerdict('a', 'like');
    expect(store().verdicts.a).toEqual({ verdict: 'like', path: [] });
    store().setPath('a', ['too-much']);
    expect(store().verdicts.a).toEqual({ verdict: 'like', path: ['too-much'] });
    store().setVerdict('a', 'dislike');
    expect(store().verdicts.a).toEqual({ verdict: 'dislike', path: ['too-much'] });
  });

  it('setPath is a no-op when no verdict exists', () => {
    store().setPath('ghost', ['x']);
    expect(store().verdicts.ghost).toBeUndefined();
  });
});
