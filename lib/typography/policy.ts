/**
 * How far OS Dynamic Type is allowed to grow text, per kind of surface.
 *
 * THE BUG THIS FIXES
 * ------------------
 * React Native defaults `allowFontScaling` to **true** and there was not a
 * single `maxFontSizeMultiplier` in the codebase. The app was therefore already
 * scaling to iOS's largest accessibility sizes (~3.1x) completely unclamped,
 * inside containers with hard-coded heights — so at large system sizes text was
 * being clipped in production today. This is not new support; it is a cap on
 * support that was already switched on and unbounded.
 *
 * WHY NOT JUST ALLOW 3.1x EVERYWHERE
 * ----------------------------------
 * Because some containers genuinely cannot grow: a picker whose scroll maths is
 * derived from a row height, a marquee whose offsets are precomputed. Those get
 * `locked` and are honest about it, rather than silently slicing glyphs in half.
 * Everything that CAN grow gets `content`, and the layout was changed so it can.
 */
export const MAX_FONT_SCALE = {
  /**
   * Body copy, headlines, article text, settings rows — anything that lives in
   * a container free to grow taller. 2x covers iOS's largest NON-accessibility
   * size (xxxLarge ~1.35x) with room to spare, and most of the accessibility
   * range.
   */
  content: 2,
  /**
   * Chrome: tab labels, chips, badges, counters. These sit in rows sized by
   * their neighbours, so unbounded growth pushes siblings off-screen rather
   * than making anything more readable.
   */
  chrome: 1.4,
  /**
   * Text inside a box whose height is load-bearing — it feeds scroll offsets or
   * snap positions that are computed, not measured. Every use of this tier is a
   * known limitation and should carry a comment saying which measurement is
   * pinning it.
   */
  locked: 1.2,
} as const;

export type FontScaleTier = keyof typeof MAX_FONT_SCALE;

/**
 * The `maxFontSizeMultiplier` to hand React Native, given the user's own
 * in-app text-size choice.
 *
 * The in-app scale multiplies `fontSize` directly, so it is NOT subject to
 * `maxFontSizeMultiplier` — the two compose. Dividing the tier cap by the user
 * scale keeps the COMBINED growth at or below the tier cap, so picking a larger
 * in-app size can never reintroduce the clipping this cap exists to prevent.
 *
 * Never returns below 1: a value under 1 would make RN shrink text below its
 * own specified size, which is not what any caller means.
 */
export function maxFontSizeMultiplierFor(tier: FontScaleTier, userScale: number): number {
  const cap = MAX_FONT_SCALE[tier];
  if (!Number.isFinite(userScale) || userScale <= 0) return cap;
  return Math.max(1, cap / userScale);
}
