import TabStackScreen from '@/components/custom/nav/TabStackScreen';
import OwnPodScreen from '@/components/custom/config-mera/own-services/OwnPodScreen';
import { router } from 'expo-router';

export default function OwnPodScreenRoute() {
  return (
    <TabStackScreen surface="settings:mera-protocol">
      <OwnPodScreen onBack={() => router.back()} />
    </TabStackScreen>
  );
}
