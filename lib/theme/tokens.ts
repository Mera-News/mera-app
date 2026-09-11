// Frozen, module-load-time colour lookups derived from the single token source.
//
// `rawTokens` stores triples as the string nativewind needs ('231 138 83').
// Almost every non-className consumer in the app wants a real CSS colour
// instead: `MaterialIcons color=`, `RefreshControl tintColor`, SVG `fill`,
// `placeholderTextColor`. Converting at each call site is what produced the 88
// hardcoded hex constants this module retires, so the conversion happens once,
// here, at import.
//
// These are PLAIN FROZEN OBJECTS, not hooks and not subscriptions. The
// reference for a given scheme never changes, so they are safe in dependency
// arrays. Do NOT rebuild this on `useUnstableNativeVariable`: it subscribes per
// variable, and ~590 call sites would be a subscription storm.

import { rawTokens } from '@/components/ui/gluestack-ui-provider/config';

export type ThemeScheme = 'light' | 'dark';

/** '--color-primary-500' -> 'primary500'; '--color-background-muted' -> 'backgroundMuted'. */
function camelKey(cssVar: string): string {
  const parts = cssVar.replace('--color-', '').split('-');
  return (
    parts[0] +
    parts
      .slice(1)
      .map((p) => (/^\d+$/.test(p) ? p : p.charAt(0).toUpperCase() + p.slice(1)))
      .join('')
  );
}

/** '231 138 83' -> 'rgb(231, 138, 83)'. */
export function tripleToRgb(triple: string): string {
  const [r, g, b] = triple.trim().split(/\s+/);
  return `rgb(${r}, ${g}, ${b})`;
}

function buildScheme(source: Record<string, string>): Readonly<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const [cssVar, triple] of Object.entries(source)) {
    out[camelKey(cssVar)] = tripleToRgb(triple);
  }
  return Object.freeze(out);
}

/**
 * Colour-asserting tests use `THEME_COLORS.dark.primary500`, never a literal
 * like '#EDA77E' — a literal silently stops tracking the token it was copied
 * from.
 */
export const THEME_COLORS: Readonly<Record<ThemeScheme, Readonly<Record<string, string>>>> =
  Object.freeze({
    light: buildScheme(rawTokens.light),
    dark: buildScheme(rawTokens.dark),
  });
