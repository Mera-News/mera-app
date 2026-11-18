import TabStackScreen from '@/components/custom/nav/TabStackScreen';
import OwnNewsServerScreen from '@/components/custom/config-mera/own-services/OwnNewsServerScreen';
import { router } from 'expo-router';

export default function OwnNewsServerScreenRoute() {
  return (
    <TabStackScreen surface="settings:mera-protocol">
      <OwnNewsServerScreen onBack={() => router.back()} />
    </TabStackScreen>
  );
}
