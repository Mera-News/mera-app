// The frosted backing of the Feed and Explore tab headers (owner): content
// scrolling under a transparent header made it unreadable there. Library and
// You stay transparent (TabPages decides). It fills the header block, status
// bar included, and slides away with the header.
//
// The app's existing header glass, layered exactly as StatusBarScrim does:
// the theme's header scrim BEHIND (what the glass samples, what cuts the
// see-through), Android's gradient stand-in, then the plate. Real glass
// (GlassPlate: GlassView on iOS 26+, its own flat tint elsewhere); in Lite a
// flat fill at the same tint, no live blur. No hairline.

import {
  GlassHeaderAndroidBackdrop,
  GlassPlate,
  useGlassHeader,
} from '@/components/custom/GlassSurface';
import { useDisplayPrefsStore } from '@/lib/stores/display-prefs-store';
import React from 'react';
import { StyleSheet, View } from 'react-native';

const HeaderGlass: React.FC = () => {
  const header = useGlassHeader();
  const lite = useDisplayPrefsStore((s) => s.liteMode);
  return (
    <View
      pointerEvents="none"
      style={[StyleSheet.absoluteFill, { backgroundColor: header.scrim }]}
      testID="tab-header-glass"
    >
      <GlassHeaderAndroidBackdrop />
      {lite ? (
        <View style={[StyleSheet.absoluteFill, { backgroundColor: header.tint }]} />
      ) : (
        <GlassPlate tint={header.tint} />
      )}
    </View>
  );
};

export default HeaderGlass;
