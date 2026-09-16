import { render } from '@testing-library/react-native';
import React from 'react';
import {
  CHART_METRICS,
  HeatGrid,
  heatLevel,
  heatRows,
  heatTone,
  DotArray,
  FlagGrid,
  ProportionBar,
  RuledScale,
  dotsFor,
  scalePosition,
  splitFlagGrid,
} from '../card-charts';

jest.mock('@/components/custom/SourceFlag', () => {
  const { Text } = require('react-native');
  return {
    __esModule: true,
    SourceFlag: ({ countryCode }: { countryCode?: string | null }) => (
      <Text>{`flag:${countryCode ?? 'none'}`}</Text>
    ),
    default: () => null,
  };
});

describe('splitFlagGrid', () => {
  it('shows every flag when they fit', () => {
    expect(splitFlagGrid(['IN', 'US', 'GB'], 8)).toEqual({
      shown: ['IN', 'US', 'GB'],
      remaining: 0,
    });
  });

  it('shows every flag when the list is exactly full', () => {
    const codes = ['A', 'B', 'C', 'D'];
    expect(splitFlagGrid(codes, 4)).toEqual({ shown: codes, remaining: 0 });
  });

  it('NEVER leaves a remainder of one', () => {
    // The load-bearing invariant, and not a stylistic preference: it is what
    // lets shareStats.card.flagsMore interpolate {{n}} rather than {{count}}
    // and stay out of i18next plural resolution in all 20 dictionaries. If the
    // chip could say "+1", every locale would need singular agreement and ar
    // would need its full six CLDR categories.
    //
    // Exhaustive over every list length that can reach the branch, for a range
    // of grid sizes, rather than one example.
    for (let cells = 2; cells <= 30; cells += 1) {
      for (let total = 0; total <= cells + 40; total += 1) {
        const codes = Array.from({ length: total }, (_, i) => `C${i}`);
        const { shown, remaining } = splitFlagGrid(codes, cells);
        expect(remaining).not.toBe(1);
        // No flag is ever lost or duplicated between the two halves.
        expect(shown.length + remaining).toBe(total);
        expect(shown.length + (remaining > 0 ? 1 : 0)).toBeLessThanOrEqual(cells);
      }
    }
  });

  it('takes the branch it claims to take', () => {
    // Non-vacuity for the loop above: a split that never overflowed would
    // satisfy every assertion in it.
    const { remaining } = splitFlagGrid(Array.from({ length: 30 }, (_, i) => `C${i}`), 8);
    expect(remaining).toBeGreaterThanOrEqual(2);
  });

  it('survives a nonsense cell count rather than slicing to nothing', () => {
    expect(splitFlagGrid(['A', 'B', 'C'], 0).shown).toHaveLength(0);
    expect(splitFlagGrid(['A', 'B', 'C'], 0).remaining).toBe(3);
  });
});

describe('FlagGrid', () => {
  const label = (n: number) => `+${n} more`;

  it('renders one cell per flag and no chip when they fit', () => {
    const { queryByTestId, getByText } = render(
      <FlagGrid countryCodes={['IN', 'US']} k={1} overflowLabel={label} testID="grid" />,
    );
    expect(getByText('flag:IN')).toBeTruthy();
    expect(getByText('flag:US')).toBeTruthy();
    expect(queryByTestId('grid-overflow')).toBeNull();
  });

  it('renders the chip with a count of two or more when it overflows', () => {
    const codes = Array.from({ length: 10 }, (_, i) => `C${i}`);
    const { getByTestId, getByText } = render(
      <FlagGrid countryCodes={codes} k={1} overflowLabel={label} maxCells={4} testID="grid" />,
    );
    expect(getByTestId('grid-overflow')).toBeTruthy();
    expect(getByText('+7 more')).toBeTruthy();
  });

  it('gives every cell the same fixed box whatever is inside it', () => {
    // The Android insurance. Regional-indicator pairs are unproven in a
    // captured PNG and many OEM fonts draw them as two letter boxes, so the
    // cell is sized independently of its content: a platform that cannot draw
    // a flag degrades in appearance and never in layout.
    const { getByTestId } = render(
      <FlagGrid countryCodes={['IN', 'ZZ']} k={2} overflowLabel={label} testID="grid" />,
    );
    const known = getByTestId('grid-cell-IN').props.style;
    const unknown = getByTestId('grid-cell-ZZ').props.style;
    expect(known.width).toBe(CHART_METRICS.flagCell * 2);
    expect(known.height).toBe(CHART_METRICS.flagCell * 2);
    expect(unknown.width).toBe(known.width);
    expect(unknown.height).toBe(known.height);
  });
});

describe('ProportionBar', () => {
  const bands = [
    { id: 'IN', share: 0.5, label: 'IN 50%', accent: true },
    { id: 'US', share: 0.3, label: 'US 30%' },
    { id: 'rest', share: 0.2, label: 'rest' },
  ];

  it('gives each segment a flex equal to its share', () => {
    // flex, not a percentage string: the shares are exact fractions summing to
    // one, and letting flex divide the row means no rounding residue can open
    // a gap at the right edge that the legend does not explain.
    const { getByTestId } = render(<ProportionBar segments={bands} k={1} testID="bar" />);
    expect(getByTestId('bar-segment-IN').props.style.flex).toBe(0.5);
    expect(getByTestId('bar-segment-US').props.style.flex).toBe(0.3);
    expect(getByTestId('bar-segment-rest').props.style.flex).toBe(0.2);
  });

  it('gives the accent to exactly one segment', () => {
    const { getByTestId } = render(<ProportionBar segments={bands} k={1} testID="bar" />);
    const colours = bands.map((b) => getByTestId(`bar-segment-${b.id}`).props.style.backgroundColor);
    expect(colours.filter((c) => c === 'rgb(231, 138, 83)')).toHaveLength(1);
    expect(colours[0]).toBe('rgb(231, 138, 83)');
  });

  it('never gives two adjacent segments the same tone', () => {
    const { getByTestId } = render(<ProportionBar segments={bands} k={1} testID="bar" />);
    const colours = bands.map((b) => getByTestId(`bar-segment-${b.id}`).props.style.backgroundColor);
    expect(new Set(colours).size).toBe(colours.length);
  });

  it('renders nothing rather than an empty bar', () => {
    const { toJSON } = render(<ProportionBar segments={[]} k={1} testID="bar" />);
    expect(toJSON()).toBeNull();
  });

  it('clamps a negative share instead of inverting the row', () => {
    const { getByTestId } = render(
      <ProportionBar segments={[{ id: 'x', share: -1, label: 'x' }]} k={1} testID="bar" />,
    );
    expect(getByTestId('bar-segment-x').props.style.flex).toBe(0);
  });
});

describe('dotsFor', () => {
  it('draws one dot per item below the cap', () => {
    expect(dotsFor(12, 60)).toEqual({ drawn: 12, truncated: false });
  });

  it('caps and says so', () => {
    expect(dotsFor(140, 60)).toEqual({ drawn: 60, truncated: true });
  });

  it('floors nonsense rather than looping forever', () => {
    expect(dotsFor(-5, 60)).toEqual({ drawn: 0, truncated: false });
    expect(dotsFor(Number.NaN, 60)).toEqual({ drawn: 0, truncated: false });
    expect(dotsFor(7.8, 60)).toEqual({ drawn: 7, truncated: false });
  });
});

describe('DotArray', () => {
  it('draws exactly the counted number of dots', () => {
    const { getByTestId } = render(<DotArray count={5} k={1} testID="dots" />);
    expect(getByTestId('dots').children).toHaveLength(5);
  });

  it('distinguishes saved from followed by SHAPE, not only by colour', () => {
    // Two shapes rather than two colours, so the distinction survives a
    // greyscale screenshot and a reader who cannot separate the two hues.
    const filled = render(<DotArray count={1} k={1} shape="filled" testID="d" />);
    const ring = render(<DotArray count={1} k={1} shape="ring" testID="d" />);
    const f = filled.getByTestId('d').children[0] as unknown as { props: { style: Record<string, unknown> } };
    const r = ring.getByTestId('d').children[0] as unknown as { props: { style: Record<string, unknown> } };
    expect(f.props.style.backgroundColor).toBeDefined();
    expect(f.props.style.borderWidth).toBeUndefined();
    expect(r.props.style.borderWidth).toBeGreaterThan(0);
    expect(r.props.style.backgroundColor).toBeUndefined();
  });

  it('left-aligns so an overflow is visible rather than clipped at both ends', () => {
    // A wrapped row with centred content and overflow hidden clips its ENDS
    // symmetrically and looks correct while miscounting. This is the same trap
    // MarkTrail shipped.
    const { getByTestId } = render(<DotArray count={3} k={1} testID="dots" />);
    expect(getByTestId('dots').props.style.justifyContent).toBe('flex-start');
  });
});

describe('scalePosition', () => {
  it('places a value proportionally along the rule', () => {
    expect(scalePosition(0, 0, 48)).toBe(0);
    expect(scalePosition(24, 0, 48)).toBe(0.5);
    expect(scalePosition(48, 0, 48)).toBe(1);
  });

  it('pins a value past the end instead of running off the card', () => {
    expect(scalePosition(300, 0, 48)).toBe(1);
    expect(scalePosition(-10, 0, 48)).toBe(0);
  });

  it('returns a drawable position for a degenerate range', () => {
    expect(scalePosition(5, 10, 10)).toBe(0);
    expect(scalePosition(Number.NaN, 0, 48)).toBe(0);
  });
});

describe('RuledScale', () => {
  it('centres the marker on the value at any width', () => {
    // Percentage left plus a negative margin of half the marker width: the
    // marker's CENTRE lands on the value, and both ends stay inside the rule
    // without the component knowing how wide it will be.
    const { getByTestId } = render(
      <RuledScale value={12} min={0} max={48} k={1} startLabel="0h" endLabel="48h" testID="scale" />,
    );
    const marker = getByTestId('scale-marker').props.style;
    expect(marker.left).toBe('25%');
    expect(marker.marginLeft).toBe(-(CHART_METRICS.scaleMarker / 2));
  });

  it('renders both end labels', () => {
    const { getByText } = render(
      <RuledScale value={9} min={0} max={48} k={1} startLabel="0h" endLabel="48h" testID="scale" />,
    );
    expect(getByText('0h')).toBeTruthy();
    expect(getByText('48h')).toBeTruthy();
  });
});

describe('every chart text node', () => {
  it('carries a lineHeight larger than its fontSize', () => {
    // Same rule as the card. components/ui/text merges caller style after its
    // own size token, so a bare fontSize wins while the token's much smaller
    // lineHeight survives and React Native clips the glyph to it. At an
    // ordinary 22pt that eats the above-base marks off Devanagari and Thai.
    const trees = [
      render(
        <FlagGrid
          countryCodes={Array.from({ length: 30 }, (_, i) => `C${i}`)}
          k={3}
          overflowLabel={(n) => `+${n} more`}
        />,
      ),
      render(
        <ProportionBar
          segments={[{ id: 'a', share: 1, label: 'IN 100%', accent: true }]}
          k={3}
        />,
      ),
      render(<RuledScale value={9} min={0} max={48} k={3} startLabel="0h" endLabel="48h" />),
    ];

    const flatten = (style: unknown): Record<string, unknown> =>
      Array.isArray(style)
        ? style.reduce<Record<string, unknown>>((acc, s) => ({ ...acc, ...flatten(s) }), {})
        : ((style ?? {}) as Record<string, unknown>);

    let checked = 0;
    for (const tree of trees) {
      const texts = tree.UNSAFE_getAllByType(
        require('react-native').Text as React.ComponentType<Record<string, unknown>>,
      );
      for (const node of texts) {
        const style = flatten(node.props.style);
        if (style.fontSize === undefined) continue;
        checked += 1;
        expect(typeof style.lineHeight).toBe('number');
        expect(style.lineHeight as number).toBeGreaterThan(style.fontSize as number);
      }
    }
    // Without this the loop passes by skipping every node.
    expect(checked).toBeGreaterThanOrEqual(4);
  });
});

describe('heatLevel', () => {
  it('reserves level 0 for a genuine zero', () => {
    // So an unread day is always visibly different from the quietest read day,
    // however low the peak is. A continuous ramp would put a one-article day
    // at an alpha indistinguishable from nothing for a light reader.
    expect(heatLevel(0, 10)).toBe(0);
    expect(heatLevel(1, 10)).toBe(1);
    expect(heatLevel(1, 1)).toBe(4);
  });

  it('is five steps, because the eye cannot rank a continuous alpha here', () => {
    const levels = [0, 1, 3, 6, 8, 10].map((c) => heatLevel(c, 10));
    expect(new Set(levels).size).toBe(5);
    expect(Math.max(...levels)).toBe(4);
  });

  it('never divides by a zero or nonsense peak', () => {
    expect(heatLevel(5, 0)).toBe(1);
    expect(heatLevel(5, Number.NaN)).toBe(1);
    expect(heatLevel(Number.NaN, 10)).toBe(0);
    expect(heatLevel(-3, 10)).toBe(0);
  });

  it('clamps a count above the peak rather than going off the scale', () => {
    expect(heatLevel(999, 10)).toBe(4);
  });
});

describe('heatRows', () => {
  const day = (i: number, weekday: number, count = 0) => ({
    dateKey: `2026-09-${String(i).padStart(2, '0')}`,
    count,
    weekday,
  });

  it('pads the first row so day one lands in its own weekday column', () => {
    const rows = heatRows([day(1, 3), day(2, 4), day(3, 5)]);
    expect(rows).toHaveLength(1);
    expect(rows[0].slice(0, 3)).toEqual([null, null, null]);
    expect(rows[0][3]?.dateKey).toBe('2026-09-01');
  });

  it('always returns full rows of seven', () => {
    for (let weekday = 0; weekday < 7; weekday += 1) {
      const days = Array.from({ length: 30 }, (_, i) => day(i + 1, (weekday + i) % 7));
      const rows = heatRows(days);
      for (const row of rows) expect(row).toHaveLength(7);
      // Every real day survives the padding, exactly once.
      const real = rows.flat().filter(Boolean);
      expect(real).toHaveLength(30);
    }
  });

  it('needs SIX rows for exactly one start weekday, and five for the rest', () => {
    // ceil((weekday + 30) / 7): only a SUNDAY start (index 6) pushes to six.
    // Worth pinning precisely rather than as a range, because the height
    // budget is sized against the six-row case and the temptation on seeing
    // five everywhere is to reclaim the row. One start weekday in seven is
    // about four days a month where that reclaim would clip the card.
    const from = (weekday: number) =>
      heatRows(Array.from({ length: 30 }, (_, i) => day(i + 1, (weekday + i) % 7))).length;
    for (const wd of [0, 1, 2, 3, 4, 5]) expect(from(wd)).toBe(5);
    expect(from(6)).toBe(6);
  });

  it('is empty rather than one blank row for no days', () => {
    expect(heatRows([])).toEqual([]);
  });
});

describe('HeatGrid', () => {
  const days = Array.from({ length: 30 }, (_, i) => ({
    dateKey: `2026-09-${String(i + 1).padStart(2, '0')}`,
    count: i % 4,
    weekday: i % 7,
  }));
  const WD = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];

  it('draws a cell per day, addressable by date', () => {
    const { getByTestId } = render(
      <HeatGrid days={days} peak={3} k={1} weekdayInitials={WD} legendLess="less" legendMore="more" testID="heat" />,
    );
    expect(getByTestId('heat-day-2026-09-01')).toBeTruthy();
    expect(getByTestId('heat-day-2026-09-30')).toBeTruthy();
  });

  it('draws a pad cell as TRANSPARENT, not as an empty-tone day', () => {
    // A padded slot is a day OUTSIDE the window. Drawing it at the unread tone
    // would add days the card is not claiming to cover.
    const late = days.map((d, i) => ({ ...d, weekday: (i + 5) % 7 }));
    const { getByTestId } = render(
      <HeatGrid days={late} peak={3} k={1} weekdayInitials={WD} legendLess="less" legendMore="more" testID="heat" />,
    );
    const first = getByTestId('heat-day-2026-09-01').props.style;
    expect(first.backgroundColor).not.toBe('transparent');
  });

  it('gives every cell the same fixed box whatever its value', () => {
    const { getByTestId } = render(
      <HeatGrid days={days} peak={3} k={2} weekdayInitials={WD} legendLess="less" legendMore="more" testID="heat" />,
    );
    const zero = getByTestId('heat-day-2026-09-01').props.style;
    const busy = getByTestId('heat-day-2026-09-04').props.style;
    expect(zero.width).toBe(CHART_METRICS.heatCell * 2);
    expect(busy.width).toBe(zero.width);
    expect(busy.height).toBe(zero.height);
  });

  it('renders nothing rather than an empty grid', () => {
    const { toJSON } = render(
      <HeatGrid days={[]} peak={0} k={1} weekdayInitials={WD} legendLess="less" legendMore="more" testID="heat" />,
    );
    expect(toJSON()).toBeNull();
  });

  it('draws every cell at the empty tone when nothing was read', () => {
    const none = days.map((d) => ({ ...d, count: 0 }));
    const { getByTestId } = render(
      <HeatGrid days={none} peak={0} k={1} weekdayInitials={WD} legendLess="less" legendMore="more" testID="heat" />,
    );
    expect(getByTestId('heat-day-2026-09-01').props.style.backgroundColor).toBe(heatTone(0));
  });
});
