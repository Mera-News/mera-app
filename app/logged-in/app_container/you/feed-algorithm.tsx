import TabStackScreen from '@/components/custom/nav/TabStackScreen';
import FeedAlgorithmScreen from '@/components/custom/config-mera/FeedAlgorithmScreen';
import { router } from 'expo-router';

export default function FeedAlgorithmScreenRoute() {
  return (
    <TabStackScreen surface="settings:feed-algorithm">
      <FeedAlgorithmScreen onBack={() => router.back()} />
    </TabStackScreen>
  );
}
