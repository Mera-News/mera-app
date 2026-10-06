import TabStackScreen from '@/components/custom/nav/TabStackScreen';
import NotInterestedScreen from '@/components/custom/not-interested/NotInterestedScreen';
import { router } from 'expo-router';

export default function NotInterestedScreenRoute() {
  return (
    <TabStackScreen surface="not-interested" backdrop>
      <NotInterestedScreen onBack={() => router.back()} />
    </TabStackScreen>
  );
}
