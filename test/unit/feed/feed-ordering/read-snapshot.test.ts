// read-snapshot — the DB-free "has the reader read this story?" input for the
// 7-day keep (D7, D14, D21). A story counts as read when any member was viewed
// on the Feed (card state 'v') or opened, matched by article id, the story's
// stable cluster id or its server story key. A 's' card (dwelt past) is unread.

import { buildReadSnapshot, isReadStory, parseCardState } from '@/lib/feed-ordering/read-snapshot';
import type { ForYouSuggestion } from '@/lib/stores/for-you-store';

type Row = Pick<ForYouSuggestion, 'articleId' | 'clusters' | 'storyKey'>;
const row = (articleId: string, stableClusterId?: string, storyKey?: string): Row =>
  ({
    articleId,
    clusters: stableClusterId ? [{ clusterId: `c-${stableClusterId}`, confidence: 1, stableClusterId }] : [],
    storyKey: storyKey ?? null,
  }) as Row;

describe('parseCardState', () => {
  it('reads the persisted wire blob', () => {
    const blob = JSON.stringify({ states: { a: ['v', 10], b: ['s', 20] } });
    expect(parseCardState(blob)).toEqual({ a: { state: 'viewed', at: 10 }, b: { state: 'skipped', at: 20 } });
  });

  it('degrades to "everything unviewed" on a missing or malformed blob', () => {
    expect(parseCardState(null)).toEqual({});
    expect(parseCardState('not json')).toEqual({});
    expect(parseCardState(JSON.stringify({ states: 3 }))).toEqual({});
    expect(parseCardState(JSON.stringify([1]))).toEqual({});
  });

  it('drops malformed entries and ignores the old tombs map', () => {
    const blob = JSON.stringify({
      states: { ok: ['v', 1], badCode: ['x', 1], badAt: ['v', 'soon'], short: ['v'], inf: ['s', null] },
      tombs: { gone: 1 },
    });
    expect(parseCardState(blob)).toEqual({ ok: { state: 'viewed', at: 1 } });
  });
});

describe('buildReadSnapshot / isReadStory', () => {
  const NONE = new Set<string>();

  it('a viewed card marks every member of its story read (stable cluster), siblings included', () => {
    // The order id is the representative's article id at first ingest.
    const rows = [row('rep', 'S1'), row('sib1', 'S1'), row('sib2', 'S1'), row('other', 'S2')];
    const snap = buildReadSnapshot({ rep: { state: 'viewed', at: 1 } }, NONE, rows);
    expect(rows.map((r) => isReadStory(r, snap))).toEqual([true, true, true, false]);
  });

  it('a story joined only by the server story key is read as one story', () => {
    const rows = [row('rep', undefined, 'k1'), row('copy', undefined, 'k1'), row('else', undefined, 'k2')];
    const snap = buildReadSnapshot({ rep: { state: 'viewed', at: 1 } }, NONE, rows);
    expect(rows.map((r) => isReadStory(r, snap))).toEqual([true, true, false]);
  });

  it("a skipped ('s', dwelt past) card is still unread", () => {
    const rows = [row('rep', 'S1'), row('sib', 'S1')];
    const snap = buildReadSnapshot({ rep: { state: 'skipped', at: 1 } }, NONE, rows);
    expect(rows.map((r) => isReadStory(r, snap))).toEqual([false, false]);
  });

  it('an open by article id or by stable cluster id reads the story', () => {
    const rows = [row('a', 'S1'), row('a-sib', 'S1'), row('b', 'S2'), row('b-sib', 'S2'), row('c')];
    // `opened` is the opened-stories set: article ids and stable cluster ids.
    const snap = buildReadSnapshot({}, new Set(['a', 'S2']), rows);
    expect(rows.map((r) => isReadStory(r, snap))).toEqual([true, true, true, true, false]);
  });

  it('a viewed id with no row left still reads that exact article', () => {
    const snap = buildReadSnapshot({ gone: { state: 'viewed', at: 1 } }, NONE, []);
    expect(isReadStory(row('gone'), snap)).toBe(true);
    expect(isReadStory(row('fresh', 'S9'), snap)).toBe(false);
  });

  it('an empty snapshot reads nothing', () => {
    const snap = buildReadSnapshot({}, NONE, [row('a', 'S1')]);
    expect(isReadStory(row('a', 'S1'), snap)).toBe(false);
  });

  it('a viewed record carries its story keys, so the read outlives the viewed row', () => {
    // Rep R was viewed, then deleted at 48h; sibling S arrives later and the
    // pool no longer holds R. The persisted keys still lift S to read.
    const blob = JSON.stringify({ states: { R: ['v', 1, ['S1', 'sk:k1']] } });
    const states = parseCardState(blob);
    expect(states.R.keys).toEqual(['S1', 'sk:k1']);
    const sib = row('S', 'S1');
    const byKey = row('S2row', undefined, 'k1');
    const snap = buildReadSnapshot(states, NONE, [sib, byKey]);
    expect(isReadStory(sib, snap)).toBe(true);
    expect(isReadStory(byKey, snap)).toBe(true);
    expect(isReadStory(row('x', 'S9'), snap)).toBe(false);
  });

  it('keys on a skipped record are ignored', () => {
    const snap = buildReadSnapshot(parseCardState(JSON.stringify({ states: { R: ['s', 1, ['S1']] } })), NONE, []);
    expect(isReadStory(row('S', 'S1'), snap)).toBe(false);
  });
});
