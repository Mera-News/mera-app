// The Feed tab's stack: the Feed pages, and One interest pushed on top of
// them, so switching tabs and back keeps it open and re-tapping Feed pops to
// the list. It reports where the tab bar's top is, for the
// one app-wide Mera button (mounted at the logged-in root, which cannot see the bar).
import { Stack } from 'expo-router';
import { View } from 'react-native';

import { useReportTabBarClearance } from '@/lib/navigation/tab-bar';
import { useMotionAllowed } from '@/lib/motion-gate';
import { useColors } from '@/lib/theme/tokens';

export default function FeedStackLayout() {
  const colors = useColors();
  // Lite: pushes and pops are instant; the edge swipe still pops (lib/motion-gate.ts).
  const motion = useMotionAllowed();
  const { ref, onLayout } = useReportTabBarClearance();
  return (
    <View ref={ref} onLayout={onLayout} style={{ flex: 1 }}>
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.base }, ...(motion ? null : { animation: 'none' }) }}>
        <Stack.Screen name="index" />
        <Stack.Screen
          name="interest"
          // A hop from an interest's "Next" row (via: 'next') replaces the
          // screen with the next interest; it crossfades rather than sliding.
          options={({ route }) => ({
            animation: !motion
              ? 'none'
              : (route.params as { via?: string } | undefined)?.via === 'next'
                ? 'fade'
                : 'slide_from_right',
          })}
        />
      </Stack>
    </View>
  );
}
