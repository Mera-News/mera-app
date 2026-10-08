// The backing of the Feed and Explore tab headers (owner): content scrolling
// under a transparent header made it unreadable there. Library and You stay
// transparent (TabPages decides). It fills the header block, status bar
// included, and slides away with the header. No hairline.
//
// With real glass (iOS 26+, Lite off): the app's header glass, layered as
// StatusBarScrim does: the theme's header scrim BEHIND (what the glass
// samples), then the plate at the header tint.
// Without it (Lite, Android, older iOS): there is no blur, so a translucent
// tint left the content under it readable; the flat `headerFill` (85%) makes
// it a faint shape instead (owner).

import { GLASS_AVAILABLE, GlassPlate, useGlassHeader } from '@/components/custom/GlassSurface';
import { useDisplayPrefsStore } from '@/lib/stores/display-prefs-store';
import { useColors } from '@/lib/theme/tokens';
import React from 'react';
import { StyleSheet, View } from 'react-native';

const HeaderGlass: React.FC = () => {
  const header = useGlassHeader();
  const colors = useColors();
  const lite = useDisplayPrefsStore((s) => s.liteMode);
  if (lite || !GLASS_AVAILABLE) {
    return (
      <View
        pointerEvents="none"
        style={[StyleSheet.absoluteFill, { backgroundColor: colors.headerFill }]}
        testID="tab-header-glass"
      />
    );
  }
  return (
    <View
      pointerEvents="none"
      style={[StyleSheet.absoluteFill, { backgroundColor: header.scrim }]}
      testID="tab-header-glass"
    >
      <GlassPlate tint={header.tint} />
    </View>
  );
};

export default HeaderGlass;
