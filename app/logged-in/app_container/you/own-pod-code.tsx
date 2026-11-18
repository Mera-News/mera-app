import TabStackScreen from '@/components/custom/nav/TabStackScreen';
import PodCodeScreen from '@/components/custom/config-mera/own-services/PodCodeScreen';
import { router } from 'expo-router';

export default function PodCodeScreenRoute() {
  return (
    <TabStackScreen surface="settings:mera-protocol">
      <PodCodeScreen onBack={() => router.back()} />
    </TabStackScreen>
  );
}
