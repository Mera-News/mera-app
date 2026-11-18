import TabStackScreen from '@/components/custom/nav/TabStackScreen';
import OwnAiServiceScreen from '@/components/custom/config-mera/own-services/OwnAiServiceScreen';
import { router } from 'expo-router';

export default function OwnAiServiceScreenRoute() {
  return (
    <TabStackScreen surface="settings:mera-protocol">
      <OwnAiServiceScreen onBack={() => router.back()} />
    </TabStackScreen>
  );
}
