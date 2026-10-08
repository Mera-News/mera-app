import { allHeaderLabelsFit, HEADER_METRICS, headerOptionParts, headerOptionWidth, headerTrackMode } from '../fit';

const m = { pad: 17, icon: 18, gap: 8, dot: 10, chrome: 10 };

describe('headerOptionWidth', () => {
  it('adds the label and the dot to the icon', () => {
    expect(headerOptionWidth(null, false, m)).toBe(52);
    expect(headerOptionWidth(40, false, m)).toBe(100);
    expect(headerOptionWidth(40, true, m)).toBe(118);
  });
});

describe('allHeaderLabelsFit', () => {
  it('fits when the labelled options and the track chrome fit the space', () => {
    // 10 + (52 + 8 + 40) * 2 = 210
    expect(allHeaderLabelsFit([40, 40], [false, false], 210, m)).toBe(true);
    expect(allHeaderLabelsFit([40, 40], [false, false], 209, m)).toBe(false);
  });

  it('counts a dot', () => {
    expect(allHeaderLabelsFit([40, 40], [false, true], 210, m)).toBe(false);
  });

  it('is undecided until every label and the space are measured', () => {
    expect(allHeaderLabelsFit([40, undefined], [false, false], 400, m)).toBeNull();
    expect(allHeaderLabelsFit([40, 40], [false, false], null, m)).toBeNull();
    expect(allHeaderLabelsFit([40, 40], [false, false], 0, m)).toBeNull();
  });
});

describe('headerOptionParts', () => {
  it('names alone, icons and names, or icons with the selected name', () => {
    expect(headerOptionParts(false, 'names')).toEqual({ label: true, icon: false });
    expect(headerOptionParts(false, 'full')).toEqual({ label: true, icon: true });
    expect(headerOptionParts(false, 'compact')).toEqual({ label: false, icon: true });
    expect(headerOptionParts(true, 'compact')).toEqual({ label: true, icon: true });
  });
});

describe('headerTrackMode', () => {
  it('shows names alone when they all fit a names-first track, else compact', () => {
    // 10 + 2 x (34 + 40) = 158
    expect(headerTrackMode([40, 40], [false, false], 158, m, true)).toBe('names');
    expect(headerTrackMode([40, 40], [false, false], 157, m, true)).toBe('compact');
  });

  it('never shows icons and names on a names-first track', () => {
    expect(headerTrackMode([40, 40], [false, false], 1000, m, true)).toBe('names');
  });

  it('shows icons and names on a Feed-style track when they all fit', () => {
    expect(headerTrackMode([40, 40], [false, false], 1000, m, false)).toBe('full');
  });

  it('stays compact until everything is measured', () => {
    expect(headerTrackMode([40, undefined], [false, false], 1000, m, true)).toBe('compact');
    expect(headerTrackMode([40, 40], [false, false], null, m, false)).toBe('compact');
  });
});

describe('the 1.1x header track at 375pt', () => {
  // 375 less 2 x 6 side pad, the Feed status icon and the ? (44 each), and
  // 4pt either side of the track. Widths: 15.5pt bold SF, measured off-device.
  const feedSpace = 375 - 12 - 88 - 8;

  it('shows Feed and Stories with their labels (Stories has a dot)', () => {
    expect(allHeaderLabelsFit([40, 59], [false, true], feedSpace, HEADER_METRICS)).toBe(true);
  });

  // Library and You have no side controls: 375 less 2 x 6 and 4 x 2.
  const fullSpace = 375 - 12 - 8;

  it('You in English shows its names (Notifications has a dot)', () => {
    expect(headerTrackMode([54, 69, 105], [false, false, true], fullSpace, HEADER_METRICS, true)).toBe('names');
  });

  it('Library in English, and both in German, fall back to icons', () => {
    expect(headerTrackMode([50, 98, 60, 43], [false, true, false, false], fullSpace, HEADER_METRICS, true)).toBe('compact');
    expect(headerTrackMode([100, 114, 60, 69], [false, true, false, false], fullSpace, HEADER_METRICS, true)).toBe('compact');
    expect(headerTrackMode([44, 111, 165], [false, false, true], fullSpace, HEADER_METRICS, true)).toBe('compact');
  });
});
