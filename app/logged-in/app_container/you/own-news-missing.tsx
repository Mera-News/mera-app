import TabStackScreen from '@/components/custom/nav/TabStackScreen';
import NotAvailableHereScreen from '@/components/custom/config-mera/own-services/NotAvailableHereScreen';
import { router } from 'expo-router';

export default function NotAvailableHereScreenRoute() {
  return (
    <TabStackScreen surface="settings:mera-protocol">
      <NotAvailableHereScreen onBack={() => router.back()} />
    </TabStackScreen>
  );
}
