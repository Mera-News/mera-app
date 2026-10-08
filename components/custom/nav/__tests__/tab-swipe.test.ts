import {
  PAGE_COMMIT_FRACTION,
  SWIPE_DAMPING,
  SWIPE_EDGE_DAMPING,
  dragFollow,
  swipeOutcome,
  survivingPage,
  swipeWindow,
  NO_TRANSIT,
  tapTransit,
  transitPanel,
  transitProgress,
} from '../tab-swipe';

const W = 400;
const base = { width: W, index: 1, count: 3, rtl: false, vx: 0 };
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

describe('swipeOutcome: the ends of a tab', () => {
  const last = { ...base, index: 2 };
  const first = { ...base, index: 0 };

  it('stays on the last page, and so on this tab, however far or fast the swipe', () => {
    expect(swipeOutcome({ ...last, dx: -travel(0.9) })).toBeNull();
    expect(swipeOutcome({ ...last, dx: -W * 3, vx: -3000 })).toBeNull();
  });

  it('stays on the first page', () => {
    expect(swipeOutcome({ ...first, dx: travel(0.9), vx: 3000 })).toBeNull();
  });

  it('mirrors in RTL: a rightward drag on the last page stays', () => {
    expect(swipeOutcome({ ...last, rtl: true, dx: travel(0.9) })).toBeNull();
  });

  it('a single-page tab never moves', () => {
    const only = { ...base, index: 0, count: 1 };
    expect(swipeOutcome({ ...only, dx: -travel(0.9) })).toBeNull();
    expect(swipeOutcome({ ...only, dx: travel(0.9) })).toBeNull();
  });
});

describe('dragFollow', () => {
  it('follows at the page damping toward a real page, and resists past the ends', () => {
    expect(dragFollow(-100, 1, 3, false)).toBeCloseTo(-100 * SWIPE_DAMPING);
    expect(dragFollow(-100, 2, 3, false)).toBeCloseTo(-100 * SWIPE_EDGE_DAMPING);
    expect(dragFollow(100, 0, 3, false)).toBeCloseTo(100 * SWIPE_EDGE_DAMPING);
    expect(dragFollow(100, 2, 3, true)).toBeCloseTo(100 * SWIPE_EDGE_DAMPING);
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

describe('tap slide transit', () => {
  it('lays the picked page next to the old one', () => {
    expect(tapTransit(0, 2)).toEqual([0, 2, 1]);
    expect(tapTransit(2, 0)).toEqual([2, 0, 1]);
    expect(tapTransit(1, 2)).toEqual([1, 2, 2]);
    expect(tapTransit(1, 1)).toBe(NO_TRANSIT);
  });

  it('maps the one-width slide onto the whole from -> to range', () => {
    const t = tapTransit(0, 2);
    expect(transitProgress(0, t)).toBe(0);
    expect(transitProgress(0.5, t)).toBe(1);
    expect(transitProgress(1, t)).toBe(2);
    expect(transitProgress(1.2, t)).toBe(2);
    expect(transitProgress(2, tapTransit(2, 0))).toBe(2);
    expect(transitProgress(1.5, tapTransit(2, 0))).toBe(1);
    expect(transitProgress(1.25, NO_TRANSIT)).toBe(1.25);
  });

  it('moves only the picked page and hides the page whose slot it borrows', () => {
    const t = tapTransit(0, 2);
    expect(transitPanel(2, t)).toEqual({ slot: 1, hidden: false });
    expect(transitPanel(1, t)).toEqual({ slot: 1, hidden: true });
    expect(transitPanel(0, t)).toEqual({ slot: 0, hidden: false });
    expect(transitPanel(1, NO_TRANSIT)).toEqual({ slot: 1, hidden: false });
  });
});
