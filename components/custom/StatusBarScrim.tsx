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
import {
  GLASS_AVAILABLE,
  GLASS_HEADER_SCRIM,
  GLASS_HEADER_TINT,
  GlassPlate,
} from '@/components/custom/GlassSurface';
import React from 'react';
import { View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

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
        // Glass does this strip's job — it obscures list content behind the
        // system glyphs without being a black slab. Solid black is kept as the
        // fallback because off iOS 26 a GlassPlate paints nothing at all, and an
        // invisible scrim would let text scroll under the clock.
        // In the glass branch a translucent scrim paints BEHIND the plate — the
        // glass samples it, which is what actually cuts the see-through. It must
        // stay translucent: an opaque fill would cancel the glass. Off iOS 26
        // the fallback stays fully opaque black.
        ...(GLASS_AVAILABLE
          ? { backgroundColor: GLASS_HEADER_SCRIM }
          : { backgroundColor: '#000000' }),
        zIndex: 5,
      }}
    >
      <GlassPlate tint={GLASS_HEADER_TINT} />
    </View>
  );
};

export default StatusBarScrim;
