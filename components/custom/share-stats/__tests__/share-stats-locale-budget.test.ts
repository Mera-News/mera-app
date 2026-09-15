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
jest.mock('@/components/custom/MeraLogo', () => ({ __esModule: true, default: () => null }));

import {
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
const OUTER_PADDING = 28;
const PANEL_PADDING = 14;
const TILE_GAP = 12;

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
  { key: 'publicationsLabel', fontSize: 11, column: TILE_INNER, maxLines: 3 },
  { key: 'countriesLabel', fontSize: 11, column: TILE_INNER, maxLines: 3 },
  // Full panel width.
  { key: 'latencyLabel', fontSize: 11, column: PANEL_INNER, maxLines: 2 },
  { key: 'latencyUnknown', fontSize: 15, column: PANEL_INNER, maxLines: 3 },
  {
    key: 'latencyCoverage',
    fontSize: 9.5,
    column: PANEL_INNER,
    maxLines: 3,
    // Two-digit values are the realistic case and the widest common one.
    vars: { sampled: 41, total: 58 },
  },
  { key: 'openedPartial', fontSize: 9.5, column: PANEL_INNER, maxLines: 3 },
  { key: 'openedLabel', fontSize: 11, column: PANEL_INNER, maxLines: 2 },
  // Footer, which has no panel padding.
  { key: 'privacyLine', fontSize: 9.5, column: CARD_INNER, maxLines: 2 },
  { key: 'title', fontSize: 13, column: CARD_INNER, maxLines: 2 },
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
