import TabStackScreen from '@/components/custom/nav/TabStackScreen';
import PersonaAuditScreen from '@/components/custom/persona-audit/PersonaAuditScreen';
import { router } from 'expo-router';

export default function PersonaAuditScreenRoute() {
  return (
    <TabStackScreen surface="activity" backdrop testID="persona-audit-screen">
      <PersonaAuditScreen onBack={() => router.back()} />
    </TabStackScreen>
  );
}
