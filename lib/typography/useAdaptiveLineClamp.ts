import { useWindowDimensions } from 'react-native';
import { useTextScale } from './TextScaleContext';
import { MAX_FONT_SCALE } from './policy';

/**
 * A `numberOfLines` clamp that grows as text grows.
 *
 * A fixed clamp is a fixed number of LINES, not a fixed amount of text. At the
 * default size `numberOfLines={2}` on a card headline shows a whole headline;
 * at 2x it shows one-and-a-bit words and an ellipsis, because the words got
 * twice as wide while the allowance stayed at two. The clamp has to move with
 * the type or it silently becomes a censor.
 *
 * `useWindowDimensions().fontScale` is used rather than
 * `PixelRatio.getFontScale()` deliberately: it is a hook, so it RE-RENDERS when
 * the OS text size changes while the app is running. A module-scope constant
 * computed from `PixelRatio` is read once at import and is wrong forever after.
 *
 * Returns `base` exactly at 1x, so nothing about default rendering changes.
 */
export function useAdaptiveLineClamp(base: number, max = base * 2): number {
  const { fontScale } = useWindowDimensions();
  const userScale = useTextScale();

  // Cap the OS contribution at the same ceiling the text itself is capped at —
  // past `content` the glyphs stop growing, so the allowance should stop too.
  const effective = Math.min(fontScale, MAX_FONT_SCALE.content) * userScale;
  if (effective <= 1) return base;

  return Math.min(max, Math.round(base * effective));
}
