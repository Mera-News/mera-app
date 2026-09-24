// The narration shows INLINE on the Feed, between its Mera mark and the "?",
// about 170pt on a 375pt phone, and is written to fit that on one line.
// Budgeted by MEASURED width per locale, not by character count: `fixtures/narration-widths.json` is every line in
// every dictionary shaped by CoreText in the system font at 14pt (see the
// generator beside it). A character budget over-refused (it wanted 23 lines
// retranslated) where the measurement shows every line fits.
import fs from 'fs';
import path from 'path';
import {
  HEADER_NARRATION_METRICS,
  NARRATION_COLOR,
  NARRATION_INLINE_WIDTH_PT,
} from '../header-narration';
import { contrastRatio, parseRgb } from '../status-ink';

type Row = { key: string; index: number; text: string; width: number };
const fixture = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, 'fixtures/narration-widths.json'), 'utf8'),
) as Record<string, Row[] | number>;
const LOCALES_DIR = path.resolve(__dirname, '../../../../lib/locales');
const LOCALES = fs.readdirSync(LOCALES_DIR).filter((f) => /^[a-zA-Z-]+\.json$/.test(f));

/** Rendering on device can differ from the Mac by a point or two across a line. */
const MARGIN_PT = 4;

function dictionaryLines(file: string): Row[] {
  const h = JSON.parse(fs.readFileSync(path.join(LOCALES_DIR, file), 'utf8')).headerNarration;
  const rows: Row[] = [];
  for (const [k, v] of Object.entries(h.stages as Record<string, string[]>)) {
    v.forEach((text, index) => rows.push({ key: `stages.${k}`, index, text, width: 0 }));
  }
  (h.nudges as string[]).forEach((text, index) => rows.push({ key: 'nudges', index, text, width: 0 }));
  return rows;
}

describe('the narration fits the Feed\'s ~170pt inline slot in every locale', () => {
  it('was measured at the size the row draws', () => {
    expect(fixture._fontSize).toBe(HEADER_NARRATION_METRICS.fontSize);
    expect(LOCALES).toHaveLength(20);
  });

  it('carries every current dictionary line verbatim, so it cannot go stale', () => {
    const stale: string[] = [];
    for (const file of LOCALES) {
      const locale = file.replace(/\.json$/, '');
      const measured = new Map(
        ((fixture[locale] as Row[]) ?? []).map((r) => [`${r.key}[${r.index}]`, r.text]),
      );
      for (const r of dictionaryLines(file)) {
        if (measured.get(`${r.key}[${r.index}]`) !== r.text) stale.push(`${locale} ${r.key}[${r.index}]`);
      }
    }
    if (stale.length > 0) {
      throw new Error(
        `narration-widths.json is stale for ${stale.length} line(s), re-run `
        + `fixtures/measure-narration.swift: ${stale.slice(0, 5).join(', ')}`,
      );
    }
  });

  it('fits every line within the row, with margin', () => {
    const over: string[] = [];
    for (const [locale, rows] of Object.entries(fixture)) {
      if (!Array.isArray(rows)) continue;
      for (const r of rows) {
        if (r.width > NARRATION_INLINE_WIDTH_PT - MARGIN_PT) {
          over.push(`${locale} ${r.key}[${r.index}] ${r.width}pt: ${r.text}`);
        }
      }
    }
    expect(over).toEqual([]);
  });

  it('THE CONTROL: the check fires on a narrower row', () => {
    const widest = Math.max(
      ...Object.values(fixture).flatMap((rows) => (Array.isArray(rows) ? rows.map((r) => r.width) : [])),
    );
    expect(widest).toBeGreaterThan(100);
    expect(widest).toBeLessThanOrEqual(NARRATION_INLINE_WIDTH_PT - MARGIN_PT);
  });
});

describe('the line is legible on the header', () => {
  // Sampled from a device capture of the header over a warm backdrop.
  const HEADER_SAMPLE: [number, number, number] = [105, 88, 80];

  it('clears 4.5:1 at rest', () => {
    expect(contrastRatio(parseRgb(NARRATION_COLOR), HEADER_SAMPLE)).toBeGreaterThanOrEqual(4.5);
  });

  it('THE CONTROL: the old rgb 190 did not', () => {
    expect(contrastRatio([190, 190, 190], HEADER_SAMPLE)).toBeLessThan(4.5);
  });
});
