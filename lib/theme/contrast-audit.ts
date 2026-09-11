// The light palette's contrast audit, executable rather than tabulated in prose.
//
// WHY FOUR BACKDROPS. An earlier draft of the light spec checked every text
// colour against Parchment alone. Parchment is not the only thing text sits on:
// a raised card is LIGHTER than the page (the iOS grouped-list idiom) and a
// recessed well is DARKER, so the same colour has three different ratios and
// the worst case is never the one you checked. Auditing against Parchment only
// shipped a legacy `gray-600` at 4.63:1 that is really 4.35:1 on a recessed
// surface, i.e. below AA on a surface the app actually renders.
//
// So every text-bearing value is scored against all four and judged on its
// WORST result. `gray-600` was darkened from the spec's 112 109 105 until the
// worst case cleared 4.5:1.
//
// The legacy-alias light values below are the audited numbers. They are NOT
// wired up yet: the `--color-legacy-*` variables and the Tailwind `gray`
// override land in P3. This module is where P3 reads them from, so the audit
// and the values can never disagree.

export type Rgb = readonly [number, number, number];

/** WCAG 2.x relative luminance, sRGB. */
export function relativeLuminance([r, g, b]: Rgb): number {
  const ch = (v: number) => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
}

/** WCAG 2.x contrast ratio. Order-independent. */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const hi = Math.max(la, lb);
  const lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * The four surfaces light-mode text actually lands on.
 *
 * `muted` is included because gluestack inputs and chips render on
 * `--color-background-muted`, which is neither the page nor a card.
 */
export const LIGHT_BACKDROPS: Readonly<Record<string, Rgb>> = Object.freeze({
  parchment: [244, 243, 238],
  raised: [250, 249, 247],
  recessed: [237, 236, 230],
  muted: [243, 244, 246],
});

/** Worst contrast a foreground achieves across every light backdrop. */
export function worstOnLightBackdrops(fg: Rgb): number {
  return Math.min(...Object.values(LIGHT_BACKDROPS).map((bg) => contrastRatio(fg, bg)));
}

export const AA_TEXT = 4.5;
/** WCAG 1.4.11: UI components and graphical objects. */
export const AA_NON_TEXT = 3;

export interface AuditedColor {
  readonly rgb: Rgb;
  /** What this colour is for. `text` entries must clear AA_TEXT on all four. */
  readonly role: 'text' | 'border' | 'surface' | 'fill';
  readonly note?: string;
}

/**
 * Legacy Tailwind alias names, light column. Dark keeps the exact current
 * Tailwind hexes, which is what makes the dark ramp provably unchanged.
 *
 * The surface roles INVERT, and that is correct: `bg-gray-900` is a card raised
 * above near-black, so its light counterpart must be lighter than Parchment;
 * `bg-gray-950` is recessed below the page, so it goes darker. A side effect is
 * that gray-800 ends up darker than gray-900, reversing the Tailwind numeric
 * intuition.
 */
export const LEGACY_ALIAS_LIGHT: Readonly<Record<string, AuditedColor>> = Object.freeze({
  white: { rgb: [30, 30, 36], role: 'text', note: 'primary foreground' },
  black: { rgb: [244, 243, 238], role: 'surface', note: 'page surface' },
  // gray-50 and gray-100 are NOT in the spec's table, but gray-100 has four live
  // sites. Omitting a stop from the alias override drops it from the scale and
  // the class is purged with no error, so both are defined here.
  'gray-50': { rgb: [30, 30, 36], role: 'text' },
  'gray-100': { rgb: [33, 33, 37], role: 'text' },
  'gray-200': { rgb: [39, 39, 43], role: 'text' },
  'gray-300': { rgb: [49, 48, 52], role: 'text' },
  'gray-400': { rgb: [79, 77, 78], role: 'text' },
  'gray-500': { rgb: [95, 93, 92], role: 'text' },
  'gray-600': {
    rgb: [107, 104, 100],
    role: 'text',
    note: 'darkened from the spec 112 109 105, which was 4.35:1 on the recessed surface',
  },
  'gray-700': { rgb: [186, 182, 171], role: 'border', note: 'decorative hairline, not forced to 3:1' },
  'gray-800': { rgb: [218, 216, 209], role: 'border', note: 'decorative hairline, not forced to 3:1' },
  'gray-900': { rgb: [250, 249, 247], role: 'surface', note: 'RAISED, lighter than the page' },
  'gray-950': { rgb: [237, 236, 230], role: 'surface', note: 'RECESSED, darker than the page' },
});

/**
 * Text-bearing light tokens that are NOT legacy aliases, audited on the same
 * four backdrops. `typography-300` and below are decorative and excluded by
 * design; `typography-400` is the first stop that clears AA.
 */
export const LIGHT_TEXT_TOKENS: Readonly<Record<string, Rgb>> = Object.freeze({
  'typography-400': [107, 104, 100],
  'typography-500': [93, 91, 88],
  'typography-600': [79, 77, 77],
  'typography-700': [65, 64, 65],
  'typography-800': [51, 50, 53],
  'typography-900': [37, 37, 42],
  'typography-950': [30, 30, 36],
  'primary-700': [151, 63, 32],
  'primary-800': [111, 26, 7],
  'error-700': [179, 51, 51],
});

/**
 * Pairings that FAIL on purpose, kept so a later change cannot quietly adopt
 * one believing it is fine. Each is why the neighbouring rule exists.
 */
export const KNOWN_FAILING_PAIRS: readonly {
  readonly fg: Rgb;
  readonly bg: Rgb;
  readonly why: string;
}[] = Object.freeze([
  {
    fg: [231, 138, 83],
    bg: [244, 243, 238],
    why: 'Almond as TEXT on Parchment is 2.32:1. Accent text is primary-700.',
  },
  {
    fg: [255, 255, 255],
    bg: [231, 138, 83],
    why: 'White label on an Almond fill is 2.57:1. The on-accent label is Shadow Grey.',
  },
  {
    fg: [239, 68, 68],
    bg: [244, 243, 238],
    why: 'error-500 as text is 3.39:1. Error text is error-700; 500 is fill-only.',
  },
]);

/**
 * The label dead band. A fill whose luminance falls inside admits NEITHER a
 * white nor a Shadow Grey label at AA, so anything in it must not bear text.
 * `primary-600` (L 0.207) sits here, which is why it is border/icon/focus only
 * and why the pressed state uses `primary-400` instead: the label colour then
 * stays the same across states.
 */
export const LABEL_DEAD_BAND = Object.freeze({ min: 0.183, max: 0.235 });

export function isInLabelDeadBand(fill: Rgb): boolean {
  const l = relativeLuminance(fill);
  return l > LABEL_DEAD_BAND.min && l < LABEL_DEAD_BAND.max;
}
