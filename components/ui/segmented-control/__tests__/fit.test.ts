import { allHeaderLabelsFit, HEADER_METRICS, headerOptionParts, headerOptionWidth, headerTrackMode } from '../fit';

const m = { pad: 17, namesPad: 17, icon: 18, gap: 8, chrome: 10 };

describe('headerOptionWidth', () => {
  it('adds the label to the icon (the new dot is a badge and takes no room)', () => {
    expect(headerOptionWidth(null, m)).toBe(52);
    expect(headerOptionWidth(40, m)).toBe(100);
  });
});

describe('allHeaderLabelsFit', () => {
  it('fits when the labelled options and the track chrome fit the space', () => {
    // 10 + (52 + 8 + 40) * 2 = 210
    expect(allHeaderLabelsFit([40, 40], 210, m)).toBe(true);
    expect(allHeaderLabelsFit([40, 40], 209, m)).toBe(false);
  });

  it('is undecided until every label and the space are measured', () => {
    expect(allHeaderLabelsFit([40, undefined], 400, m)).toBeNull();
    expect(allHeaderLabelsFit([40, 40], null, m)).toBeNull();
    expect(allHeaderLabelsFit([40, 40], 0, m)).toBeNull();
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
    expect(headerTrackMode([40, 40], 158, m, true)).toBe('names');
    expect(headerTrackMode([40, 40], 157, m, true)).toBe('compact');
  });

  it('never shows icons and names on a names-first track', () => {
    expect(headerTrackMode([40, 40], 1000, m, true)).toBe('names');
  });

  it('shows icons and names on a Feed-style track when they all fit', () => {
    expect(headerTrackMode([40, 40], 1000, m, false)).toBe('full');
  });

  it('stays compact until everything is measured', () => {
    expect(headerTrackMode([40, undefined], 1000, m, true)).toBe('compact');
    expect(headerTrackMode([40, 40], null, m, false)).toBe('compact');
  });
});

describe('the 1.1x header track at 375pt', () => {
  // 375 less 2 x 6 side pad, the Feed status icon and the ? (44 each), and
  // 4pt either side of the track. Widths: 15.5pt bold SF, measured off-device.
  const feedSpace = 375 - 12 - 88 - 8;

  it('shows Feed and Stories with their labels', () => {
    expect(allHeaderLabelsFit([40, 59], feedSpace, HEADER_METRICS)).toBe(true);
  });

  // Library and You have no side controls: 375 less 2 x 6 and 4 x 2.
  const fullSpace = 375 - 12 - 8;

  it('You in English shows its names', () => {
    expect(headerTrackMode([54, 69, 105], fullSpace, HEADER_METRICS, true)).toBe('names');
  });

  it('Library in English shows its names at 375 and 390', () => {
    const widths = [50, 98, 60, 43];
        expect(headerTrackMode(widths, fullSpace, HEADER_METRICS, true)).toBe('names');
    expect(headerTrackMode(widths, 390 - 12 - 8, HEADER_METRICS, true)).toBe('names');
  });

  it('both tracks fall back to icons in German', () => {
    expect(headerTrackMode([100, 114, 60, 69], fullSpace, HEADER_METRICS, true)).toBe('compact');
    expect(headerTrackMode([44, 111, 165], fullSpace, HEADER_METRICS, true)).toBe('compact');
  });
});
