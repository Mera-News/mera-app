// Ink and surface for the feed-status panel and sheet, in ONE place.
//
// Colours live in `style`, never in a NativeWind class. The dark ramp here is an
// inversion (`typography-300` is rgb 115, darker than `-400`), and a component
// test asserting a class name cannot see the colour it resolves to. The labels
// on the old panel were `typography-400` (rgb 140) on a 7% white tint over
// scrolling content: 1.9:1 measured on a device screenshot.
//
// The panel sits in the absolute header, so cards scroll UNDER it. That makes
// it a surface over content, which takes `GLASS_OVER_CONTENT_FILL` as its base
// (see GlassSurface). `GlassPanel` IGNORES its `fallbackClassName`, so the base
// has to be passed as a style, not as that class.

import type { FeedStatusMode } from '@/lib/feed-status-mode';

/** Pure text colours. `secondary` is the floor: rgb 163 only reaches 4.6:1
 *  over the worst modelled panel and rgb 140 reaches 3.5:1. */
export const STATUS_INK = {
  primary: '#FFFFFF',
  secondary: 'rgb(212, 212, 212)',
  divider: 'rgba(255, 255, 255, 0.12)',
} as const;

/**
 * The panel's effective colour in its WORST case, for the contrast test: white
 * content under the 0.90 dark base, then the 7% white lift of
 * `TranslucentPlate`. Brighter content behind cannot make it lighter than this.
 */
export const STATUS_PANEL_WORST_BG: readonly [number, number, number] = [57, 56, 57];

function channel(v: number): number {
  const c = v / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** WCAG relative luminance of an sRGB triple. */
export function luminance([r, g, b]: readonly [number, number, number]): number {
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG contrast ratio between two sRGB triples. */
export function contrastRatio(
  a: readonly [number, number, number],
  b: readonly [number, number, number],
): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** Parses `#RRGGBB` or `rgb(r, g, b)`; throws on anything else so a test
 *  cannot pass by failing to read a colour. */
export function parseRgb(color: string): [number, number, number] {
  const hex = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(color);
  if (hex) return [parseInt(hex[1], 16), parseInt(hex[2], 16), parseInt(hex[3], 16)];
  const rgb = /^rgb\(\s*(\d+),\s*(\d+),\s*(\d+)\s*\)$/.exec(color);
  if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
  throw new Error(`unparseable colour: ${color}`);
}

/**
 * ONE scoring progress figure. The panel used to show the cloud sweep's
 * synced-id counter ("Cloud scoring 30 / 36") beside the batch article
 * progress ("Analysing 30 of 39 articles"): two totals for one job, side by
 * side. Both now read this, so they cannot disagree. The batch progress is
 * preferred: it counts ARTICLES in the current run, the unit the sentence
 * names.
 */
export function pickScoringProgress(
  batch: { done: number; total: number } | null | undefined,
  asyncDone: number,
  asyncTotal: number,
): { done: number; total: number } | null {
  if (batch && batch.total > 0) return { done: batch.done, total: batch.total };
  if (asyncTotal > 0) return { done: asyncDone, total: asyncTotal };
  return null;
}

/**
 * The state half of the accessibility label.
 *
 * Ink is the ONLY thing that separated these states, which made the capped
 * state (amber) and the error state (red) identical to a screen reader: the
 * label was a constant "Open feed status" in every mode. `deferred` folds onto
 * `idle` here for the same reason it shares the resting colour — it is a
 * pipeline count the reader cannot act on.
 *
 * Also the Dashboard stats card's visible status line at zero articles, and
 * its toggle's label: one table for both tabs.
 */
export function a11yStateKey(mode: FeedStatusMode): string {
  // Returns a plain string, read by its callers through `tAny`. All four keys exist in
  // all 20 dictionaries, so this is NOT a missing-key workaround: the key is
  // genuinely COMPUTED from `mode`, which is what `tAny` exists for in this
  // file family. Do not "fix" it to a typed `t()` — there is no literal here
  // to type.
  switch (mode) {
    case 'processing':
      return 'feedStatus.modeProcessing';
    case 'error':
      return 'feedStatus.modeError';
    case 'limited':
      return 'feedStatus.modeLimited';
    default:
      return 'feedStatus.idle';
  }
}
