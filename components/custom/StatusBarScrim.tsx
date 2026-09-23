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

/** The stepped fade below the strip, darkest first. Three 4pt bands. */
export const STATUS_BAR_SCRIM_FADE = [0.6, 0.35, 0.15] as const;
const FADE_BAND_PT = 4;

export interface StatusBarScrimProps {
  /** The collapsing header's `hidden` (0 revealed, 1 hidden). Omit for a
   *  screen with no collapsing header: the strip keeps its original look. */
  readonly coverProgress?: SharedValue<number>;
  /**
   * For a screen whose top is a hero IMAGE (the article detail screens): no
   * scrim, no glass and no tint at rest, so there is no grey band across the
   * photo, and only the dark base, rising with `coverProgress` as content
   * scrolls under the status bar. Without `coverProgress` it stays fully
   * transparent. Default off: every other host is unchanged.
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
