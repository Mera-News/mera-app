// card-theme — the ink the share images are drawn with.
//
// A share image is a fixed raster with its OWN background, picked on Preview
// (Dark or Light) whatever the app theme. So its colours never come from a
// theme class or the app tokens at render: every colour on an image comes from
// the palette in CardPaletteContext, through `useCardInk()`, and lands in the
// `style` prop beside the fontSize/lineHeight pair from `type()`. A class
// colour follows the app theme, not the image, and a class-name assertion
// cannot see what colour it resolves to (the dark ramp is an inversion:
// `text-typography-0` is near-black in dark), which is how the first card
// shipped its figures invisible.
//
// The scale is the house rule: ONE accent, everything else the palette's ink
// at reduced strength. The Library's Stats page cards (StatTile) draw with
// the app theme instead.

import React from 'react';
import type { TextStyle } from 'react-native';
import { COLORS } from '@/lib/theme/tokens';

/** The single accent. Same value as the dark palette's `primary-400` and the
 *  `tintColor` on the app's tab bar. */
export const CARD_ACCENT = 'rgb(231, 138, 83)';

/**
 * The four levels of ink, brightest first, plus the non-text tones the charts
 * need. Anything on a card is one of these and there is no fifth: a new level
 * is a design decision, not a local tweak.
 *
 *  - `primary`   figures and anything that has to survive a screenshot crop
 *  - `secondary` labels that name a figure
 *  - `muted`     qualifiers, denominators, the privacy line
 *  - `accent`    exactly one idea per card, never body text
 *
 * TWO palettes (FinalLibrary #12, #13): the share image's Dark or Light
 * background, picked on Preview whatever the app theme, never stored. The
 * Library's own page cards draw with the app theme's palette instead.
 */
export interface CardPalette {
  readonly primary: string;
  readonly secondary: string;
  readonly muted: string;
  readonly accent: string;
  /** Proportion-bar bands after the accent, strongest first. */
  readonly steps: readonly [string, string, string];
  /** The ruled scale's rule. */
  readonly rule: string;
  /** Heat grid tones, level 0 (no reading) to 4. */
  readonly heat: readonly [string, string, string, string, string];
  /** The image's base under the backdrop (light) or null for the app's
   *  gradient (dark). */
  readonly base: string | null;
}

export const CARD_PALETTES: Readonly<Record<'dark' | 'light', CardPalette>> = {
  dark: {
    primary: 'rgba(255, 255, 255, 1)',
    secondary: 'rgba(255, 255, 255, 0.74)',
    muted: 'rgba(255, 255, 255, 0.56)',
    accent: CARD_ACCENT,
    steps: ['rgba(255, 255, 255, 0.55)', 'rgba(255, 255, 255, 0.34)', 'rgba(255, 255, 255, 0.18)'],
    rule: 'rgba(255, 255, 255, 0.24)',
    heat: ['rgba(255, 255, 255, 0.07)', 'rgba(231, 138, 83, 0.30)', 'rgba(231, 138, 83, 0.52)', 'rgba(231, 138, 83, 0.76)', CARD_ACCENT],
    base: null,
  },
  light: {
    primary: COLORS.light.ink,
    secondary: COLORS.light.ink2,
    muted: COLORS.light.ink3,
    accent: COLORS.light.accentMark,
    steps: ['rgba(18, 17, 19, 0.45)', 'rgba(18, 17, 19, 0.28)', 'rgba(18, 17, 19, 0.14)'],
    rule: 'rgba(18, 17, 19, 0.20)',
    heat: ['rgba(18, 17, 19, 0.06)', 'rgba(200, 100, 43, 0.30)', 'rgba(200, 100, 43, 0.52)', 'rgba(200, 100, 43, 0.76)', COLORS.light.accentMark],
    base: COLORS.light.base,
  },
};

export type InkLevel = 'primary' | 'secondary' | 'muted' | 'accent';

/** The palette every card piece below the provider draws with. Dark by default. */
export const CardPaletteContext = React.createContext<CardPalette>(CARD_PALETTES.dark);

/** The palette in force, with `ink` (a text style, composes with `type()`)
 *  and `inkColor` (bare, for fills and rules). Colour is always a style. */
export function useCardInk(): {
  readonly palette: CardPalette;
  readonly ink: (level: InkLevel) => TextStyle;
  readonly inkColor: (level: InkLevel) => string;
} {
  const palette = React.useContext(CardPaletteContext);
  return {
    palette,
    ink: (level) => ({ color: palette[level] }),
    inkColor: (level) => palette[level],
  };
}
