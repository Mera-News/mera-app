// swipe-deck-store — session deck layout tests (Round-4 P2).
//
// Covers: snapshot layout, freeze semantics (ingest never touches laid-out
// cards), buffer-behind-a-sentinel + sentinel-per-segment finalization,
// back-nav skipping sentinels, onTabFocus resume-vs-resnapshot rules, and
// undealt-card removal never touching the dealt prefix or a sentinel.

import {
  CAUGHT_UP_SENTINEL,
  RESNAPSHOT_IDLE_MS,
  useSwipeDeckStore,
} from '../swipe-deck-store';
import type { SwipeDeckCandidate } from '../swipe-stack-selector';
import type { ForYouSuggestion } from '../for-you-store';

const S = CAUGHT_UP_SENTINEL;

function c(
  id: string,
  over: { rawScore?: number; pubMs?: number; breaking?: boolean; memberCount?: number } = {},
): SwipeDeckCandidate {
  const suggestion = {
    _id: id,
    articleId: id,
    rawScore: over.rawScore ?? 0.5,
    firstPubDate: new Date(over.pubMs ?? 1_000).toISOString(),
  } as unknown as ForYouSuggestion;
  return {
    id,
    suggestion,
    memberCount: over.memberCount ?? 1,
    breaking: over.breaking ?? false,
  };
}

const store = () => useSwipeDeckStore.getState();

beforeEach(() => {
  store().reset();
});

describe('snapshot', () => {
  it('lays out a non-empty deck with a trailing sentinel and cursor 0', () => {
    store().snapshot([c('a'), c('b')]);
    const s = store();
    expect(s.order).toEqual(['a', 'b', S]);
    expect(s.cursor).toBe(0);
    expect(s.frozen).toBe(true);
    expect(Object.keys(s.cardsById).sort()).toEqual(['a', 'b']);
  });

  it('lays out an EMPTY snapshot as an empty order (no lone sentinel)', () => {
    store().snapshot([]);
    expect(store().order).toEqual([]);
  });
});

describe('freeze semantics', () => {
  it('ingest never reshuffles laid-out cards; new ids go to the buffer', () => {
    store().snapshot([c('a'), c('b')]);
    // `z` would sort before both, but the deck is frozen.
    store().ingest([c('z', { rawScore: 0.99 }), c('a'), c('b')]);
    const s = store();
    expect(s.order).toEqual(['a', 'b', S]);
    expect(s.pendingBuffer).toEqual(['z']);
    expect(s.cardsById.z).toBeDefined();
  });

  it('lays out a fresh deck when ingest hits a never-laid-out (empty) order', () => {
    store().snapshot([]); // order empty
    store().ingest([c('a')]);
    expect(store().order).toEqual(['a', S]);
    expect(store().cursor).toBe(0);
  });
});

describe('sentinel crossing / segmentation', () => {
  it('finalizes the buffer into a new segment + sentinel on crossing', () => {
    store().snapshot([c('a'), c('b')]);
    store().ingest([c('a'), c('b'), c('d', { rawScore: 0.9 }), c('e', { rawScore: 0.7 })]);
    expect(store().pendingBuffer).toEqual(['d', 'e']);

    store().advance(); // a -> b
    store().advance(); // b -> sentinel
    expect(store().order[store().cursor]).toBe(S);

    store().advance(); // cross sentinel -> finalize [d,e] sorted by deckCompare
    const s = store();
    expect(s.order).toEqual(['a', 'b', S, 'd', 'e', S]);
    expect(s.order[s.cursor]).toBe('d');
    expect(s.pendingBuffer).toEqual([]);
  });

  it('crossing the final sentinel with an empty buffer drops into the end state', () => {
    store().snapshot([c('a')]);
    store().advance(); // a -> sentinel
    store().advance(); // cross with empty buffer
    expect(store().cursor).toBe(store().order.length); // past the end
  });
});

describe('back navigation', () => {
  it('goBack skips over sentinels to the previous real card', () => {
    store().snapshot([c('a'), c('b')]);
    store().ingest([c('a'), c('b'), c('d')]);
    store().advance(); // -> b
    store().advance(); // -> sentinel
    store().advance(); // cross -> d  (order: a,b,S,d,S ; cursor at d = idx 3)
    expect(store().order[store().cursor]).toBe('d');

    store().goBack(); // skip the sentinel at idx 2 -> land on b (idx 1)
    expect(store().cursor).toBe(1);
    expect(store().order[store().cursor]).toBe('b');
  });

  it('goBack never underflows below 0', () => {
    store().snapshot([c('a'), c('b')]);
    store().goBack();
    expect(store().cursor).toBe(0);
  });
});

describe('onTabFocus resume-vs-resnapshot', () => {
  it('snapshots when the store is empty (relaunch)', () => {
    store().onTabFocus([c('a'), c('b')]);
    expect(store().order).toEqual(['a', 'b', S]);
    expect(store().cursor).toBe(0);
  });

  it('resumes position when not idle / not exhausted', () => {
    store().snapshot([c('a'), c('b')]);
    store().advance(); // cursor 1
    const t = store().lastActiveAt ?? 0;
    store().onTabFocus([c('a'), c('b')], t + 1000);
    expect(store().cursor).toBe(1); // preserved
    expect(store().order).toEqual(['a', 'b', S]);
  });

  it('re-snapshots after > 15 min idle', () => {
    store().snapshot([c('a'), c('b')]);
    store().advance(); // cursor 1
    const t = store().lastActiveAt ?? 0;
    store().onTabFocus([c('a'), c('b'), c('d')], t + RESNAPSHOT_IDLE_MS + 1);
    expect(store().cursor).toBe(0);
    expect(store().order).toEqual(['a', 'b', 'd', S]);
  });

  it('re-snapshots when the deck is exhausted', () => {
    store().snapshot([c('a')]);
    store().advance(); // -> sentinel
    store().advance(); // cross empty -> exhausted (cursor past end)
    store().onTabFocus([c('a'), c('b')], (store().lastActiveAt ?? 0) + 1);
    expect(store().order).toEqual(['a', 'b', S]);
    expect(store().cursor).toBe(0);
  });
});

describe('undealt-card removal', () => {
  it('drops undealt non-candidates but never a dealt entry or a sentinel', () => {
    store().snapshot([c('a'), c('b'), c('d')]); // order a,b,d,S
    store().advance(); // cursor 1 (top b); dealt prefix = a,b
    // b (current top) and d are no longer candidates (opened elsewhere).
    store().ingest([c('a')]);
    const s = store();
    // a,b protected (index <= cursor); d removed; sentinel kept.
    expect(s.order).toEqual(['a', 'b', S]);
    expect(s.cursor).toBe(1);
  });

  it('drops stale buffered ids that are no longer candidates', () => {
    store().snapshot([c('a')]);
    store().ingest([c('a'), c('x')]); // x buffered
    expect(store().pendingBuffer).toEqual(['x']);
    store().ingest([c('a')]); // x gone
    expect(store().pendingBuffer).toEqual([]);
  });
});

describe('verdict mirror', () => {
  it('sets, paths, and clears verdicts', () => {
    store().snapshot([c('a')]);
    store().setVerdict('a', 'like');
    expect(store().verdicts.a).toEqual({ verdict: 'like', path: [] });
    store().setPath('a', ['too-much']);
    expect(store().verdicts.a).toEqual({ verdict: 'like', path: ['too-much'] });
    store().setVerdict('a', 'dislike'); // flip keeps existing path
    expect(store().verdicts.a).toEqual({ verdict: 'dislike', path: ['too-much'] });
    store().clearVerdict('a');
    expect(store().verdicts.a).toBeUndefined();
  });

  it('setPath is a no-op when no verdict exists', () => {
    store().setPath('ghost', ['x']);
    expect(store().verdicts.ghost).toBeUndefined();
  });
});
