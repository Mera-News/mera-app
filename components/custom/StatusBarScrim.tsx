// StatusBarScrim — a strip pinned behind the status bar / Dynamic Island region
// on screens with a COLLAPSING header overlay (Feed, Dashboard) and on the
// detail screens. When that header translates away on scroll-down, list content
// would otherwise scroll directly behind the system clock/battery glyphs. This
// is a non-interactive, absolutely-positioned overlay only — it must NOT affect
// layout (no new flow element, content padding is unchanged) and must NOT
// intercept touches.
//
// Layering: sits ABOVE the scrollable list (which paints at the default
// zIndex) but BELOW the collapsing header (zIndex 10 on both FeedScreen and
// ForYouScreen), so the header still reads normally above it when revealed.
import {
  GLASS_HEADER_TINT,
  GLASS_OVER_CONTENT_FILL,
  GlassHeaderAndroidBackdrop,
  GlassPlate,
} from '@/components/custom/GlassSurface';
import React from 'react';
import { View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

/**
 * A short stepped fade below the strip, so content does not meet it at a hard
 * line. Plain Views rather than a CSS gradient: the gradient background is only
 * relied on for Android elsewhere in this app, and three bands of 4pt read as a
 * fade at this size.
 */
export const STATUS_BAR_SCRIM_FADE = [0.6, 0.35, 0.15] as const;
const FADE_BAND_PT = 4;

const StatusBarScrim: React.FC = () => {
  const insets = useSafeAreaInsets();
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
        // This strip is over CONTENT, not over the backdrop: it exists for the
        // moment cards scroll up behind the clock. So it takes the over-content
        // base (see GLASS_OVER_CONTENT_FILL). The header scrim it used before
        // (0.42 black) let a section title read straight through the clock,
        // measured on device. The glass plate still paints on top and samples
        // this base, so the strip keeps the header's material.
        backgroundColor: GLASS_OVER_CONTENT_FILL,
        zIndex: 5,
      }}
    >
      {/* Android-only opaque-ish gradient — must render BEFORE GlassPlate so
          the tint below still lifts it to a readable surface tone. See
          GlassSurface.tsx's GlassHeaderAndroidBackdrop doc comment. No-op on
          iOS. */}
      <GlassHeaderAndroidBackdrop />
      <GlassPlate tint={GLASS_HEADER_TINT} />
      {STATUS_BAR_SCRIM_FADE.map((alpha, i) => (
        <View
          key={alpha}
          testID={`status-bar-scrim-fade-${i}`}
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            top: insets.top + i * FADE_BAND_PT,
            height: FADE_BAND_PT,
            backgroundColor: `rgba(18,17,19,${alpha})`,
          }}
        />
      ))}
    </View>
  );
};

export default StatusBarScrim;
