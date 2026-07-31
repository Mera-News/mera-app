import { Box } from '@/components/ui/box';
import { GlassView, isLiquidGlassAvailable } from 'expo-glass-effect';
import React from 'react';
import { StyleSheet, type StyleProp, type ViewStyle } from 'react-native';

/**
 * The app's shared Liquid Glass primitives — one place to tune how glass looks
 * across cards, headers, and list rows.
 *
 * ## Availability — read this before using it
 *
 * `GlassView` paints real Liquid Glass ONLY on iOS 26+. Everywhere else it is
 * not a graceful degradation: `expo-glass-effect/src/GlassView.tsx` returns a
 * naked `<View {...props} />` with no background at all, and on iOS below 26 the
 * native view mounts but paints nothing. So a surface that simply swaps its
 * background for glass turns INVISIBLE on Android and older iOS. Every caller
 * must branch on `GLASS_AVAILABLE` and keep an opaque fallback — `GlassPanel`
 * does this for you via `fallbackClassName`.
 *
 * `isLiquidGlassAvailable()` memoizes into a module-level flag inside the
 * package, so reading it once here at import time is free.
 *
 * ## Why glass needs a tint here
 *
 * Glass refracts what is BEHIND it. This app is dark-mode only, and behind most
 * chrome is near-black, so untinted glass renders as black and the surface
 * dissolves into the page. The faint white lift in `GLASS_TINT` restores a
 * readable surface tone while still letting the animated backdrop
 * (`AbstractGradientBackdrop`) and any scrolling content show through.
 */

/** True only where `GlassView` actually paints glass — iOS 26+. */
export const GLASS_AVAILABLE = isLiquidGlassAvailable();

/** The default tint, used by cards and list rows. */
const GLASS_TINT = 'rgba(255,255,255,0.10)';

/**
 * Denser tint for headers, plus the scrim that goes with it.
 *
 * A header is the one glass surface with content moving underneath it at speed,
 * and it carries the smallest text in the app. At the card tint its titles were
 * hard to read against whatever happened to be scrolling past. These two work as
 * a pair: `GLASS_HEADER_SCRIM` is a translucent dark layer painted BEHIND the
 * plate, which is what the glass then samples — that is what actually reduces
 * see-through, since raising the white tint alone just washes the header out and
 * makes light text worse. The stronger tint then lifts the surface back up.
 */
export const GLASS_HEADER_TINT = 'rgba(255,255,255,0.16)';
export const GLASS_HEADER_SCRIM = 'rgba(0,0,0,0.42)';

/** Hairline edge that gives a glass surface a defined boundary. Glass alone has
 *  no outline against a dark page, so without this the surface reads as a smudge
 *  rather than a panel. */
export const GLASS_EDGE = 'border border-white/10';

/**
 * Absolute-fill glass background. Renders nothing where glass is unavailable,
 * so it is always safe to mount — but the caller still has to decide whether to
 * drop its own opaque background, which is why `GLASS_AVAILABLE` is exported.
 *
 * Its parent must be an UNPADDED box that owns the corner radius and
 * `overflow-hidden`: Yoga resolves an absolute child's insets against the
 * parent's CONTENT box, so hanging this off a padded view leaves an unglassed
 * frame. And the parent's clipping is what rounds the glass — a native
 * visual-effect view does not reliably pick up a NativeWind `rounded-*` class.
 */
export const GlassPlate: React.FC<{ tint?: string; style?: StyleProp<ViewStyle> }> = ({
  tint = GLASS_TINT,
  style,
}) => {
  if (!GLASS_AVAILABLE) return null;

  return (
    <GlassView
      // `regular` over `clear`: on a near-black page `clear` is nearly invisible.
      glassEffectStyle="regular"
      // The app has no theme toggle — it is always dark — so pin the glass
      // rather than letting it follow the system appearance.
      colorScheme="dark"
      tintColor={tint}
      style={[StyleSheet.absoluteFill, style]}
      // Purely decorative: never intercept a tap meant for the surface.
      pointerEvents="none"
    />
  );
};

export interface GlassPanelProps {
  /** Corner radius in points. Applied as a style, not a class — see `GlassPlate`. */
  radius?: number;
  /** Classes for the OUTER box. Must not include padding (see `GlassPlate`) —
   *  put padding in `contentClassName`. Margins and sizing belong here. */
  className?: string;
  /** Classes for the inner content box: padding and layout. */
  contentClassName?: string;
  /** Background applied INSTEAD of glass wherever glass is unavailable. Without
   *  it the panel would be invisible on Android and iOS < 26. */
  fallbackClassName?: string;
  /** Draw the hairline edge. Default true. */
  edge?: boolean;
  /**
   * Overrides the plate's tint. The default lifts the surface with a faint
   * white, which is right for a panel that should read as sitting ABOVE the
   * page — a card, a row, a header. Pass a dark translucent value instead for a
   * surface that should recede into the page and merely occlude what is behind
   * it, where a white lift would read as a grey slab pasted across the
   * background.
   */
  tint?: string;
  style?: StyleProp<ViewStyle>;
  testID?: string;
  children?: React.ReactNode;
}

/**
 * A rounded surface backed by glass, with an opaque fallback. The ergonomic
 * wrapper for chrome that used to paint a flat `bg-background-0`: settings rows,
 * accordions, panels.
 *
 * Structure exists to satisfy `GlassPlate`'s contract — an unpadded, clipping
 * outer box holding the plate plus a padded inner box for content.
 */
export const GlassPanel: React.FC<GlassPanelProps> = ({
  radius = 12,
  className = '',
  contentClassName = '',
  fallbackClassName = 'bg-background-0',
  edge = true,
  tint,
  style,
  testID,
  children,
}) => (
  <Box
    testID={testID}
    className={[
      className,
      edge && GLASS_AVAILABLE ? GLASS_EDGE : '',
      GLASS_AVAILABLE ? '' : fallbackClassName,
    ]
      .filter(Boolean)
      .join(' ')}
    style={[{ borderRadius: radius, overflow: 'hidden' }, style]}
  >
    <GlassPlate tint={tint} />
    <Box className={contentClassName}>{children}</Box>
  </Box>
);

export default GlassPanel;
