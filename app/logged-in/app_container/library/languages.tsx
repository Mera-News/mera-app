import LanguagesScreen from '@/components/custom/library/LanguagesScreen';
import TabStackScreen from '@/components/custom/nav/TabStackScreen';
import { router } from 'expo-router';

export default function LanguagesRoute() {
  return (
    <TabStackScreen surface="languages" backdrop testID="languages-screen">
      <LanguagesScreen onBack={() => router.back()} />
    </TabStackScreen>
  );
}
