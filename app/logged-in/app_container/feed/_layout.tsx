// The Feed tab's stack: the Feed pages, and One interest pushed on top of
// them, so switching tabs and back keeps it open and re-tapping Feed pops to
// the list. The Mera button mounts once per tab, after the Stack, so it sits
// above every screen in it.
import { Stack } from 'expo-router';
import { View } from 'react-native';

import MeraButtonHost from '@/components/custom/mera-button/MeraButtonHost';
import { useColors } from '@/lib/theme/tokens';

export default function FeedStackLayout() {
  const colors = useColors();
  return (
    <View style={{ flex: 1 }}>
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.base } }}>
        <Stack.Screen name="index" />
        <Stack.Screen
          name="interest"
          // A hop from an interest's "Next" row (via: 'next') replaces the
          // screen with the next interest; it crossfades rather than sliding.
          options={({ route }) => ({
            animation:
              (route.params as { via?: string } | undefined)?.via === 'next' ? 'fade' : 'slide_from_right',
          })}
        />
      </Stack>
      <MeraButtonHost tab="feed" />
    </View>
  );
}
