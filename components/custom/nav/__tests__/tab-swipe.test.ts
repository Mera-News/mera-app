import {
  PAGE_COMMIT_FRACTION,
  SWIPE_DAMPING,
  TAB_HANDOFF_FRACTION,
  fractionalIndex,
  swipeDecision,
  swipeOutcome,
  survivingPage,
  swipeWindow,
} from '../tab-swipe';

const W = 400;
const base = { width: W, index: 1, count: 3, rtl: false, hasPrevTab: true, hasNextTab: true, vx: 0 };
/** Finger travel that moves the damped row by `fraction` of the width. */
const travel = (fraction: number) => (fraction * W) / SWIPE_DAMPING;

describe('swipeOutcome: pages', () => {
  it('commits to the next page past the commit fraction (leftward, LTR)', () => {
    expect(swipeOutcome({ ...base, dx: -travel(PAGE_COMMIT_FRACTION) })).toEqual({ kind: 'page', index: 2 });
  });

  it('springs back just short of it', () => {
    expect(swipeOutcome({ ...base, dx: -travel(PAGE_COMMIT_FRACTION) + 1 })).toBeNull();
  });

  it('commits a short flick in the drag direction', () => {
    expect(swipeOutcome({ ...base, dx: -30, vx: -700 })).toEqual({ kind: 'page', index: 2 });
  });

  it('springs back on a flick against the drag', () => {
    expect(swipeOutcome({ ...base, dx: -travel(0.5), vx: 700 })).toBeNull();
  });

  it('mirrors in RTL: a leftward drag goes to the previous page', () => {
    expect(swipeOutcome({ ...base, rtl: true, dx: -travel(0.4) })).toEqual({ kind: 'page', index: 0 });
  });
});

describe('swipeOutcome: tab handoff', () => {
  const last = { ...base, index: 2 };
  const first = { ...base, index: 0 };

  it('hands off to the next tab past the last page only after the handoff travel', () => {
    expect(swipeOutcome({ ...last, dx: -travel(TAB_HANDOFF_FRACTION) })).toEqual({ kind: 'tab', step: 1 });
    expect(swipeOutcome({ ...last, dx: -travel(TAB_HANDOFF_FRACTION) + 1 })).toBeNull();
  });

  it('never hands off on a flick alone', () => {
    expect(swipeOutcome({ ...last, dx: -60, vx: -3000 })).toBeNull();
  });

  it('hands off to the previous tab before the first page', () => {
    expect(swipeOutcome({ ...first, dx: travel(0.4) })).toEqual({ kind: 'tab', step: -1 });
  });

  it('stays when there is no tab that way (Feed has none before it)', () => {
    expect(swipeOutcome({ ...first, hasPrevTab: false, dx: travel(0.6) })).toBeNull();
  });

  it('mirrors in RTL: a rightward drag past the last page is the next tab', () => {
    expect(swipeOutcome({ ...last, rtl: true, dx: travel(0.4) })).toEqual({ kind: 'tab', step: 1 });
  });

  it('a single-page tab hands off both ways', () => {
    const only = { ...base, index: 0, count: 1 };
    expect(swipeOutcome({ ...only, dx: -travel(0.4) })).toEqual({ kind: 'tab', step: 1 });
    expect(swipeOutcome({ ...only, dx: travel(0.4) })).toEqual({ kind: 'tab', step: -1 });
  });
});

describe('swipeWindow', () => {
  it('puts the active page first, then its neighbours', () => {
    expect(swipeWindow(1, 3)).toEqual([1, 0, 2]);
    expect(swipeWindow(0, 3)).toEqual([0, 1]);
  });

  it('keeps a keep-mounted page outside the window, never twice', () => {
    expect(swipeWindow(3, 4, [0])).toEqual([3, 2, 0]);
    expect(swipeWindow(1, 4, [0])).toEqual([1, 0, 2]);
  });

  it('is empty for an out-of-range index', () => {
    expect(swipeWindow(5, 3)).toEqual([]);
  });
});

describe('swipeDecision', () => {
  const free = { dy: 0, inScroller: false, atStart: true, atEnd: true, rtl: false };

  it('waits until the touch has moved, then activates outside a scroller', () => {
    expect(swipeDecision({ ...free, dx: 5 })).toBe('wait');
    expect(swipeDecision({ ...free, dx: -12 })).toBe('activate');
  });

  it('leaves a vertical move to the list', () => {
    expect(swipeDecision({ ...free, dx: 4, dy: 20 })).toBe('fail');
  });

  it('inside a scroller activates only at its edge in the drag direction', () => {
    const s = { ...free, inScroller: true };
    expect(swipeDecision({ ...s, dx: -12, atStart: false, atEnd: false })).toBe('fail');
    expect(swipeDecision({ ...s, dx: -12, atStart: false, atEnd: true })).toBe('activate');
    expect(swipeDecision({ ...s, dx: 12, atStart: false, atEnd: true })).toBe('fail');
    expect(swipeDecision({ ...s, dx: 12, atStart: true, atEnd: false })).toBe('activate');
  });

  it('mirrors the edges in RTL', () => {
    const s = { ...free, inScroller: true, rtl: true };
    expect(swipeDecision({ ...s, dx: 12, atStart: false, atEnd: true })).toBe('activate');
  });

  it('B4: at the end, a drag back toward the start belongs to the scroller, in LTR and RTL', () => {
    const s = { ...free, inScroller: true, atStart: false, atEnd: true };
    expect(swipeDecision({ ...s, dx: 20, rtl: false })).toBe('fail');
    expect(swipeDecision({ ...s, dx: -20, rtl: true })).toBe('fail');
  });
});

describe('fractionalIndex', () => {
  it('moves toward the next page on a leftward drag, mirrored in RTL', () => {
    expect(fractionalIndex(1, -W / SWIPE_DAMPING / 2, W, false)).toBeCloseTo(1.5);
    expect(fractionalIndex(1, -W / SWIPE_DAMPING / 2, W, true)).toBeCloseTo(0.5);
  });
});

describe('survivingPage', () => {
  const pages = ['world', 'country:DE', 'country:NL'];
  it('keeps the active page while it exists, wherever it moved', () => {
    expect(survivingPage(['country:NL', 'world', 'country:DE'], 'country:DE', 2)).toBe('country:DE');
  });
  it('lands on the left neighbour when the active page was removed', () => {
    expect(survivingPage(['world', 'country:NL'], 'country:DE', 1)).toBe('world');
  });
  it('falls back to the first page', () => {
    expect(survivingPage(pages, null, 0)).toBe('world');
    expect(survivingPage([], 'world', 0)).toBeNull();
  });
});
