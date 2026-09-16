// A counter-metric for card overflow across all 20 locales.
//
// The simulator CANNOT do this check: switching the app language there fails
// with "This device can't translate news articles", so German and Japanese were
// blocked on device. That leaves the longest and shortest strings in the set
// unverified, on a card whose height is FIXED and whose content does not shrink
// to fit (the band is `flex-1` with `space-between`, and React Native children
// have `flexShrink: 0`, so anything too tall renders straight into the reserved
// margins the Instagram chrome sits over).
//
// So this measures instead of looking. It is an ESTIMATE, not a renderer, and
// its assumptions are stated below so a failure is interpretable rather than
// mysterious. It exists to FAIL on German, which is the case that would
// otherwise reach a user before anyone noticed.
//
// The budgets derive from the card's own exported constants, so a layout change
// moves the test with it rather than leaving a stale number behind.

// Importing the card's constants pulls in the card, which pulls in MeraLogo,
// which pulls in reanimated. This file measures strings and renders nothing, so
// the logo is stubbed out purely to keep the module graph loadable under jest.
// AbstractGradientBackdrop drags in reanimated and react-native-svg, which have
// no native side under jest. It has its own suite; here it is a prop recorder,
// so the card's contract with it (seeded AND frame-pinned, or two shares of the
// same stats produce different PNGs) is still asserted below.
jest.mock('@/components/custom/AbstractGradientBackdrop', () => {
  const { View } = require('react-native');
  return {
    __esModule: true,
    default: () => null,
  };
});

jest.mock('@/components/custom/MeraLogo', () => ({ __esModule: true, default: () => null }));

import {
  EXPORT_HEIGHT,
  EXPORT_WIDTH,
  SAFE_RESERVE_PX,
  SHELL_METRICS,
  TOP_INK_FLOOR_PX,
} from '../ShareStatsCard';
import { KEEP_METRICS, PACE_METRICS, REACH_METRICS } from '../stats-cards';
import { CHART_METRICS } from '../card-charts';

// Shell sizes under their old name, so the string-width half of this file reads
// unchanged. The TOTAL-HEIGHT half below models each card separately, which is
// the part that has to know they are three different stacks.
const CARD_METRICS = SHELL_METRICS;

// Chart sizes, read from the charts' own exported object so the budget and the
// render can never disagree about what the card is made of.
const CHART_FLAG_CELL = CHART_METRICS.flagCell;
const CHART_FLAG_ROW_GAP = CHART_METRICS.flagRowGap;
const CHART_FLAGS_PER_ROW = CHART_METRICS.flagsPerRow;
const CHART_FLAG_MAX_CELLS = CHART_METRICS.flagMaxCells;
const CHART_BAR_HEIGHT = CHART_METRICS.barHeight;
const CHART_BAR_LEGEND_TOP = CHART_METRICS.barLegendTop;
const CHART_BAR_LEGEND_SIZE = CHART_METRICS.barLegendSize;
const CHART_DOT_SIZE = CHART_METRICS.dotSize;
const CHART_DOT_ROW_GAP = CHART_METRICS.dotRowGap;
const CHART_DOTS_PER_ROW = CHART_METRICS.dotsPerRow;
const CHART_DOT_MAX = CHART_METRICS.dotMax;
const CHART_SCALE_MARKER = CHART_METRICS.scaleMarker;
const CHART_SCALE_LABEL_TOP = CHART_METRICS.scaleLabelTop;
const CHART_SCALE_LABEL_SIZE = CHART_METRICS.scaleLabelSize;

const LOCALES = [
  'ar', 'de', 'en', 'es', 'fr', 'hi', 'id', 'it', 'ja', 'ko',
  'nl', 'pl', 'pt-BR', 'ru', 'th', 'tr', 'uk', 'vi', 'zh-CN', 'zh-TW',
] as const;

/** The authoring grid the card's sizes are written on. */
const DESIGN_WIDTH = 360;
const DESIGN_HEIGHT = 640;

// Layout constants copied from the card's own render, in design points.
const OUTER_PADDING = CARD_METRICS.outerPadding;
const PANEL_PADDING = REACH_METRICS.tilePadding;
const TILE_GAP = REACH_METRICS.tileGap;

const CARD_INNER = DESIGN_WIDTH - 2 * OUTER_PADDING;          // 304
const PANEL_INNER = CARD_INNER - 2 * PANEL_PADDING;           // 276
const TILE_INNER = (CARD_INNER - TILE_GAP) / 2 - 2 * PANEL_PADDING; // 118

/**
 * Average glyph advance as a fraction of font size.
 *
 * 0.52 em is a standard working figure for a proportional sans at text sizes.
 * CJK and Hangul are full-width, so they get 1.0 and Thai 0.55. This is the
 * part of the model to distrust first if a result looks wrong: it is a mean,
 * so a string of unusually wide letters can beat it. The budgets below are
 * therefore set with a line of slack rather than to the exact edge.
 */
function advanceRatio(ch: string): number {
  const code = ch.codePointAt(0) ?? 0;
  // CJK ideographs, kana, Hangul, and full-width forms.
  if (
    (code >= 0x1100 && code <= 0x11ff)
    || (code >= 0x2e80 && code <= 0xa4cf)
    || (code >= 0xac00 && code <= 0xd7a3)
    || (code >= 0xf900 && code <= 0xfaff)
    || (code >= 0xff00 && code <= 0xff60)
  ) return 1.0;
  if (code >= 0x0e00 && code <= 0x0e7f) return 0.55; // Thai
  return 0.52;
}

/** Estimated rendered width of a string, in points, at a given font size. */
function estimateWidth(text: string, fontSize: number): number {
  let em = 0;
  for (const ch of text) em += advanceRatio(ch);
  return em * fontSize;
}

/** Greedy word wrap, matching what RN does for space-separated scripts. CJK and
 *  Thai wrap per character, which this approximates by falling back to a hard
 *  character wrap whenever a single "word" is wider than the column. */
function lineCount(text: string, fontSize: number, columnWidth: number): number {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return 0;

  let lines = 1;
  let used = 0;
  const spaceWidth = estimateWidth(' ', fontSize);

  for (const word of words) {
    const w = estimateWidth(word, fontSize);
    if (w > columnWidth) {
      // Unbreakable run wider than the column: it wraps per character.
      if (used > 0) lines += 1;
      lines += Math.ceil(w / columnWidth) - 1;
      used = w % columnWidth;
      continue;
    }
    const needed = used === 0 ? w : used + spaceWidth + w;
    if (needed > columnWidth) {
      lines += 1;
      used = w;
    } else {
      used = needed;
    }
  }
  return lines;
}

/**
 * Every qualifier and label that sits in a width-constrained box, with the font
 * size the card renders it at and the column it renders into.
 *
 * `latencyValue` and the bare numerals are excluded on purpose: they are short
 * in every language and they are not the strings that overflow.
 */
const MEASURED: {
  key: string;
  fontSize: number;
  column: number;
  maxLines: number;
  vars?: Record<string, string | number>;
}[] = [
  // Half-width tiles, so the tightest column on the card by a distance.
  { key: 'publicationsLabel', fontSize: REACH_METRICS.numeralLabel, column: TILE_INNER, maxLines: 3 },
  { key: 'countriesLabel', fontSize: REACH_METRICS.numeralLabel, column: TILE_INNER, maxLines: 3 },
  // Full card width.
  { key: 'latencyLabel', fontSize: PACE_METRICS.numeralLabel, column: CARD_INNER, maxLines: 2 },
  { key: 'latencyUnknown', fontSize: CARD_METRICS.qualifier, column: CARD_INNER, maxLines: 3 },
  // The three card titles and the present-tense window line.
  { key: 'reachTitle', fontSize: CARD_METRICS.title, column: CARD_INNER, maxLines: 2 },
  { key: 'keepTitle', fontSize: CARD_METRICS.title, column: CARD_INNER, maxLines: 2 },
  { key: 'paceTitle', fontSize: CARD_METRICS.title, column: CARD_INNER, maxLines: 2 },
  { key: 'windowNow', fontSize: CARD_METRICS.windowLine, column: CARD_INNER, maxLines: 1 },
  { key: 'savedLabel', fontSize: KEEP_METRICS.numeralLabel, column: CARD_INNER, maxLines: 2 },
  { key: 'followedLabel', fontSize: KEEP_METRICS.numeralLabel, column: CARD_INNER, maxLines: 2 },
  { key: 'keepNote', fontSize: KEEP_METRICS.note, column: CARD_INNER, maxLines: 3 },
  { key: 'topCountriesTitle', fontSize: REACH_METRICS.listTitle, column: CARD_INNER, maxLines: 2 },
  { key: 'topPublicationsTitle', fontSize: REACH_METRICS.listTitle, column: CARD_INNER, maxLines: 2 },
  { key: 'paceScaleTitle', fontSize: PACE_METRICS.scaleTitle, column: CARD_INNER, maxLines: 2 },
  {
    key: 'latencyCoverage',
    fontSize: CARD_METRICS.qualifier,
    column: CARD_INNER,
    maxLines: 3,
    // Two-digit values are the realistic case and the widest common one.
    vars: { sampled: 41, total: 58 },
  },
  { key: 'openedPartial', fontSize: CARD_METRICS.qualifier, column: CARD_INNER, maxLines: 3 },
  { key: 'openedLabel', fontSize: PACE_METRICS.numeralLabel, column: CARD_INNER, maxLines: 2 },
  { key: 'privacyLine', fontSize: CARD_METRICS.qualifier, column: CARD_INNER, maxLines: 2 },
];

function interpolate(template: string, vars?: Record<string, string | number>): string {
  if (!vars) return template;
  return template.replace(/\{\{(\w+)\}\}/g, (_, name: string) =>
    String(vars[name] ?? `{{${name}}}`),
  );
}

describe('share card copy fits the fixed 9:16 card in all 20 locales', () => {
  it('has the band height the budgets were sized against', () => {
    // If this moves, the maxLines above want revisiting rather than bumping.
    const topInset = (TOP_INK_FLOOR_PX / EXPORT_HEIGHT) * DESIGN_HEIGHT;
    const bottomReserve = (SAFE_RESERVE_PX / EXPORT_HEIGHT) * DESIGN_HEIGHT;
    const band = DESIGN_HEIGHT - topInset - bottomReserve;

    expect(EXPORT_WIDTH / EXPORT_HEIGHT).toBeCloseTo(DESIGN_WIDTH / DESIGN_HEIGHT, 6);
    expect(Math.round(band)).toBe(463);
  });

  for (const locale of LOCALES) {
    describe(locale, () => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const dict = require(`@/lib/locales/${locale}.json`) as {
        shareStats: { card: Record<string, string> };
      };

      for (const spec of MEASURED) {
        it(`${spec.key} wraps to at most ${spec.maxLines} lines`, () => {
          const raw = dict.shareStats.card[spec.key];
          expect(typeof raw).toBe('string');

          const text = interpolate(raw, spec.vars);
          const lines = lineCount(text, spec.fontSize, spec.column);

          // Thrown rather than asserted so the message carries everything the
          // fix needs: which locale, which string, how far over, and how wide
          // the column was. A bare toBeLessThanOrEqual prints two numbers.
          if (lines > spec.maxLines) {
            throw new Error(
              `${locale}.shareStats.card.${spec.key} wraps to ${lines} lines in a `
              + `${Math.round(spec.column)}pt column at ${spec.fontSize}pt, budget is `
              + `${spec.maxLines}. Shorten the string or lower the type scale for this `
              + `line; do NOT add numberOfLines, the qualifiers are the truth-bearing `
              + `half of each figure. Text: "${text}"`,
            );
          }
          expect(lines).toBeLessThanOrEqual(spec.maxLines);
        });
      }
    });
  }
});

// ---------------------------------------------------------------------------
// TOTAL HEIGHT, which is what actually overflowed.
//
// Capture 5 shipped a card whose "mera.news" footer was clipped clean off the
// 1080x1920 PNG, with the privacy line pushed to 11.2% from the bottom, INSIDE
// the Instagram reserve. English. Names ON, three publications.
//
// The per-string budget above passed the whole time and could not have caught
// it: it measures how many LINES each string wraps to, never how tall the stack
// is once they are added up. That is the gap this half closes. Anything that
// measures the pieces has to measure the whole as well, or it is measuring the
// wrong thing convincingly.
//
// The band does not scroll and the content does not shrink: React Native
// children are `flexShrink: 0`, so anything over budget renders straight
// through the reserve and off the canvas.
// ---------------------------------------------------------------------------

/** Rendered height of one text run: `type()`'s own line-height rule, times the
 *  number of lines it wraps to. Mirrors `Math.ceil(fontSize * leading)`. */
function textHeight(
  text: string,
  fontSize: number,
  column: number,
  leading: number = CARD_METRICS.textLeading,
): number {
  return Math.ceil(fontSize * leading) * lineCount(text, fontSize, column);
}

interface CardCopy {
  card: Record<string, string>;
}

/** Height of the shell: brand row, title, window line, footer. Shared by all
 *  three, and the only part of the stack that is. */
function shellHeight(dict: CardCopy, title: string, windowLine: string): number {
  const m = CARD_METRICS;
  const c = dict.card;
  const header =
    Math.max(m.logoSize, Math.ceil(m.wordmark * m.numeralLeading))
    + m.titleGap
    + textHeight(title, m.title, CARD_INNER)
    + m.windowGap
    + textHeight(windowLine, m.windowLine, CARD_INNER);
  const footer =
    textHeight(c.privacyLine, m.qualifier, CARD_INNER)
    + m.footerGap
    + Math.ceil(m.footerDomain * m.textLeading);
  return header + footer;
}

/** One figure block: numeral line box plus its label. */
function figureHeight(
  label: string,
  numeral: number,
  labelSize: number,
  labelGap: number,
  column: number,
): number {
  return (
    Math.ceil(numeral * CARD_METRICS.numeralLeading)
    + labelGap
    + textHeight(label, labelSize, column)
  );
}

/**
 * WORST CASE per card, not the default one. The old single card overflowed in
 * exactly the state nobody modelled: the optional block ON with its full row
 * count. So every optional block below is ON and every list is at its cap.
 */
function reachHeight(dict: CardCopy, rows: number): number {
  const m = REACH_METRICS;
  const c = dict.card;
  const tile = (label: string) =>
    2 * m.tilePadding
    + figureHeight(label, m.numeral, m.numeralLabel, m.numeralLabelGap, TILE_INNER);
  // Side by side, so the row is the taller of the two.
  const tiles = Math.max(tile(c.countriesLabel), tile(c.publicationsLabel));

  // Three rows of flags is the realistic ceiling at 8 per row and a 24-cell cap.
  const flagRows = Math.ceil(CHART_FLAG_MAX_CELLS / CHART_FLAGS_PER_ROW);
  const flags = flagRows * CHART_FLAG_CELL + (flagRows - 1) * CHART_FLAG_ROW_GAP;

  const bar =
    textHeight(c.topCountriesTitle, m.listTitle, CARD_INNER)
    + m.listTitleGap
    + CHART_BAR_HEIGHT
    + CHART_BAR_LEGEND_TOP
    + Math.ceil(CHART_BAR_LEGEND_SIZE * CARD_METRICS.textLeading);

  // Names ON, full row count: the state that overflowed last time.
  const names =
    textHeight(c.topPublicationsTitle, m.listTitle, CARD_INNER)
    + m.listTitleGap
    + rows * (m.rowGap + Math.ceil(m.rowText * CARD_METRICS.textLeading));

  return (
    shellHeight(dict, c.reachTitle, dict.card.__windowLast30 ?? '')
    + tiles + flags + bar + names
    + 3 * m.blockGap
  );
}

function keepHeight(dict: CardCopy): number {
  const m = KEEP_METRICS;
  const c = dict.card;
  // Dot arrays at their cap: 60 saved over 20 per row is 3 rows, 60 followed
  // likewise. The worst case the UI can be ASKED to draw, not the common one.
  const dotRows = Math.ceil(CHART_DOT_MAX / CHART_DOTS_PER_ROW);
  const dots = dotRows * CHART_DOT_SIZE + (dotRows - 1) * CHART_DOT_ROW_GAP;

  const block = (label: string) =>
    figureHeight(label, m.numeral, m.numeralLabel, m.numeralLabelGap, CARD_INNER)
    + m.dotsGap
    + dots;

  return (
    shellHeight(dict, c.keepTitle, c.windowNow)
    + block(c.savedLabel)
    + block(c.followedLabel)
    + textHeight(c.keepNote, m.note, CARD_INNER)
    + 2 * m.blockGap
  );
}

function paceHeight(dict: CardCopy): number {
  const m = PACE_METRICS;
  const c = dict.card;
  const coverage = c.latencyCoverage.replace('{{sampled}}', '41').replace('{{total}}', '58');

  const opened =
    figureHeight(c.openedLabel, m.numeral, m.numeralLabel, m.numeralLabelGap, CARD_INNER)
    + CARD_METRICS.qualifierGap
    + textHeight(c.openedPartial, CARD_METRICS.qualifier, CARD_INNER);

  const scale =
    textHeight(c.paceScaleTitle, m.scaleTitle, CARD_INNER)
    + m.scaleTitleGap
    + Math.ceil(m.scaleValue * CARD_METRICS.numeralLeading)
    + m.scaleValueGap
    + CHART_SCALE_MARKER
    + CHART_SCALE_LABEL_TOP
    + Math.ceil(CHART_SCALE_LABEL_SIZE * CARD_METRICS.textLeading)
    + CHART_SCALE_LABEL_TOP
    + textHeight(coverage, CARD_METRICS.qualifier, CARD_INNER);

  return shellHeight(dict, c.paceTitle, dict.card.__windowLast30 ?? '') + opened + scale + m.blockGap;
}

const BAND =
  DESIGN_HEIGHT
  - (TOP_INK_FLOOR_PX / EXPORT_HEIGHT) * DESIGN_HEIGHT
  - (SAFE_RESERVE_PX / EXPORT_HEIGHT) * DESIGN_HEIGHT;

/** 8pt of margin rather than grazing the boundary. The reserve is a boundary,
 *  not a target: the last card to sit exactly on one grazed it by 1.4px. */
const MARGIN = 8;

describe('every card fits between the two Instagram reserves, in every locale', () => {
  it('has the band height the budgets were sized against', () => {
    expect(EXPORT_WIDTH / EXPORT_HEIGHT).toBeCloseTo(DESIGN_WIDTH / DESIGN_HEIGHT, 6);
    expect(Math.round(BAND)).toBe(463);
  });

  for (const locale of LOCALES) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const dict = require(`@/lib/locales/${locale}.json`) as {
      shareStats: { card: Record<string, string>; screenSubtitle: string };
    };
    // The 30-day window line lives one level up from `card`, since it is reused
    // from the screen rather than re-minted. Threaded in here so the card
    // models can treat it like any other card string.
    const copy: CardCopy = {
      card: { ...dict.shareStats.card, __windowLast30: dict.shareStats.screenSubtitle },
    };

    describe(locale, () => {
      it('reach fits with names ON and three publications', () => {
        const height = reachHeight(copy, 3);
        if (height > BAND - MARGIN) {
          throw new Error(
            `${locale} reach card stacks to ${Math.round(height)}pt in a ${Math.round(BAND)}pt `
            + `band (budget ${Math.round(BAND - MARGIN)}pt with margin). Names ON, 3 rows, full `
            + `flag grid. Shorten a string or lower a size in REACH_METRICS; do NOT add `
            + `numberOfLines to a qualifier, they are the truth-bearing half of each figure.`,
          );
        }
        expect(height).toBeLessThanOrEqual(BAND - MARGIN);
      });

      it('keep fits with both dot arrays at their cap', () => {
        const height = keepHeight(copy);
        if (height > BAND - MARGIN) {
          throw new Error(
            `${locale} keep card stacks to ${Math.round(height)}pt in a ${Math.round(BAND)}pt band `
            + `(budget ${Math.round(BAND - MARGIN)}pt). Both dot arrays at the 60 cap.`,
          );
        }
        expect(height).toBeLessThanOrEqual(BAND - MARGIN);
      });

      it('pace fits with the scale and the coverage denominator', () => {
        const height = paceHeight(copy);
        if (height > BAND - MARGIN) {
          throw new Error(
            `${locale} pace card stacks to ${Math.round(height)}pt in a ${Math.round(BAND)}pt band `
            + `(budget ${Math.round(BAND - MARGIN)}pt).`,
          );
        }
        expect(height).toBeLessThanOrEqual(BAND - MARGIN);
      });
    });
  }

  it('models the worst case, not the default one', () => {
    // Non-vacuity: the names-ON reach card must be measurably taller than the
    // names-OFF one, or the budget is not modelling the state that overflowed.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const de = require('@/lib/locales/de.json') as { shareStats: { card: Record<string, string>; screenSubtitle: string } };
    const copy: CardCopy = {
      card: { ...de.shareStats.card, __windowLast30: de.shareStats.screenSubtitle },
    };
    expect(reachHeight(copy, 3)).toBeGreaterThan(reachHeight(copy, 0));
    expect(reachHeight(copy, 3)).toBeGreaterThan(200);
  });
});
