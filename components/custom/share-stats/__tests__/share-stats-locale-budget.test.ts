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
  CARD_METRICS,
  EXPORT_HEIGHT,
  EXPORT_WIDTH,
  SAFE_RESERVE_PX,
  TOP_INK_FLOOR_PX,
} from '../ShareStatsCard';

const LOCALES = [
  'ar', 'de', 'en', 'es', 'fr', 'hi', 'id', 'it', 'ja', 'ko',
  'nl', 'pl', 'pt-BR', 'ru', 'th', 'tr', 'uk', 'vi', 'zh-CN', 'zh-TW',
] as const;

/** The authoring grid the card's sizes are written on. */
const DESIGN_WIDTH = 360;
const DESIGN_HEIGHT = 640;

// Layout constants copied from the card's own render, in design points.
const OUTER_PADDING = CARD_METRICS.outerPadding;
const PANEL_PADDING = CARD_METRICS.panelPadding;
const TILE_GAP = CARD_METRICS.tileGap;

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
  { key: 'publicationsLabel', fontSize: CARD_METRICS.tileLabel, column: TILE_INNER, maxLines: 3 },
  { key: 'countriesLabel', fontSize: CARD_METRICS.tileLabel, column: TILE_INNER, maxLines: 3 },
  // Full panel width.
  { key: 'latencyLabel', fontSize: CARD_METRICS.panelLabel, column: PANEL_INNER, maxLines: 2 },
  { key: 'latencyUnknown', fontSize: CARD_METRICS.panelValueUnknown, column: PANEL_INNER, maxLines: 3 },
  {
    key: 'latencyCoverage',
    fontSize: CARD_METRICS.qualifier,
    column: PANEL_INNER,
    maxLines: 3,
    // Two-digit values are the realistic case and the widest common one.
    vars: { sampled: 41, total: 58 },
  },
  { key: 'openedPartial', fontSize: CARD_METRICS.qualifier, column: PANEL_INNER, maxLines: 3 },
  { key: 'openedLabel', fontSize: CARD_METRICS.panelLabel, column: PANEL_INNER, maxLines: 2 },
  // Footer, which has no panel padding.
  { key: 'privacyLine', fontSize: CARD_METRICS.qualifier, column: CARD_INNER, maxLines: 2 },
  { key: 'title', fontSize: CARD_METRICS.title, column: CARD_INNER, maxLines: 2 },
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

/** The card's stack height in design points, block by block, in render order. */
function cardHeight(dict: CardCopy, opts: { names: boolean; rows: number }): number {
  const m = CARD_METRICS;
  const c = dict.card;

  // Header: the logo row is the taller of the glyph and the wordmark's line box.
  const header =
    Math.max(m.logoSize, Math.ceil(m.wordmark * m.numeralLeading))
    + m.titleGap
    + textHeight(c.title, m.title, CARD_INNER);

  // Tiles sit side by side, so the row is the taller of the two.
  const tile = (label: string) =>
    2 * m.panelPadding
    + Math.ceil(m.tileNumeral * m.numeralLeading)
    + m.tileLabelGap
    + textHeight(label, m.tileLabel, TILE_INNER);
  const tiles = Math.max(tile(c.publicationsLabel), tile(c.countriesLabel));

  // Latency panel, in its populated state (the taller of the two branches, and
  // the one that carries the coverage denominator).
  const coverage = c.latencyCoverage.replace('{{sampled}}', '41').replace('{{total}}', '58');
  const latency =
    2 * m.panelPadding
    + Math.ceil(m.panelValue * m.numeralLeading)
    + m.panelLabelGap
    + textHeight(c.latencyLabel, m.panelLabel, PANEL_INNER)
    + m.qualifierGap
    + textHeight(coverage, m.qualifier, PANEL_INNER);

  const opened =
    2 * m.panelPadding
    + Math.ceil(m.panelValue * m.numeralLeading)
    + m.panelLabelGap
    + textHeight(c.openedLabel, m.panelLabel, PANEL_INNER)
    + m.qualifierGap
    + textHeight(c.openedPartial, m.qualifier, PANEL_INNER);

  // The opt-in block is ABSENT when off, not empty, so it contributes nothing.
  const topList = opts.names
    ? textHeight(c.topPublicationsTitle, m.topListTitle, CARD_INNER)
      + opts.rows * (m.topRowGap + Math.ceil(m.topRowText * m.textLeading))
    : 0;

  const footer =
    textHeight(c.privacyLine, m.qualifier, CARD_INNER)
    + m.footerGap
    + Math.ceil(m.footerDomain * m.textLeading);

  return header + tiles + latency + opened + topList + footer;
}

const BAND =
  DESIGN_HEIGHT
  - (TOP_INK_FLOOR_PX / EXPORT_HEIGHT) * DESIGN_HEIGHT
  - (SAFE_RESERVE_PX / EXPORT_HEIGHT) * DESIGN_HEIGHT;

describe('the whole card fits between the two Instagram reserves', () => {
  for (const locale of LOCALES) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const dict = require(`@/lib/locales/${locale}.json`).shareStats as CardCopy;

    it(`${locale} fits with the naming toggle OFF`, () => {
      const height = cardHeight(dict, { names: false, rows: 0 });
      if (height > BAND) {
        throw new Error(
          `${locale} names-OFF card is ${Math.round(height)}pt in a ${Math.round(BAND)}pt band, `
          + `over by ${Math.round(height - BAND)}pt.`,
        );
      }
      expect(height).toBeLessThanOrEqual(BAND);
    });

    it(`${locale} fits with the naming toggle ON and three publications`, () => {
      // THE case capture 5 broke on. Three rows is what the preview screen
      // requests, so it is the worst case the card can actually be asked to
      // draw, not a hypothetical.
      const height = cardHeight(dict, { names: true, rows: 3 });
      if (height > BAND) {
        throw new Error(
          `${locale} names-ON card with 3 publications is ${Math.round(height)}pt in a `
          + `${Math.round(BAND)}pt band, over by ${Math.round(height - BAND)}pt. The footer is `
          + `what gets clipped. Honest levers: a smaller qualifier type scale, tighter panel `
          + `padding, or fewer publications. NOT numberOfLines on a qualifier.`,
        );
      }
      expect(height).toBeLessThanOrEqual(BAND);
    });
  }
});
