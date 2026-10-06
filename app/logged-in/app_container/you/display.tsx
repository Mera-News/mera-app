import TabStackScreen from '@/components/custom/nav/TabStackScreen';
import DisplaySettingsScreen from '@/components/custom/config-mera/DisplaySettingsScreen';
import { router } from 'expo-router';

export default function DisplaySettingsScreenRoute() {
  return (
    <TabStackScreen surface="settings:display">
      <DisplaySettingsScreen onBack={() => router.back()} />
    </TabStackScreen>
  );
}
