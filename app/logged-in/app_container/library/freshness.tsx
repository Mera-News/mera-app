import FreshnessScreen from '@/components/custom/library/FreshnessScreen';
import TabStackScreen from '@/components/custom/nav/TabStackScreen';
import { router } from 'expo-router';

export default function FreshnessRoute() {
  return (
    <TabStackScreen surface="freshness" backdrop testID="freshness-screen">
      <FreshnessScreen onBack={() => router.back()} />
    </TabStackScreen>
  );
}
