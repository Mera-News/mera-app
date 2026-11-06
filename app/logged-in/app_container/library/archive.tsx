import TabStackScreen from '@/components/custom/nav/TabStackScreen';
import ArchiveScreen from '@/components/custom/saved-suggestions/ArchiveScreen';
import { router } from 'expo-router';

export default function ArchiveRoute() {
  return (
    <TabStackScreen surface="archive" backdrop testID="archive-screen">
      <ArchiveScreen onBack={() => router.back()} />
    </TabStackScreen>
  );
}
