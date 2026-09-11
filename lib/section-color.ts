/** Gradient parameters for a fact-row header background. Consumed by the
 *  section-header renderer to composite a left-to-right fade. */
export interface SectionGradientSpec {
  /** Opaque base color, e.g. 'hsl(212, 52%, 64%)'. */
  base: string;
  /**
   * The hue `base` was built from, 0-359.
   *
   * Exposed because a consumer that needs the colour AT AN OPACITY cannot get
   * there from `base`: CSS gradients have no `stopOpacity`, so the alpha has to
   * be part of the colour literal, and deriving `hsla(...)` by string surgery on
   * `hsl(...)` would couple that consumer to this function's formatting. The
   * hue is already computed here; handing it over costs nothing and keeps
   * saturation/lightness the single fixed pair documented below.
   */
  hue: number;
  /** The lightness `base` was built from. Exposed for the same reason as `hue`:
   *  a consumer building its own `hsla()` must not assume the dark value. */
  lightness: number;
  /** Left (solid) edge stop opacity. */
  startOpacity: number;
  /** Right edge stop opacity. */
  endOpacity: number;
}

export type SectionScheme = 'light' | 'dark';

/** The fixed saturation every section colour uses, both schemes. */
export const SECTION_SATURATION_PCT = 52;

/**
 * Dark lightness. Kept as the unsuffixed export so existing importers and the
 * existing test stay valid.
 */
export const SECTION_LIGHTNESS_PCT = 64;

/**
 * Per-scheme lightness and solid-edge opacity.
 *
 * The dark pair (64%, 0.30) is tuned for a near-black page. CARRIED OVER
 * NAIVELY TO PARCHMENT IT COLLAPSES: a 64% band at 0.30 over a near-white page
 * leaves yellow hues at 1.11:1 against the page, i.e. invisible.
 *
 * MEASURED over all 360 hues, compositing the band onto each page and scoring
 * band-vs-page:
 *   dark   64% @0.30 -> floor 1.451, white header text worst 8.91
 *   light  42% @0.45 -> floor 1.446, Shadow Grey header text worst 6.42
 * so light reproduces the dark visibility floor to three significant figures
 * while keeping header text well clear of AA.
 *
 * The band-visibility ORDERING flips between schemes: in dark the band is
 * lighter than the page, on Parchment it is darker. That is inherent to
 * luminance weighting, not a bug.
 */
export const SECTION_SCHEME: Readonly<
  Record<SectionScheme, { lightness: number; startOpacity: number }>
> = Object.freeze({
  dark: { lightness: 64, startOpacity: 0.3 },
  light: { lightness: 42, startOpacity: 0.45 },
});

/** FNV-1a 32-bit hash — deterministic across launches/screens (no runtime
 *  randomness, no Date/Math.random) so the same factId always maps to the
 *  same color everywhere it's rendered. */
export function hashString(input: string): number {
  let hash = 2166136261; // FNV offset basis
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619); // FNV prime
  }
  return hash >>> 0; // force unsigned 32-bit
}

/**
 * Derives a stable pastel gradient spec for a fact row's header, keyed by
 * factId. Dark-mode tuning rationale: the app is dark-mode only (near-black
 * ~#121113 background) with white header text. A moderate saturation (52%)
 * and high lightness (64%) reads as a soft pastel even before opacity is
 * applied, and once composited at the low `startOpacity` (0.30) used by the
 * gradient's solid edge, the result stays a gentle tint rather than a loud
 * accent. Fixing saturation/lightness and varying only hue guarantees every
 * possible hue (0-359) stays within the same safe brightness band, so text
 * contrast never depends on which factId happened to hash where — there's no
 * "unlucky" hue that comes out too dark or too neon.
 */
export function sectionGradient(
  factId: string,
  scheme: SectionScheme = 'dark',
): SectionGradientSpec {
  const hue = hashString(factId) % 360;
  const { lightness, startOpacity } = SECTION_SCHEME[scheme];
  return {
    base: `hsl(${hue}, ${SECTION_SATURATION_PCT}%, ${lightness}%)`,
    hue,
    lightness,
    startOpacity,
    endOpacity: 0,
  };
}

/** The same colour at an explicit alpha, as an `hsla()` literal. The form CSS
 *  gradient stops need — see `SectionGradientSpec.hue`. */
export function sectionColorAtAlpha(
  hue: number,
  alpha: number,
  scheme: SectionScheme = 'dark',
): string {
  return `hsla(${hue}, ${SECTION_SATURATION_PCT}%, ${SECTION_SCHEME[scheme].lightness}%, ${alpha})`;
}
