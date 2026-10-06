import TabStackScreen from '@/components/custom/nav/TabStackScreen';
import MeraProtocolSettingsScreen from '@/components/custom/config-mera/MeraProtocolSettingsScreen';
import { router } from 'expo-router';

export default function MeraProtocolSettingsScreenRoute() {
  return (
    <TabStackScreen surface="settings:mera-protocol">
      <MeraProtocolSettingsScreen onBack={() => router.back()} />
    </TabStackScreen>
  );
}
