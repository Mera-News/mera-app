import TabStackScreen from '@/components/custom/nav/TabStackScreen';
import PodPairScreen from '@/components/custom/config-mera/own-services/PodPairScreen';
import { router } from 'expo-router';

export default function PodPairScreenRoute() {
  return (
    <TabStackScreen surface="settings:mera-protocol">
      <PodPairScreen onBack={() => router.back()} />
    </TabStackScreen>
  );
}
