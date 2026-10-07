// The world tab's stack. The Mera button mounts once per tab, after the
// Stack, so it sits above every screen in it.
import { Stack } from 'expo-router';
import { View } from 'react-native';

import MeraButtonHost from '@/components/custom/mera-button/MeraButtonHost';
import { useColors } from '@/lib/theme/tokens';

export default function StackLayout() {
  const colors = useColors();
  return (
    <View style={{ flex: 1 }}>
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.base } }} />
      <MeraButtonHost tab="world" />
    </View>
  );
}
