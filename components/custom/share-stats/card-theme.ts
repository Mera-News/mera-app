// card-theme — the ink the share cards are drawn with.
//
// ## Why this file exists
//
// The card shipped every one of its primary text nodes as
// `className="text-typography-0"` and rasterised them NEAR-BLACK on the dark
// gradient, so the headline figures were invisible while the small print was
// not. The cause is not the rasteriser and it is not the capture: the Gluestack
// dark palette is an INVERSION of the light one, so `typography-0` is the DARK
// end of the ramp and `typography-950` is the white end.
//
//   light  --color-typography-0    254 254 255   (white)
//   dark   --color-typography-0     23  23  23   (near-black)  <-- what it got
//   dark   --color-typography-950  254 254 255   (white)
//
// `app/_layout.tsx` mounts `<GluestackUIProvider mode="dark">`, so the card was
// always asking for the dark end. The on-screen preview was black too;
// `react-native-view-shot` snapshots the existing layer tree rather than
// re-rendering, so a capture cannot differ from the screen for a colour reason.
//
// What let it sit there for so long is the shape worth remembering: a component
// test asserting `className="text-typography-0"` passes no matter what that
// class resolves to, because a class string carries no colour. Same shape as a
// per-string size budget that cannot see a layout overflow. The guard that CAN
// fail is the static one in `share-stats-card.test.tsx`, which reads the source
// of every file in this directory and refuses the token outright.
//
// ## Why the colour is a style and not a class
//
// Every colour on these cards comes from `ink()` and lands in the `style` prop,
// beside the `fontSize`/`lineHeight` pair from `type()`. That is deliberate:
// a palette token can be inverted by a theme the card does not control, and the
// card is a fixed raster that has exactly one background it will ever be drawn
// on. A literal cannot be inverted by anything.
//
// The scale is the house rule for this app: ONE accent, everything else white
// at reduced opacity. Opacity rather than a grey literal because the card sits
// over a live gradient, so white-at-alpha keeps a constant relationship to
// whatever is behind it while a fixed grey drifts against it.

import type { TextStyle } from 'react-native';

/** The single accent. Same value as the dark palette's `primary-400` and the
 *  `tintColor` on the app's tab bar. */
export const CARD_ACCENT = 'rgb(231, 138, 83)';

/**
 * The four levels of ink, brightest first. Anything on a card is one of these
 * and there is no fifth: a new level is a design decision, not a local tweak.
 *
 *  - `primary`   figures and anything that has to survive a screenshot crop
 *  - `secondary` labels that name a figure
 *  - `muted`     qualifiers, denominators, the privacy line
 *  - `accent`    exactly one idea per card, never body text
 */
export const CARD_INK = {
  primary: 'rgba(255, 255, 255, 1)',
  secondary: 'rgba(255, 255, 255, 0.74)',
  muted: 'rgba(255, 255, 255, 0.56)',
  accent: CARD_ACCENT,
} as const;

export type InkLevel = keyof typeof CARD_INK;

/** One colour, as a style object so it composes with `type()` in a style array. */
export function ink(level: InkLevel): TextStyle {
  return { color: CARD_INK[level] };
}

/**
 * Non-text colour, for SVG strokes, fills and rules. Same scale, returned bare
 * so it can go straight into a `stroke` or `backgroundColor`.
 */
export function inkColor(level: InkLevel): string {
  return CARD_INK[level];
}
