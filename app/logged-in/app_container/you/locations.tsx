import TabStackScreen from '@/components/custom/nav/TabStackScreen';
import LocationsScreen from '@/components/custom/locations/LocationsScreen';
import { router } from 'expo-router';

export default function LocationsScreenRoute() {
  return (
    <TabStackScreen surface="locations" backdrop testID="locations-screen">
      <LocationsScreen onBack={() => router.back()} />
    </TabStackScreen>
  );
}
