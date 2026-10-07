import {
  PAGE_COMMIT_FRACTION,
  SWIPE_DAMPING,
  TAB_HANDOFF_FRACTION,
  swipeOutcome,
  indicatorAt,
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

describe('indicatorAt', () => {
  const xs = [4, 90, 200];
  const widths = [80, 100, 60];
  it('sits on a page at a whole index', () => {
    expect(indicatorAt(1, xs, widths)).toEqual({ x: 90, width: 100 });
    expect(indicatorAt(2, xs, widths)).toEqual({ x: 200, width: 60 });
  });
  it('travels between two pages mid-swipe', () => {
    expect(indicatorAt(0.5, xs, widths)).toEqual({ x: 47, width: 90 });
  });
  it('clamps a pull past either end', () => {
    expect(indicatorAt(-0.3, xs, widths)).toEqual({ x: 4, width: 80 });
    expect(indicatorAt(2.4, xs, widths)).toEqual({ x: 200, width: 60 });
  });
  it('draws nothing before the pills are measured', () => {
    expect(indicatorAt(0, [], [])).toEqual({ x: 0, width: 0 });
  });
});
