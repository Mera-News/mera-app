// The world tab's stack. It reports where the tab bar's top is, for the
// one app-wide Mera button (mounted at the logged-in root, which cannot see the bar).
import { Stack } from 'expo-router';
import { View } from 'react-native';

import { useReportTabBarClearance } from '@/lib/navigation/tab-bar';
import { useMotionAllowed } from '@/lib/motion-gate';
import { useColors } from '@/lib/theme/tokens';

export default function StackLayout() {
  const colors = useColors();
  // Lite: pushes and pops are instant; the edge swipe still pops (lib/motion-gate.ts).
  const motion = useMotionAllowed();
  const { ref, onLayout } = useReportTabBarClearance();
  return (
    <View ref={ref} onLayout={onLayout} style={{ flex: 1 }}>
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.base }, ...(motion ? null : { animation: 'none' }) }} />
    </View>
  );
}
