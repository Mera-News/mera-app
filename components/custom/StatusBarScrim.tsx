// StatusBarScrim — a solid black strip pinned behind the status bar / Dynamic
// Island region on screens with a COLLAPSING header overlay (Feed, Dashboard).
// When that header translates away on scroll-down, list content would
// otherwise scroll directly behind the system clock/battery glyphs. This is a
// non-interactive, absolutely-positioned overlay only — it must NOT affect
// layout (no new flow element, content padding is unchanged) and must NOT
// intercept touches.
//
// Layering: sits ABOVE the scrollable list (which paints at the default
// zIndex) but BELOW the collapsing header (zIndex 10 on both FeedScreen and
// ForYouScreen), so the header still reads normally above it when revealed.
//
// ## The dark base appears only while the header is collapsed (F21)
//
// With the header hidden, a section title scrolled up behind the clock read
// straight through this strip's 0.42 scrim. The strip is then over CONTENT, so
// it wants the over-content base (GLASS_OVER_CONTENT_FILL). But the strip is
// mounted at ALL times and the translucent header samples it at rest, so a
// permanent dark base would darken the top of every header. A host with a
// collapsing header therefore passes its `hidden` value as `coverProgress`,
// and the base (plus a short fade below the strip) follows it: invisible at
// rest, full when the header is out of the way. Without the prop the strip is
// exactly what it always was.
import {
  GLASS_HEADER_SCRIM,
  GLASS_HEADER_TINT,
  GLASS_OVER_CONTENT_FILL,
  GlassHeaderAndroidBackdrop,
  GlassPlate,
} from '@/components/custom/GlassSurface';
import React from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, { useAnimatedStyle, type SharedValue } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

/**
 * overHero at rest: a darkening at the top so the status bar's own WHITE glyphs
 * (wifi, battery) stay readable over a LIGHT photo, gone by the bottom of the
 * status bar. The glyph band is the upper ~55% of the status bar, so the fade
 * HOLDS its full strength there and only then eases out (smoothstep), which is
 * what gets white glyphs past 3:1 over a white image; a linear ramp from 0.35
 * measured 2.1:1 on device. Stepped Views rather than a CSS gradient (only
 * relied on for Android here); 32 steps across ~62pt are under 2pt each and
 * change by at most ~0.05 alpha, which reads as a gradient, not a band.
 */
export const HERO_TOP_FADE_MAX_ALPHA = 0.55;
export const HERO_TOP_FADE_STEPS = 32;
/** Fraction of the status bar held at full strength (the glyph band). */
export const HERO_TOP_FADE_HOLD = 0.55;

/** Alpha of step `i` (0 = top): held, then a smoothstep ease to zero. */
export function heroTopFadeAlpha(i: number): number {
  const t = (i + 0.5) / HERO_TOP_FADE_STEPS;
  if (t <= HERO_TOP_FADE_HOLD) return HERO_TOP_FADE_MAX_ALPHA;
  const u = Math.min(1, (t - HERO_TOP_FADE_HOLD) / (1 - HERO_TOP_FADE_HOLD));
  return HERO_TOP_FADE_MAX_ALPHA * (1 - u * u * (3 - 2 * u));
}

/** The stepped fade below the strip, darkest first. Three 4pt bands. */
export const STATUS_BAR_SCRIM_FADE = [0.6, 0.35, 0.15] as const;
const FADE_BAND_PT = 4;

export interface StatusBarScrimProps {
  /** The collapsing header's `hidden` (0 revealed, 1 hidden). Omit for a
   *  screen with no collapsing header: the strip keeps its original look. */
  readonly coverProgress?: SharedValue<number>;
  /**
   * For a screen whose top is a hero IMAGE (the article detail screens): no
   * scrim, no glass and no flat tint at rest, so there is no grey band across
   * the photo; just a soft top-down fade (`HERO_TOP_FADE_*`) that keeps the
   * status-bar glyphs readable over a light image. The solid dark base rises
   * over it with `coverProgress` as content scrolls under the status bar.
   * Default off: every other host is unchanged.
   */
  readonly overHero?: boolean;
}

const CoverBase: React.FC<{ progress: SharedValue<number>; top: number }> = ({ progress, top }) => {
  const style = useAnimatedStyle(() => ({ opacity: progress.value }));
  return (
    <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, style]} testID="status-bar-scrim-cover">
      <View style={[StyleSheet.absoluteFill, { backgroundColor: GLASS_OVER_CONTENT_FILL }]} />
      {STATUS_BAR_SCRIM_FADE.map((alpha, i) => (
        <View
          key={alpha}
          testID={`status-bar-scrim-fade-${i}`}
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            top: top + i * FADE_BAND_PT,
            height: FADE_BAND_PT,
            backgroundColor: `rgba(18,17,19,${alpha})`,
          }}
        />
      ))}
    </Animated.View>
  );
};

const StatusBarScrim: React.FC<StatusBarScrimProps> = ({ coverProgress, overHero = false }) => {
  const insets = useSafeAreaInsets();
  if (overHero) {
    return (
      <View
        testID="status-bar-scrim"
        pointerEvents="none"
        style={{ position: 'absolute', top: 0, left: 0, right: 0, height: insets.top, zIndex: 5 }}
      >
        {Array.from({ length: HERO_TOP_FADE_STEPS }, (_, i) => (
          <View
            key={i}
            testID={`status-bar-hero-fade-${i}`}
            style={{
              position: 'absolute',
              left: 0,
              right: 0,
              top: (insets.top * i) / HERO_TOP_FADE_STEPS,
              height: insets.top / HERO_TOP_FADE_STEPS,
              backgroundColor: `rgba(0,0,0,${heroTopFadeAlpha(i).toFixed(4)})`,
            }}
          />
        ))}
        {coverProgress ? <CoverBase progress={coverProgress} top={insets.top} /> : null}
      </View>
    );
  }
  return (
    <View
      testID="status-bar-scrim"
      pointerEvents="none"
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        height: insets.top,
        // The scrim paints BEHIND the plate — on iOS 26 that is what the glass
        // samples, and it is what actually cuts the see-through; everywhere else
        // it composites with the plate's flat tint to the same tone. It must
        // stay translucent: an opaque fill would cancel the glass.
        //
        // There is deliberately NO opaque-black branch any more. `GlassPlate`
        // degrades to a flat translucent fill, so this strip reads as the same
        // material on every platform instead of a black slab across the top of
        // Android.
        backgroundColor: GLASS_HEADER_SCRIM,
        zIndex: 5,
      }}
    >
      {/* Android-only opaque-ish gradient — must render BEFORE GlassPlate so
          the tint below still lifts it to a readable surface tone. See
          GlassSurface.tsx's GlassHeaderAndroidBackdrop doc comment. No-op on
          iOS. */}
      {coverProgress ? <CoverBase progress={coverProgress} top={insets.top} /> : null}
      <GlassHeaderAndroidBackdrop />
      <GlassPlate tint={GLASS_HEADER_TINT} />
    </View>
  );
};

export default StatusBarScrim;
