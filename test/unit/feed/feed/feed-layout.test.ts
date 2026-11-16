// layoutFeed — the Feed's fold (D5, D18): a stable partition of the sorted
// list by sort band, Medium and up above the fold, Low below it. The fold card
// is the list's terminal card while collapsed; once expanded its label rides
// the first Low row's divider slot, so every rendered row stays a real story.

import {
  EMPTY_PIN,
  expandFold,
  extendPin,
  layoutFeed,
  type FeedLayoutInput,
  type FeedPin,
} from '@/components/custom/feed/feed-entries';
import { ArticleSuggestionStatus } from '@/lib/database/article-suggestion-status';
import type { CardStateRecord } from '@/lib/stores/feed-order-store';
import type { FeedListItem } from '@/lib/stores/feed-list-selector';
import type { ForYouSuggestion } from '@/lib/stores/for-you-store';

const NOW = Date.parse('2026-11-16T12:00:00.000Z');
const H = 3_600_000;

function item(
  id: string,
  relevance: number,
  o: { ageH?: number; status?: string; reason?: string; members?: string[] } = {},
): FeedListItem {
  const members = o.members ?? [id];
  return {
    id,
    suggestion: {
      _id: id,
      articleId: id,
      relevance,
      status: o.status ?? ArticleSuggestionStatus.Complete,
      reason: o.reason ?? 'Why it matters.',
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
const high = (id: string, o?: Parameters<typeof item>[2]) => item(id, 0.9, o);
const med = (id: string, o?: Parameters<typeof item>[2]) => item(id, 0.7, o);
const low = (id: string, o?: Parameters<typeof item>[2]) => item(id, 0.45, o);
const notRead = (id: string) => item(id, 0, { status: ArticleSuggestionStatus.Unscored, reason: '' });
const pending = (id: string, relevance: number) =>
  item(id, relevance, { status: ArticleSuggestionStatus.ReasonPending, reason: '' });

const ids = (xs: readonly FeedListItem[]) => xs.map((x) => x.id);
const noStates: Record<string, CardStateRecord> = {};
const seen = (at = 1): CardStateRecord => ({ state: 'skipped', at });

function layout(o: Partial<FeedLayoutInput> & { data: FeedListItem[] }) {
  return layoutFeed({
    cardStates: noStates,
    openedArticleIds: new Set(),
    nowMs: NOW,
    pin: EMPTY_PIN,
    tail: [],
    show: 'all',
    ready: true,
    ...o,
  });
}

describe('layoutFeed: the fold line', () => {
  it('puts the fold at the Medium/Low line, Low rows folded behind the fold card', () => {
    const out = layout({ data: [low('l1'), high('h1'), med('m1'), low('l2')] });
    expect(ids(out.rows)).toEqual(['h1', 'm1']);
    expect(ids(out.below)).toEqual(['l1', 'l2']);
    expect(out.terminal).toBe('fold');
    expect(out.foldIndex).toBeNull(); // collapsed: the card is the terminal, not a row divider
    expect(out.picks).toBe(2);
  });

  it('is a stable partition across tiers: seen High and Medium stay above, unseen Low below', () => {
    const data = [low('l1'), high('hSeen'), med('mSeen'), med('m1')];
    const out = layout({ data, cardStates: { hSeen: seen(), mSeen: seen() } });
    expect(ids(out.rows)).toEqual(['m1', 'hSeen', 'mSeen']);
    expect(ids(out.below)).toEqual(['l1']);
  });

  it('D6: an unread High at 30h stays above a fresh Medium and above the fold', () => {
    const out = layout({ data: [med('mFresh', { ageH: 1 }), high('hOld', { ageH: 30 })] });
    expect(ids(out.rows)).toEqual(['hOld', 'mFresh']);
  });

  it('a stale unread Medium is demoted into the Low band and so folds', () => {
    const out = layout({ data: [med('mOld', { ageH: 30 }), high('h1')] });
    expect(ids(out.rows)).toEqual(['h1']);
    expect(ids(out.below)).toEqual(['mOld']);
  });

  it('a card waiting for its note sinks to the end of its own side, not below every Low', () => {
    const data = [pending('pHigh', 0.9), med('m1'), low('l1'), pending('pLow', 0.45), low('l2')];
    const open = layout({ data });
    expect(ids(open.rows)).toEqual(['m1', 'pHigh']);
    expect(ids(open.below)).toEqual(['l1', 'l2', 'pLow']);
  });

  it('nothing reaches Medium: the fold still shows, with no row above it', () => {
    const out = layout({ data: [low('l1'), low('l2')] });
    expect(out.rows).toEqual([]);
    expect(out.terminal).toBe('fold');
    expect(out.below).toHaveLength(2);
  });
});

describe('layoutFeed: the fold count never holds a row Mera has not read', () => {
  it('the not-read tail waits behind the fold and is not counted in it', () => {
    const out = layout({ data: [high('h1'), low('l1')], tail: [notRead('t1'), notRead('t2')] });
    expect(ids(out.rows)).toEqual(['h1']);
    expect(ids(out.below)).toEqual(['l1']);
    expect(out.terminal).toBe('fold');
  });

  it('no Low but a not-read tail: no fold; the tail renders after the picks, then the end card', () => {
    const out = layout({ data: [high('h1'), med('m1')], tail: [notRead('t1')] });
    expect(ids(out.rows)).toEqual(['h1', 'm1', 't1']);
    expect(out.below).toEqual([]);
    expect(out.picks).toBe(2); // the not-read divider index
    expect(out.terminal).toBe('end');
    expect(out.renderedAfterPicks).toBe(1);
  });

  it('nothing below the fold at all: the end card', () => {
    const out = layout({ data: [high('h1')] });
    expect(out.terminal).toBe('end');
    expect(out.renderedAfterPicks).toBe(0);
  });
});

describe('layoutFeed: before the first run finishes', () => {
  it('shows the quiet reading line, hides Low and the tail', () => {
    const out = layout({ data: [high('h1'), low('l1')], tail: [notRead('t1')], ready: false });
    expect(ids(out.rows)).toEqual(['h1']);
    expect(out.terminal).toBe('reading');
    // Picks keep arriving during the first run: the reading line never closes the pin.
    expect(out.renderedAfterPicks).toBe(0);
  });
});

describe('layoutFeed: the Show filter', () => {
  const data = [high('h1'), low('l1')];
  const tail = [notRead('t1')];
  const discarded = [item('d1', 0.2)];

  it("'picks' folds the same way, with no tail", () => {
    const out = layout({ data, tail, show: 'picks' });
    expect(ids(out.rows)).toEqual(['h1']);
    expect(out.terminal).toBe('fold');
    const expanded = layout({ data, tail, show: 'picks', pin: expandFold(EMPTY_PIN, out) });
    expect(ids(expanded.rows)).toEqual(['h1', 'l1']);
    expect(expanded.picks).toBe(2);
  });

  it("'unread' and 'discarded' never fold", () => {
    const unread = layout({ data, tail, show: 'unread', discarded });
    expect(ids(unread.rows)).toEqual(['t1']);
    expect(unread.picks).toBe(0);
    expect(unread.foldIndex).toBeNull();
    expect(unread.terminal).toBe('end');
    const disc = layout({ data, tail, show: 'discarded', discarded });
    expect(ids(disc.rows)).toEqual(['d1']);
    expect(disc.terminal).toBe('end');
  });
});

describe('layoutFeed: insertion around the fold (nothing on screen moves)', () => {
  /** Run the screen's pin step: extend over the rendered above-fold picks. */
  const step = (pin: FeedPin, data: FeedListItem[], floor: number) => {
    const before = layout({ data, pin });
    return extendPin(pin, before.above, null, floor, before.renderedAfterPicks, ids(before.below));
  };

  it('fold card on screen: the pin closes, a High arriving is held and the rendered ids do not change', () => {
    const data = [high('h1'), med('m1'), low('l1')];
    // Both picks and the fold card on screen: floor = last(1) + 1 + 2 = 4 > 2 picks.
    const pin = step(EMPTY_PIN, data, 4);
    expect(pin.closed).toBe(true);
    expect(pin.belowIds).toEqual(['l1']);
    const before = layout({ data, pin });
    const after = layout({ data: [high('hot'), ...data], pin });
    expect(ids(after.rows)).toEqual(ids(before.rows));
    expect(after.heldCount).toBe(1);
    expect(after.terminal).toBe('fold');
    expect(ids(after.below)).toEqual(['l1']);
  });

  it('fold far below the reader: a High arriving sorts in above it', () => {
    const data = [high('h1'), high('h2'), med('m1'), med('m2'), med('m3'), med('m4'), med('m5'), med('m6'), med('m7'), low('l1')];
    const pin = step(EMPTY_PIN, data, 3);
    expect(pin.closed).toBe(false);
    const after = layout({ data: [high('hot'), ...data], pin });
    expect(after.heldCount).toBe(0);
    const r = ids(after.rows);
    // Lands at the top of its band inside the dynamic region, below the pinned prefix, above the fold.
    expect(r.indexOf('hot')).toBeGreaterThanOrEqual(pin.ids.length);
    expect(r).toContain('hot');
    expect(ids(after.below)).toEqual(['l1']);
  });

  it('a Low arriving while the fold is open joins the folded rows; once closed it is held', () => {
    const data = [high('h1'), low('l1')];
    const open = layout({ data: [...data, low('l2')] });
    expect(ids(open.below)).toEqual(['l1', 'l2']);
    const closed = step(EMPTY_PIN, data, 9);
    const after = layout({ data: [...data, low('l2')], pin: closed });
    expect(ids(after.below)).toEqual(['l1']);
    expect(after.heldCount).toBe(1);
  });

  it('a pending note landing moves nothing above the reader', () => {
    const p = pending('p', 0.9);
    const data = [high('h1'), med('m1'), p, low('l1')];
    const pin = step(EMPTY_PIN, data, 0); // pins the first 6 above-fold rows: all three
    const landed = { ...p, suggestion: { ...p.suggestion, status: ArticleSuggestionStatus.Complete, reason: 'Done.' } };
    const before = layout({ data, pin });
    const after = layout({ data: [high('h1'), med('m1'), landed, low('l1')], pin });
    expect(ids(after.rows)).toEqual(ids(before.rows));
  });

  it('a pinned row rescored below the line stays where the reader saw it', () => {
    const data = [high('h1'), med('m1'), low('l1')];
    const pin = step(EMPTY_PIN, data, 0);
    const rescored = [high('h1'), low('m1'), low('l1')];
    expect(ids(layout({ data: rescored, pin }).rows)).toEqual(['h1', 'm1']);
  });
});

describe('expandFold (Show them)', () => {
  it('pins rendered and folded rows, closed and expanded; Low renders, then the tail, then the end card', () => {
    const data = [high('h1'), med('m1'), low('l1'), low('l2')];
    const tail = [notRead('t1')];
    const collapsed = layout({ data, tail });
    const pin = expandFold(EMPTY_PIN, collapsed);
    expect(pin).toEqual({ ids: ['h1', 'm1', 'l1', 'l2'], closed: true, expanded: true, belowIds: ['l1', 'l2'] });
    const out = layout({ data, tail, pin });
    expect(ids(out.rows)).toEqual(['h1', 'm1', 'l1', 'l2', 't1']);
    expect(out.foldIndex).toBe(2); // the label rides the first Low row's divider slot
    expect(out.picks).toBe(4); // the not-read divider sits after every scored row
    expect(out.terminal).toBe('end');
  });

  it('held picks are not pinned and wait for the next session', () => {
    const data = [high('h1'), low('l1')];
    const pin = expandFold(EMPTY_PIN, layout({ data }));
    const out = layout({ data: [high('hot'), low('lNew'), ...data], pin });
    expect(ids(out.rows)).toEqual(['h1', 'l1']);
    expect(out.heldCount).toBe(2);
  });

  it('extendPin keeps an expanded pin as it is', () => {
    const data = [high('h1'), low('l1')];
    const pin = expandFold(EMPTY_PIN, layout({ data }));
    const out = layout({ data, pin });
    expect(extendPin(pin, out.above, 'h1', 99, out.renderedAfterPicks, ids(out.below))).toBe(pin);
  });

  it('every folded row gone: no label', () => {
    const data = [high('h1'), low('l1')];
    const pin = expandFold(EMPTY_PIN, layout({ data }));
    const out = layout({ data: [high('h1')], pin });
    expect(out.foldIndex).toBeNull();
  });

  it('resetSession (EMPTY_PIN) collapses the fold', () => {
    const data = [high('h1'), low('l1')];
    expect(layout({ data, pin: EMPTY_PIN }).terminal).toBe('fold');
    expect(EMPTY_PIN.expanded).toBe(false);
  });

  it('the tail rendered and the pin closed with no fold: no fold for the rest of the session', () => {
    const data = [high('h1')];
    const tail = [notRead('t1')];
    const first = layout({ data, tail });
    const pin = extendPin(EMPTY_PIN, first.above, null, 9, first.renderedAfterPicks, ids(first.below));
    expect(pin.closed).toBe(true);
    expect(pin.belowIds).toEqual([]);
    const later = layout({ data: [...data, low('l1')], tail, pin });
    expect(later.below).toEqual([]);
    expect(later.heldCount).toBe(1);
    expect(later.terminal).toBe('end');
  });
});
