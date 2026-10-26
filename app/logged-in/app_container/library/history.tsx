import HistoryScreen from '@/components/custom/library/HistoryScreen';
import TabStackScreen from '@/components/custom/nav/TabStackScreen';
import { router, useLocalSearchParams } from 'expo-router';

export default function HistoryRoute() {
  const { country } = useLocalSearchParams<{ country?: string }>();
  return (
    <TabStackScreen surface="history" backdrop testID="history-screen">
      <HistoryScreen country={country ?? null} onBack={() => router.back()} />
    </TabStackScreen>
  );
}
