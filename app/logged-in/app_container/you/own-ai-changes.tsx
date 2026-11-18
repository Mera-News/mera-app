import TabStackScreen from '@/components/custom/nav/TabStackScreen';
import WhatChangesScreen from '@/components/custom/config-mera/own-services/WhatChangesScreen';
import { router } from 'expo-router';

export default function WhatChangesScreenRoute() {
  return (
    <TabStackScreen surface="settings:mera-protocol">
      <WhatChangesScreen onBack={() => router.back()} />
    </TabStackScreen>
  );
}
