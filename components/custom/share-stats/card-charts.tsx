// card-charts — the four chart primitives the stats cards and the Analytics
// tab draw with.
//
// Pure and presentational. Each takes numbers, a scale and nothing else: no
// i18n, no data access, no store. Every string a reader sees is passed IN, so
// these can be built and tested before the copy fragment is spliced, and a
// locale change can never move a chart.
//
// ## Why these forms
//
// Each has to be parsed in about a second, from a screenshot, with no legend.
//
//   FlagGrid       a set. The flags ARE the chart.
//   ProportionBar  a part-to-whole. The ONLY one here, and it is used once, on
//                  the reach card, where shares of total taps genuinely sum to
//                  one. Nothing else on any card is a part of a whole, which is
//                  why there is no donut anywhere in this file.
//   DotArray       a count you can verify by eye at small N and read as mass at
//                  large N.
//   RuledScale     a single value's position on a range, which is what a
//                  latency average is.
//
// ## Why Views and not SVG
//
// react-native-svg is in the binary and rasterises correctly in a captureRef
// PNG (MeraLogo is the proof). It is still the wrong tool here: every shape
// below is a rectangle or a circle, RNSVG rasterises on the CPU, and a View
// with a borderRadius is both cheaper and one less thing that has to be true
// for the card to come out. SVG earns its place when a shape cannot be
// expressed as a box. None of these are.
//
// ## The one thing here that is NOT a free choice
//
// `FlagGrid`'s overflow rule. The chip appears only when TWO OR MORE flags
// overflow; a single overflow renders its own flag instead. That is not a
// nicety, it is what lets `shareStats.card.flagsMore` interpolate {{n}} instead
// of {{count}} and stay out of i18next plural resolution in all 20
// dictionaries, including the six CLDR categories Arabic needs. Change the rule
// and the copy needs a plural fan-out in every locale. `card-charts.test.tsx`
// pins the invariant for exactly that reason.

import { SourceFlag } from '@/components/custom/SourceFlag';
import { HStack } from '@/components/ui/hstack';
import { Text } from '@/components/ui/text';
import { inkColor } from '@/components/custom/share-stats/card-theme';
import React from 'react';
import { View, type TextStyle } from 'react-native';

/**
 * Every size these draw with, in design points on the 360-wide grid, so the
 * locale budget can model the height of a chart without holding its own copy of
 * the numbers. A test with its own copy of the sizes keeps passing after a
 * layout change, which is the whole failure this object exists to prevent.
 */
export const CHART_METRICS = {
  /** FlagGrid: a cell is a FIXED box, and that is deliberate. Whether it ends
   *  up holding a flag emoji or the globe fallback, the grid's geometry is
   *  identical, so a platform that cannot draw regional-indicator pairs
   *  degrades in appearance and never in layout. */
  flagCell: 24,
  flagGlyph: 19,
  flagGap: 7,
  flagRowGap: 7,
  flagsPerRow: 8,
  /** The chip counts as one cell, so a full grid is always this many cells. */
  flagMaxCells: 24,
  /** The reach card draws ONE row (a merged card has no room for three); the
   *  overflow chip carries the rest. */
  flagOneRowCells: 8,

  barHeight: 9,
  barRadius: 4.5,
  barLegendSize: 9.5,
  barLegendGap: 6,
  barLegendTop: 7,

  dotSize: 9,
  dotGap: 5,
  dotRowGap: 5,
  dotsPerRow: 20,
  dotMax: 60,

  /** HeatGrid. 16pt cells since the habits card merged days, opened and pace
   *  onto one card; the history below explains the six-row worst case, which
   *  still holds. Every TEXT size here is at least 9.5pt, which is 28.5px at
   *  the 1080px export (the floor is ~28px).
   *
   *  Earlier sizing note: 7 columns is fixed (one per weekday); the CELL was 28, not the
   *  34 the mockup was sized at, because the mockup assumed five rows and the
   *  worst case is SIX: the first row is padded so day one lands in its own
   *  weekday column, so a 30-day window starting late in the week needs an
   *  extra row. At 34 the six-row card stacked to about 481pt in a 463pt band.
   *  28 with a 5pt gap is 226pt wide and 193pt tall at six rows, which fits
   *  with the margin intact, and is still far above the legibility floor at
   *  capture scale and on a floor device. */
  heatCell: 16,
  heatGap: 3,
  heatColumns: 7,
  heatLabelSize: 9.5,
  heatLabelGap: 5,
  heatLegendSize: 9.5,
  heatLegendTop: 8,
  heatLegendSwatch: 9,

  scaleRule: 2,
  scaleTickHeight: 8,
  scaleMarker: 11,
  scaleLabelSize: 9.5,
  scaleLabelTop: 6,
} as const;

/** Always emits lineHeight beside fontSize. Same rule as the card's `type()`:
 *  components/ui/text merges caller style after its own size token, so a bare
 *  fontSize wins while the token's smaller lineHeight survives and React Native
 *  clips the glyph to it. */
function chartType(size: number, k: number, leading = 1.4): TextStyle {
  const fontSize = size * k;
  return { fontSize, lineHeight: Math.ceil(fontSize * leading) };
}

// --- FlagGrid --------------------------------------------------------------

export interface FlagGridProps {
  /** Country codes, already ordered by the caller. */
  countryCodes: string[];
  k: number;
  /** Rendered in the overflow chip, already interpolated by the caller. Passing
   *  the finished string keeps i18n out of this file. */
  overflowLabel: (remaining: number) => string;
  maxCells?: number;
  testID?: string;
}

/**
 * How the grid splits a list into shown flags and an overflow remainder.
 *
 * Exported and pure so the invariant can be tested without rendering: the
 * remainder is NEVER 1. Proof rather than assertion: the branch is only taken
 * when `codes.length > maxCells`, so `codes.length >= maxCells + 1`, and the
 * remainder is `codes.length - (maxCells - 1) >= 2`.
 */
export function splitFlagGrid(
  countryCodes: string[],
  maxCells: number = CHART_METRICS.flagMaxCells,
): { shown: string[]; remaining: number } {
  const cells = Math.max(1, Math.floor(maxCells));
  if (countryCodes.length <= cells) return { shown: countryCodes, remaining: 0 };
  return {
    shown: countryCodes.slice(0, cells - 1),
    remaining: countryCodes.length - (cells - 1),
  };
}

export const FlagGrid: React.FC<FlagGridProps> = ({
  countryCodes,
  k,
  overflowLabel,
  maxCells,
  testID,
}) => {
  const { shown, remaining } = splitFlagGrid(countryCodes, maxCells ?? CHART_METRICS.flagMaxCells);
  const cell = CHART_METRICS.flagCell * k;

  return (
    <View
      testID={testID}
      style={{
        flexDirection: 'row',
        flexWrap: 'wrap',
        columnGap: CHART_METRICS.flagGap * k,
        rowGap: CHART_METRICS.flagRowGap * k,
      }}
    >
      {shown.map((code) => (
        <View
          key={code}
          testID={testID ? `${testID}-cell-${code}` : undefined}
          style={{ width: cell, height: cell, alignItems: 'center', justifyContent: 'center' }}
        >
          {/* SourceFlag falls back to an SVG globe for a code it does not know,
              which is the branch that is PROVEN to rasterise. The fixed cell
              around it means either outcome occupies the same box.

              `iconClassName` is overridden because SourceFlag's default is
              `text-typography-500`, a palette token: mid-ramp and legible, but
              off-system on a card whose every other colour is white at a stated
              opacity. The wrapper carries an explicit colour too, since a flag
              emoji supplies its own but the globe and any tofu fallback do not. */}
          <Text
            allowFontScaling={false}
            style={[chartType(CHART_METRICS.flagGlyph, k, 1.15), { color: inkColor('primary') }]}
          >
            <SourceFlag countryCode={code} size="lg" iconClassName="text-white" />
          </Text>
        </View>
      ))}
      {remaining > 0 ? (
        <View
          testID={testID ? `${testID}-overflow` : undefined}
          style={{ height: cell, justifyContent: 'center' }}
        >
          <Text
            allowFontScaling={false}
            style={[
              chartType(CHART_METRICS.barLegendSize, k),
              { color: inkColor('muted') },
            ]}
          >
            {overflowLabel(remaining)}
          </Text>
        </View>
      ) : null}
    </View>
  );
};

// --- ProportionBar ---------------------------------------------------------

export interface ProportionSegment {
  /** Stable key. The remainder band passes its own sentinel. */
  id: string;
  share: number;
  label: string;
  /** True for exactly one segment, the leading one. */
  accent?: boolean;
}

export interface ProportionBarProps {
  segments: ProportionSegment[];
  k: number;
  testID?: string;
}

/**
 * A single stacked bar plus its inline legend.
 *
 * Widths are `flex: share` rather than a percentage string: the shares come
 * from `countryBands` as exact fractions summing to 1, and letting flex divide
 * the row means no rounding residue can open a gap at the right edge that the
 * legend does not explain.
 */
export const ProportionBar: React.FC<ProportionBarProps> = ({ segments, k, testID }) => {
  if (segments.length === 0) return null;

  // Stepped white for the non-accent bands, so the order is readable without a
  // legend lookup. One accent per card is the house rule.
  const tone = (index: number, accent?: boolean): string => {
    if (accent) return inkColor('accent');
    const steps = ['rgba(255, 255, 255, 0.55)', 'rgba(255, 255, 255, 0.34)', 'rgba(255, 255, 255, 0.18)'];
    return steps[Math.min(index - 1, steps.length - 1)] ?? steps[steps.length - 1];
  };

  return (
    <View testID={testID}>
      <View
        style={{
          flexDirection: 'row',
          height: CHART_METRICS.barHeight * k,
          borderRadius: CHART_METRICS.barRadius * k,
          overflow: 'hidden',
        }}
      >
        {segments.map((segment, index) => (
          <View
            key={segment.id}
            testID={testID ? `${testID}-segment-${segment.id}` : undefined}
            style={{ flex: Math.max(segment.share, 0), backgroundColor: tone(index, segment.accent) }}
          />
        ))}
      </View>
      <HStack
        style={{
          columnGap: CHART_METRICS.barLegendGap * k,
          marginTop: CHART_METRICS.barLegendTop * k,
          flexWrap: 'wrap',
        }}
      >
        {segments.map((segment, index) => (
          <HStack key={segment.id} className="items-center" style={{ columnGap: 3 * k }}>
            <View
              style={{
                width: CHART_METRICS.barLegendSize * k * 0.6,
                height: CHART_METRICS.barLegendSize * k * 0.6,
                borderRadius: CHART_METRICS.barLegendSize * k * 0.3,
                backgroundColor: tone(index, segment.accent),
              }}
            />
            <Text
              allowFontScaling={false}
              style={[chartType(CHART_METRICS.barLegendSize, k), { color: inkColor('secondary') }]}
            >
              {segment.label}
            </Text>
          </HStack>
        ))}
      </HStack>
    </View>
  );
};

// --- DotArray --------------------------------------------------------------

export interface DotArrayProps {
  count: number;
  k: number;
  /** Filled for a solid dot, ring for an outline. Two shapes rather than two
   *  colours, so the distinction survives a greyscale screenshot. */
  shape?: 'filled' | 'ring';
  accent?: boolean;
  maxDots?: number;
  testID?: string;
}

/** How many dots actually get drawn, and whether the array is truncated. */
export function dotsFor(
  count: number,
  maxDots: number = CHART_METRICS.dotMax,
): { drawn: number; truncated: boolean } {
  const n = Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
  return { drawn: Math.min(n, maxDots), truncated: n > maxDots };
}

export const DotArray: React.FC<DotArrayProps> = ({
  count,
  k,
  shape = 'filled',
  accent = false,
  maxDots,
  testID,
}) => {
  const { drawn } = dotsFor(count, maxDots ?? CHART_METRICS.dotMax);
  const size = CHART_METRICS.dotSize * k;
  const colour = accent ? inkColor('accent') : inkColor('primary');

  return (
    <View
      testID={testID}
      style={{
        flexDirection: 'row',
        flexWrap: 'wrap',
        columnGap: CHART_METRICS.dotGap * k,
        rowGap: CHART_METRICS.dotRowGap * k,
        // A wrapped row with no main-axis floor and centred content clips its
        // ENDS symmetrically and looks correct. Left-aligned, so an overflow is
        // visible rather than silently eating dots off both sides.
        justifyContent: 'flex-start',
      }}
    >
      {Array.from({ length: drawn }, (_, i) => (
        <View
          key={i}
          style={{
            width: size,
            height: size,
            borderRadius: size / 2,
            ...(shape === 'filled'
              ? { backgroundColor: colour }
              : { borderWidth: Math.max(1, 1.4 * k), borderColor: colour }),
          }}
        />
      ))}
    </View>
  );
};

// --- RuledScale ------------------------------------------------------------

export interface RuledScaleProps {
  /** Where the marker sits, in the same unit as min and max. */
  value: number;
  min: number;
  max: number;
  k: number;
  startLabel: string;
  endLabel: string;
  testID?: string;
}

/** The marker's position as a fraction of the rule, clamped into it. A value
 *  past `max` pins to the end rather than running off the card. */
export function scalePosition(value: number, min: number, max: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(min) || !Number.isFinite(max)) return 0;
  if (max <= min) return 0;
  return Math.min(1, Math.max(0, (value - min) / (max - min)));
}

export const RuledScale: React.FC<RuledScaleProps> = ({
  value,
  min,
  max,
  k,
  startLabel,
  endLabel,
  testID,
}) => {
  const fraction = scalePosition(value, min, max);
  const marker = CHART_METRICS.scaleMarker * k;

  return (
    <View testID={testID}>
      <View style={{ height: marker, justifyContent: 'center' }}>
        <View
          style={{
            height: CHART_METRICS.scaleRule * k,
            borderRadius: CHART_METRICS.scaleRule * k,
            backgroundColor: 'rgba(255, 255, 255, 0.24)',
          }}
        />
        {/* Positioned as a percentage of the row and pulled back by half its
            own width, so the marker's CENTRE lands on the value at any width
            and both ends stay inside the rule. */}
        <View
          testID={testID ? `${testID}-marker` : undefined}
          style={{
            position: 'absolute',
            left: `${fraction * 100}%`,
            marginLeft: -marker / 2,
            width: marker,
            height: marker,
            borderRadius: marker / 2,
            backgroundColor: inkColor('accent'),
          }}
        />
      </View>
      <HStack
        className="justify-between"
        style={{ marginTop: CHART_METRICS.scaleLabelTop * k }}
      >
        <Text
          allowFontScaling={false}
          style={[chartType(CHART_METRICS.scaleLabelSize, k), { color: inkColor('muted') }]}
        >
          {startLabel}
        </Text>
        <Text
          allowFontScaling={false}
          style={[chartType(CHART_METRICS.scaleLabelSize, k), { color: inkColor('muted') }]}
        >
          {endLabel}
        </Text>
      </HStack>
    </View>
  );
};



// --- HeatGrid --------------------------------------------------------------

export interface HeatDay {
  dateKey: string;
  count: number;
  /** 0 = Monday .. 6 = Sunday. */
  weekday: number;
}

export interface HeatGridProps {
  days: HeatDay[];
  /** The busiest day in the window, which the shading is normalised against.
   *  Zero means every cell draws at the empty tone. */
  peak: number;
  k: number;
  /** Seven single-character weekday initials, Monday first, already localised
   *  by the caller. Passing finished strings keeps i18n out of this file. */
  weekdayInitials: string[];
  legendLess: string;
  legendMore: string;
  testID?: string;
}

/**
 * Which of five tones a day's count falls in.
 *
 * Five steps, not a continuous ramp: a contribution grid is read by COMPARING
 * cells, and the eye cannot rank a continuous alpha at these sizes. Step 0 is
 * reserved for a genuine zero so an unread day is always visibly different from
 * the quietest read day, however low the peak is. That matters most for a light
 * reader, where a linear ramp would put one-article days at an alpha
 * indistinguishable from nothing.
 */
export function heatLevel(count: number, peak: number): 0 | 1 | 2 | 3 | 4 {
  if (!Number.isFinite(count) || count <= 0) return 0;
  if (!Number.isFinite(peak) || peak <= 0) return 1;
  const ratio = Math.min(1, count / peak);
  if (ratio <= 0.25) return 1;
  if (ratio <= 0.5) return 2;
  if (ratio <= 0.75) return 3;
  return 4;
}

/** The tone for each level. Level 0 is an outlined empty cell rather than a
 *  filled one, so "no reading" reads as absence and not as a dark value. */
export function heatTone(level: 0 | 1 | 2 | 3 | 4): string {
  return [
    'rgba(255, 255, 255, 0.07)',
    'rgba(231, 138, 83, 0.30)',
    'rgba(231, 138, 83, 0.52)',
    'rgba(231, 138, 83, 0.76)',
    'rgb(231, 138, 83)',
  ][level];
}

/**
 * Lays days out into 7-column rows with the first row PADDED so day one sits in
 * its own weekday column. Returns rows of `HeatDay | null`, null being a pad
 * cell that draws nothing.
 */
export function heatRows(days: HeatDay[]): (HeatDay | null)[][] {
  if (days.length === 0) return [];
  const cells: (HeatDay | null)[] = [
    ...Array.from({ length: days[0].weekday }, () => null),
    ...days,
  ];
  while (cells.length % 7 !== 0) cells.push(null);
  const rows: (HeatDay | null)[][] = [];
  for (let i = 0; i < cells.length; i += 7) rows.push(cells.slice(i, i + 7));
  return rows;
}

export const HeatGrid: React.FC<HeatGridProps> = ({
  days,
  peak,
  k,
  weekdayInitials,
  legendLess,
  legendMore,
  testID,
}) => {
  const rows = heatRows(days);
  if (rows.length === 0) return null;

  const cell = CHART_METRICS.heatCell * k;
  const gap = CHART_METRICS.heatGap * k;

  return (
    <View testID={testID}>
      <HStack style={{ columnGap: gap, marginBottom: CHART_METRICS.heatLabelGap * k }}>
        {weekdayInitials.slice(0, CHART_METRICS.heatColumns).map((initial, i) => (
          <View key={i} style={{ width: cell, alignItems: 'center' }}>
            <Text
              allowFontScaling={false}
              style={[
                chartType(CHART_METRICS.heatLabelSize, k),
                { color: inkColor('muted') },
              ]}
            >
              {initial}
            </Text>
          </View>
        ))}
      </HStack>

      <View style={{ rowGap: gap }}>
        {rows.map((row, r) => (
          <HStack key={r} style={{ columnGap: gap }}>
            {row.map((day, c) => (
              <View
                key={day?.dateKey ?? `pad-${r}-${c}`}
                testID={day ? `${testID}-day-${day.dateKey}` : undefined}
                style={{
                  width: cell,
                  height: cell,
                  borderRadius: 4 * k,
                  // A pad cell draws NOTHING, not an empty-tone cell: a padded
                  // slot is a day outside the window, and showing it at the
                  // same tone as an unread day inside the window would add
                  // days the card is not claiming to cover.
                  backgroundColor: day ? heatTone(heatLevel(day.count, peak)) : 'transparent',
                }}
              />
            ))}
          </HStack>
        ))}
      </View>

      <HStack
        className="items-center"
        style={{ columnGap: 4 * k, marginTop: CHART_METRICS.heatLegendTop * k }}
      >
        <Text
          allowFontScaling={false}
          style={[chartType(CHART_METRICS.heatLegendSize, k), { color: inkColor('muted') }]}
        >
          {legendLess}
        </Text>
        {([0, 1, 2, 3, 4] as const).map((level) => (
          <View
            key={level}
            style={{
              width: CHART_METRICS.heatLegendSwatch * k,
              height: CHART_METRICS.heatLegendSwatch * k,
              borderRadius: 2 * k,
              backgroundColor: heatTone(level),
            }}
          />
        ))}
        <Text
          allowFontScaling={false}
          style={[chartType(CHART_METRICS.heatLegendSize, k), { color: inkColor('muted') }]}
        >
          {legendMore}
        </Text>
      </HStack>
    </View>
  );
};

export default { FlagGrid, ProportionBar, DotArray, RuledScale, HeatGrid };
