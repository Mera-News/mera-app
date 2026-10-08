import { allHeaderLabelsFit, HEADER_METRICS, headerLabelShown, headerOptionWidth } from '../fit';

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

describe('headerLabelShown', () => {
  it('shows every label when all fit, else only the selected one', () => {
    expect(headerLabelShown(false, true)).toBe(true);
    expect(headerLabelShown(true, true)).toBe(true);
    expect(headerLabelShown(true, false)).toBe(true);
    expect(headerLabelShown(false, false)).toBe(false);
    expect(headerLabelShown(true, null)).toBe(true);
    expect(headerLabelShown(false, null)).toBe(false);
  });
});

describe('the 1.1x header track at 375pt', () => {
  // 375 less 2 x 6 side pad, the Feed status icon and the ? (44 each), and
  // 4pt either side of the track. Widths: 15.5pt bold SF, measured off-device.
  const feedSpace = 375 - 12 - 88 - 8;
  const youSpace = 375 - 12 - 44 - 8;

  it('shows Feed and Stories with their labels (Stories has a dot)', () => {
    expect(allHeaderLabelsFit([40, 59], [false, true], feedSpace, HEADER_METRICS)).toBe(true);
  });

  it('falls back to the selected label for You', () => {
    expect(allHeaderLabelsFit([54, 69, 105], [false, false, true], youSpace, HEADER_METRICS)).toBe(false);
  });
});
