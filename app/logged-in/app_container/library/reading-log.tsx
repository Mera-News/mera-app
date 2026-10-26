import ReadingLogScreen from '@/components/custom/library/ReadingLogScreen';
import TabStackScreen from '@/components/custom/nav/TabStackScreen';
import { router, useLocalSearchParams } from 'expo-router';

export default function ReadingLogRoute() {
  const { day, language } = useLocalSearchParams<{ day?: string; language?: string }>();
  return (
    <TabStackScreen surface="reading-log" backdrop testID="reading-log-screen">
      <ReadingLogScreen initialDay={day ?? null} language={language ?? null} onBack={() => router.back()} />
    </TabStackScreen>
  );
}
