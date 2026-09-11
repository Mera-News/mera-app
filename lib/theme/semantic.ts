// Role names, so a screen asks for `fg` or `surfaceRaised` rather than naming a
// ramp stop. Adding light mode means the stop a role maps to differs per
// scheme, and a role name is the only thing that can stay stable across both.
//
// The roles below are chosen so that every one that carries TEXT clears WCAG AA
// 4.5:1 against all four light backdrops. That is asserted, not asserted-by-
// comment: see `contrast-audit.ts` and its test.

import { THEME_COLORS, type ThemeScheme } from './tokens';

export interface SemanticColors {
  /** Accent identity (fills, bars). NOT legible as text on a light page. */
  accent: string;
  /** Accent used AS TEXT. Light needs a darker stop than the accent identity. */
  accentText: string;
  /** Label placed on top of an accent fill. */
  onAccent: string;
  /** Primary foreground text. */
  fg: string;
  /** Secondary/supporting text. */
  fgSecondary: string;
  /** Tertiary text and captions, the dimmest stop that still clears AA. */
  fgTertiary: string;
  /** The page surface. */
  surface: string;
  /** A card raised above the page. */
  surfaceRaised: string;
  /** A well recessed below the page. */
  surfaceRecessed: string;
  /** Functional control border (clears the 3:1 of WCAG 1.4.11). */
  border: string;
  /** Decorative hairline. Deliberately NOT forced to 3:1. */
  borderSubtle: string;
  /** Destructive text. */
  danger: string;
  /** Pull-to-refresh spinner tint. */
  refreshTint: string;
  /** TextInput placeholder. */
  placeholder: string;
  /** Default icon colour. */
  icon: string;
  /** Focus ring. Needs 3:1, which the accent itself does not meet. */
  focusRing: string;
}

function build(scheme: ThemeScheme): Readonly<SemanticColors> {
  const c = THEME_COLORS[scheme];
  const light = scheme === 'light';
  return Object.freeze({
    accent: light ? c.primary500 : c.primary400,
    accentText: light ? c.primary700 : c.primary400,
    onAccent: light ? c.typography950 : c.typography0,
    fg: light ? c.typography950 : c.typography900,
    fgSecondary: light ? c.typography700 : c.typography600,
    fgTertiary: light ? c.typography400 : c.typography500,
    surface: c.background0,
    surfaceRaised: light ? c.background50 : c.background50,
    surfaceRecessed: light ? c.background100 : c.background100,
    border: c.outline200,
    borderSubtle: c.outline100,
    danger: light ? c.error700 : c.error400,
    refreshTint: light ? c.primary700 : c.primary400,
    placeholder: light ? c.typography400 : c.typography500,
    icon: light ? c.typography700 : c.typography600,
    focusRing: c.indicatorPrimary,
  });
}

export const SEMANTIC: Readonly<Record<ThemeScheme, Readonly<SemanticColors>>> = Object.freeze({
  light: build('light'),
  dark: build('dark'),
});
