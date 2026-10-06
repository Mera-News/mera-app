import TabStackScreen from '@/components/custom/nav/TabStackScreen';
import FactsScreen from '@/components/custom/facts/FactsScreen';
import { router } from 'expo-router';

export default function FactsScreenRoute() {
  return (
    <TabStackScreen surface="facts" backdrop testID="facts-screen">
      <FactsScreen onBack={() => router.back()} />
    </TabStackScreen>
  );
}
