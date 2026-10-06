import TabStackScreen from '@/components/custom/nav/TabStackScreen';
import PublicationPreferencesScreen from '@/components/custom/publication-preferences/PublicationPreferencesScreen';
import { router } from 'expo-router';

export default function PublicationPreferencesScreenRoute() {
  return (
    <TabStackScreen surface="sources" backdrop testID="publication-preferences-screen">
      <PublicationPreferencesScreen onBack={() => router.back()} />
    </TabStackScreen>
  );
}
