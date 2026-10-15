// not-read-tail — the Continuous view's articles Mera has not read: after
// every scored card, newest first, membership frozen per reading session.
import {
  applyFeedShow,
  foldNotReadTail,
  newNotReadTailSession,
  TAIL_RENDER_CAP,
} from '@/components/custom/feed/not-read-tail';
import { extendPinnedIds, sortFeedEntries } from '@/components/custom/feed/feed-entries';
import { isNotRead, isUnscoredVisible } from '@/lib/feed-ordering/pending-visibility';
import { ArticleSuggestionStatus } from '@/lib/database/article-suggestion-status';
import type { FeedListItem } from '@/lib/stores/feed-list-selector';
import type { CardStateRecord } from '@/lib/stores/feed-order-store';
import type { ForYouSuggestion } from '@/lib/stores/for-you-store';

const H = 3_600_000;
const NOW = 1_000_000_000_000;

function item(
  id: string,
  o: { status?: string; relevance?: number; ageH?: number; members?: string[] } = {},
): FeedListItem {
  const members = o.members ?? [id];
  return {
    id,
    suggestion: {
      _id: id,
      articleId: id,
      status: o.status ?? ArticleSuggestionStatus.Complete,
      relevance: o.relevance ?? 0.6,
      reason: o.status === ArticleSuggestionStatus.Unscored ? null : 'because',
      firstPubDate: new Date(NOW - (o.ageH ?? 1) * H).toISOString(),
      createdAt: new Date(NOW).toISOString(),
      clusters: [],
    } as unknown as ForYouSuggestion,
    memberCount: members.length,
    memberIds: members,
    breaking: false,
    score: 0,
  };
}
const unread = (id: string, ageH: number, members?: string[]) =>
  item(id, { status: ArticleSuggestionStatus.Unscored, ageH, members });
const ids = (xs: readonly FeedListItem[]) => xs.map((x) => x.id);
const noStates: Record<string, CardStateRecord> = {};

describe('isNotRead / isUnscoredVisible', () => {
  it('only unscored is not read; terminal states never pass', () => {
    expect(isNotRead({ status: ArticleSuggestionStatus.Unscored })).toBe(true);
    for (const st of [
      ArticleSuggestionStatus.Complete,
      ArticleSuggestionStatus.ReasonPending,
      ArticleSuggestionStatus.Excluded,
      ArticleSuggestionStatus.AlreadyRead,
      ArticleSuggestionStatus.ReasonSkipped,
    ]) {
      expect(isNotRead({ status: st })).toBe(false);
    }
  });
  it('an unscored row outside the 48h window is not visible', () => {
    const cutoff = NOW - 48 * H;
    expect(isUnscoredVisible(unread('a', 47).suggestion, cutoff)).toBe(true);
    expect(isUnscoredVisible(unread('b', 49).suggestion, cutoff)).toBe(false);
  });
});

describe('foldNotReadTail', () => {
  it('holds only not-read stories, newest published first, and counts every article', () => {
    const s = newNotReadTailSession();
    const out = foldNotReadTail(s, [item('p1'), unread('old', 30), unread('new', 2, ['new', 'new2']), item('p2')]);
    expect(ids(out.tail)).toEqual(['new', 'old']);
    expect(out.notReadArticles).toBe(3);
    expect(out.withheld.has('p1')).toBe(false);
  });

  it('membership is frozen: a tail row Mera reads stays in place with its new state', () => {
    const s = newNotReadTailSession();
    foldNotReadTail(s, [unread('a', 1), unread('b', 2)]);
    const scoredA = item('a', { relevance: 0.9 });
    const out = foldNotReadTail(s, [scoredA, unread('b', 2)]);
    expect(ids(out.tail)).toEqual(['a', 'b']);
    expect(out.tail[0]).toBe(scoredA);
    expect(out.withheld.has('a')).toBe(true);
    expect(out.notReadArticles).toBe(1);
  });

  it('a tail row that leaves the pool (scored below the gate) stays until the next session', () => {
    const s = newNotReadTailSession();
    foldNotReadTail(s, [unread('a', 1), unread('b', 2)]);
    expect(ids(foldNotReadTail(s, [unread('b', 2)]).tail)).toEqual(['a', 'b']);
    expect(ids(foldNotReadTail(newNotReadTailSession(), [unread('b', 2)]).tail)).toEqual(['b']);
  });

  it('a scored story sharing a member with a tail row is withheld, so a story never shows twice', () => {
    const s = newNotReadTailSession();
    foldNotReadTail(s, [unread('a', 1, ['a', 'a2'])]);
    const out = foldNotReadTail(s, [item('a2', { members: ['a2', 'a'] }), item('other')]);
    expect(out.withheld.has('a2')).toBe(true);
    expect(out.withheld.has('other')).toBe(false);
  });

  it('mid-session arrivals append at the end, newest first among themselves', () => {
    const s = newNotReadTailSession();
    foldNotReadTail(s, [unread('a', 5)]);
    const out = foldNotReadTail(s, [unread('a', 5), unread('x', 10), unread('y', 1)]);
    expect(ids(out.tail)).toEqual(['a', 'y', 'x']);
  });

  it('is idempotent for the same candidates (a double render)', () => {
    const s = newNotReadTailSession();
    const c = [unread('a', 1), unread('b', 2)];
    foldNotReadTail(s, c);
    expect(ids(foldNotReadTail(s, c).tail)).toEqual(['a', 'b']);
  });

  it('renders at most the cap, the newest; the count stays true', () => {
    const many = Array.from({ length: TAIL_RENDER_CAP + 5 }, (_, i) => unread(`u${i}`, i + 1));
    const out = foldNotReadTail(newNotReadTailSession(), many);
    expect(out.tail).toHaveLength(TAIL_RENDER_CAP);
    expect(out.tail[0].id).toBe('u0');
    expect(out.notReadArticles).toBe(TAIL_RENDER_CAP + 5);
  });
});

describe('the sink: every scored card first, in every seen tier', () => {
  it('a seen, opened Low pick still sorts above every not-read card', () => {
    const scored = [item('hi', { relevance: 0.9 }), item('lowOpened', { relevance: 0.41 })];
    const sorted = sortFeedEntries(scored, { lowOpened: { state: 'viewed', at: 1 } }, new Set(['lowOpened']), [], NOW);
    const tail = foldNotReadTail(newNotReadTailSession(), [unread('fresh', 0)]).tail;
    expect(ids(applyFeedShow(sorted.rows, tail, 'all').rows)).toEqual(['hi', 'lowOpened', 'fresh']);
  });

  it('the pin never holds a not-read card, even after a cache clear with nothing scored', () => {
    // The pin is extended over the SCORED rows only (the screen passes those).
    expect(extendPinnedIds([], sortFeedEntries([], noStates, new Set()).rows, null)).toEqual([]);
    const scored = sortFeedEntries([item('p1'), item('p2')], noStates, new Set()).rows;
    expect(extendPinnedIds([], scored, null)).toEqual(['p1', 'p2']);
  });
});

describe('applyFeedShow', () => {
  const scored = [item('p1'), item('p2')];
  const tail = [unread('u1', 1)];
  it('all = picks then not read; picks counts the leading scored rows', () => {
    expect(applyFeedShow(scored, tail, 'all')).toEqual({ rows: [...scored, ...tail], picks: 2 });
  });
  it("Mera's picks = scored rows only", () => {
    expect(ids(applyFeedShow(scored, tail, 'picks').rows)).toEqual(['p1', 'p2']);
  });
  it('Not read by Mera = the tail only', () => {
    expect(applyFeedShow(scored, tail, 'unread')).toEqual({ rows: tail, picks: 0 });
  });
});
