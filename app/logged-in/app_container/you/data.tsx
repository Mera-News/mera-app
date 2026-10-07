// Settings > Your data, inside the You stack (FinalSettings #15).
import ManageDataScreen from '@/components/custom/config-mera/ManageDataScreen';
import TabStackScreen from '@/components/custom/nav/TabStackScreen';
import { router } from 'expo-router';

export default function YourDataRoute() {
  return (
    <TabStackScreen surface="settings" backdrop testID="your-data-screen">
      <ManageDataScreen onBack={() => router.back()} />
    </TabStackScreen>
  );
}
