import TabStackScreen from '@/components/custom/nav/TabStackScreen';
import NotificationSettingsScreen from '@/components/custom/config-mera/NotificationSettingsScreen';
import { router } from 'expo-router';

export default function NotificationSettingsScreenRoute() {
  return (
    <TabStackScreen surface="settings:notifications">
      <NotificationSettingsScreen onBack={() => router.back()} />
    </TabStackScreen>
  );
}
