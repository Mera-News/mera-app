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
      <GlassPlate tint={GLASS_HEADER_TINT} />
    </View>
  );
};

export default StatusBarScrim;
