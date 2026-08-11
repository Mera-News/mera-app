import { Box } from '@/components/ui/box';
import { GlassView, isLiquidGlassAvailable } from 'expo-glass-effect';
import React from 'react';
import { Platform, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

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

/**
 * True only where `GlassView` actually paints glass — iOS 26+.
 *
 * **Nothing outside this file reads it any more, and that is deliberate.** It
 * used to be the required companion of every `GlassPlate`: the plate returned
 * `null` off iOS 26, so six chrome call sites each hand-rolled their own opaque
 * fallback — and all six drifted into being wrong the same way (an opaque black
 * slab, or in the FAB's case a white pill with a dark chevron, where iOS showed
 * a translucent tinted surface over the gradient backdrop). `GlassPlate` now
 * degrades to a flat translucent fill at the requested tint, so a caller that
 * mounts it gets a correct-looking surface on every platform with no branch.
 *
 * It stays exported because the question "is this real Liquid Glass?" is still
 * a legitimate one to ask — of a perf decision, or a screenshot test — and
 * re-deriving it at a call site would be worse than importing it. If you find
 * yourself adding `GLASS_AVAILABLE ? … : …` to pick a COLOUR, that is the
 * pattern this comment exists to stop: put the fallback in the primitive.
 */
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

/**
 * Android-only opaque-ish gradient that stands in for the missing blur behind
 * every header.
 *
 * ## Why Android needs a THIRD layer, not just a stronger scrim
 *
 * `GlassPlate`'s non-glass branch (below) is a flat 16% white fill with no
 * blur — there is no `UIVisualEffectView` off iOS 26, so nothing diffuses
 * what's behind it. Composited with `GLASS_HEADER_SCRIM`, transmission works
 * out to `(1 − 0.42) × (1 − 0.16) ≈ 0.49`: on Android roughly half of
 * whatever is scrolling behind a header shows straight through it, which
 * reads as a bug rather than "frosted." On iOS 26 the identical two numbers
 * sit under real glass, so the see-through is diffused and reads as
 * intentional. Raising `GLASS_HEADER_SCRIM` itself would fix Android but
 * also darken the iOS 26 glass sample, so the fix is a layer that renders on
 * Android alone.
 *
 * Top-to-bottom, not a flat fill: near-opaque under the status bar, easing
 * down toward the header's bottom edge so it blends into scrolling content
 * rather than ending on a hard seam — the same read a real blur gives for
 * free by having nothing high-frequency left to diffuse near an edge.
 *
 * CSS STRING form, not the `ViewStyle` object form — see
 * `AbstractGradientBackdrop.tsx`'s `CssBlobField` comment for why: RN 0.83's
 * `StyleSheetTypes.d.ts` has no linear-gradient variant either, and
 * NativeWind 4.2.1 emits nothing at all for gradient classes, so a Tailwind
 * gradient class would silently do nothing.
 */
export const GLASS_HEADER_ANDROID_GRADIENT =
  'linear-gradient(180deg, rgba(8,8,10,0.95) 0%, rgba(8,8,10,0.88) 55%, rgba(8,8,10,0.68) 100%)';

/** True only on Android — mirrors `AbstractGradientBackdrop.tsx`'s
 *  `ANDROID_STATIC_CSS`, resolved once at module load so nothing downstream
 *  branches on the platform. */
const IS_ANDROID = Platform.OS === 'android';

/**
 * Absolute-fill Android gradient layer for header chrome. Renders `null` on
 * every other platform, so all five header paint sites (the four screen
 * headers plus `StatusBarScrim`) can mount it unconditionally instead of each
 * repeating its own `Platform.OS === 'android'` branch — the whole point of
 * centralising this in one file is that the five sites cannot drift apart.
 *
 * MUST be mounted BEFORE `GlassPlate`, not after: this layer is meant to cut
 * the see-through the same way `GLASS_HEADER_SCRIM` does on iOS 26 — behind
 * the plate, which then lifts it back to a readable surface tone with
 * `GLASS_HEADER_TINT`. Mounting it after `GlassPlate` would paint a
 * near-opaque layer OVER that 16% white lift and cancel it, producing exactly
 * the flat near-black slab this file's own history (see `GlassPlate`'s doc
 * comment) already identifies as the wrong Android fallback.
 */
export const GlassHeaderAndroidBackdrop: React.FC = () =>
  IS_ANDROID ? (
    <View
      pointerEvents="none"
      style={[
        StyleSheet.absoluteFill,
        { experimental_backgroundImage: GLASS_HEADER_ANDROID_GRADIENT } as unknown as ViewStyle,
      ]}
    />
  ) : null;

/** Fill for `TranslucentPlate`. Matches the default glass tint's lift so a
 *  content surface and a chrome surface read as the same material. */
const TRANSLUCENT_FILL = 'rgba(255,255,255,0.07)';

/** Hairline edge that gives a glass surface a defined boundary. Glass alone has
 *  no outline against a dark page, so without this the surface reads as a smudge
 *  rather than a panel. */
export const GLASS_EDGE = 'border border-white/10';

/**
 * Absolute-fill glass background — real Liquid Glass on iOS 26+, a flat
 * translucent fill at the same tint everywhere else.
 *
 * ## Why the fallback is a fill and not `null`
 *
 * This used to `return null` off iOS 26, on the reasoning that a caller could
 * see `GLASS_AVAILABLE` and supply its own fallback. Six chrome call sites did,
 * and **every one of them was wrong the same way** — an opaque `#000000` slab
 * (or, for `ScrollToTopFab`, a near-white pill with a dark chevron) where iOS 26
 * showed a translucent tinted surface floating over the gradient backdrop. That
 * cost was paid on Android AND on iOS < 26, and it was invisible to anyone
 * developing on a current iPhone.
 *
 * A flat `rgba` fill at the requested tint is what glass looks like once you
 * remove the refraction: same lift, same transparency, no blur. Over a soft
 * gradient there is very little high-frequency detail for a blur to diffuse
 * anyway, which is the same argument `TranslucentPlate` below already makes for
 * content surfaces. So the degradation is now the primitive's job, one place,
 * and no call site branches.
 *
 * It is also free: a background colour, no native view, nothing to re-sample.
 *
 * Its parent must be an UNPADDED box that owns the corner radius and
 * `overflow-hidden`: Yoga resolves an absolute child's insets against the
 * parent's CONTENT box, so hanging this off a padded view leaves an unglassed
 * frame. And the parent's clipping is what rounds the glass — a native
 * visual-effect view does not reliably pick up a NativeWind `rounded-*` class.
 * (The fallback honours `style`, so a caller passing `borderRadius` there — as
 * the FAB does, because RN drops a shadow off any view that clips itself — gets
 * a rounded fill too.)
 */
export const GlassPlate: React.FC<{ tint?: string; style?: StyleProp<ViewStyle> }> = ({
  tint = GLASS_TINT,
  style,
}) => {
  if (!GLASS_AVAILABLE) {
    return (
      <View
        pointerEvents="none"
        style={[StyleSheet.absoluteFill, { backgroundColor: tint }, style]}
      />
    );
  }

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

/**
 * The cheap stand-in for `GlassPlate`, for surfaces that exist in QUANTITY.
 *
 * ## Why this exists — read before "upgrading" a caller to real glass
 *
 * A `GlassView` is a `UIVisualEffectView`, and a blur must re-sample its
 * backdrop every frame that backdrop changes. The page backdrop
 * (`AbstractGradientBackdrop`) animates continuously, so every real glass
 * surface on screen recomputes a full-screen blur every frame — even while the
 * user is perfectly still. That cost is per-surface, so it multiplies: ~10
 * visible article cards meant ~10 continuous blurs, and it measurably slowed
 * the app.
 *
 * So the rule is: **real glass for chrome, this for content.** Chrome is few
 * and mostly static (headers, the scroll FAB, the status panel, the tab bar).
 * Content is many and scrolls (article cards, list rows).
 *
 * Over a colourful gradient a translucent white lift is nearly indistinguishable
 * from frosted glass anyway — the blur has little high-frequency detail to
 * diffuse — so this keeps the look at essentially zero cost. It also works
 * everywhere, with no iOS 26 gate, because it is just a background colour.
 */
export const TranslucentPlate: React.FC<{ style?: StyleProp<ViewStyle> }> = ({ style }) => (
  <View
    pointerEvents="none"
    style={[StyleSheet.absoluteFill, { backgroundColor: TRANSLUCENT_FILL }, style]}
  />
);

export interface GlassPanelProps {
  /** Corner radius in points. Applied as a style, not a class — see `GlassPlate`. */
  radius?: number;
  /** Classes for the OUTER box. Must not include padding (see `GlassPlate`) —
   *  put padding in `contentClassName`. Margins and sizing belong here. */
  className?: string;
  /** Classes for the inner content box: padding and layout. */
  contentClassName?: string;
  /**
   * @deprecated Ignored, and kept only so existing call sites still compile.
   * It existed because a real `GlassView` paints nothing off iOS 26, so a panel
   * needed an opaque fallback or it vanished. `GlassPanel` now uses
   * `TranslucentPlate`, which is just a background colour and therefore works on
   * every platform — there is nothing left to fall back to.
   */
  fallbackClassName?: string;
  /** Draw the hairline edge. Default true. */
  edge?: boolean;
  /**
   * @deprecated Ignored. It tuned the glass plate's tint; this panel no longer
   * uses a glass plate. Kept so existing call sites still compile.
   */
  tint?: string;
  style?: StyleProp<ViewStyle>;
  testID?: string;
  children?: React.ReactNode;
}

/**
 * A rounded translucent surface: settings rows, accordions, chips, small panels.
 *
 * Deliberately NOT real glass. These are CONTENT surfaces and they come in
 * quantity — the settings list alone renders nine of them, a profile's fact
 * accordions a dozen more — and every real glass surface recomputes a blur on
 * every frame the animated page backdrop changes. That is what made the app
 * slow. `TranslucentPlate` gives the same read over a gradient at no cost.
 *
 * If you need actual frosted glass, the surface is chrome, and chrome uses
 * `GlassPlate` directly. Keep that set small and static — today it is the three
 * screen headers, the status-bar scrim and the scroll FAB.
 */
export const GlassPanel: React.FC<GlassPanelProps> = ({
  radius = 12,
  className = '',
  contentClassName = '',
  fallbackClassName = 'bg-background-0',
  edge = true,
  style,
  testID,
  children,
}) => (
  <Box
    testID={testID}
    className={[className, edge ? GLASS_EDGE : ''].filter(Boolean).join(' ')}
    style={[{ borderRadius: radius, overflow: 'hidden' }, style]}
  >
    <TranslucentPlate />
    <Box className={contentClassName}>{children}</Box>
  </Box>
);

export default GlassPanel;
