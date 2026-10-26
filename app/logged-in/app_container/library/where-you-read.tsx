import WhereYouReadScreen from '@/components/custom/library/WhereYouReadScreen';
import TabStackScreen from '@/components/custom/nav/TabStackScreen';
import { router } from 'expo-router';

export default function WhereYouReadRoute() {
  return (
    <TabStackScreen surface="where-you-read" backdrop testID="where-you-read-screen">
      <WhereYouReadScreen onBack={() => router.back()} />
    </TabStackScreen>
  );
}
