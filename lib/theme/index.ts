// Public surface of the theme layer.

import { useThemeStore } from '@/lib/stores/theme-store';

import { SEMANTIC, type SemanticColors } from './semantic';

export { THEME_COLORS, tripleToRgb, type ThemeScheme } from './tokens';
export { SEMANTIC, type SemanticColors } from './semantic';
export {
  contrastRatio,
  relativeLuminance,
  worstOnLightBackdrops,
  LIGHT_BACKDROPS,
  LEGACY_ALIAS_LIGHT,
  AA_TEXT,
  AA_NON_TEXT,
} from './contrast-audit';

/**
 * Semantic colours for the active scheme, inside a component.
 *
 * Returns a frozen object whose reference is stable per scheme, so it is safe
 * in a dependency array and cheap to pass down.
 */
export function useThemeColors(): Readonly<SemanticColors> {
  return SEMANTIC[useThemeStore((s) => s.resolved)];
}

/** Same lookup outside React (module constants, imperative helpers). */
export function getThemeColors(): Readonly<SemanticColors> {
  return SEMANTIC[useThemeStore.getState().resolved];
}
