import TabStackScreen from '@/components/custom/nav/TabStackScreen';
import HygieneReviewScreen from '@/components/custom/hygiene/HygieneReviewScreen';
import { router } from 'expo-router';

export default function HygieneReviewScreenRoute() {
  return (
    <TabStackScreen surface="hygiene" backdrop testID="hygiene-review-screen">
      <HygieneReviewScreen onBack={() => router.back()} />
    </TabStackScreen>
  );
}
