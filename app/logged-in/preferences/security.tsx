import SecuritySettingsScreen from '@/components/custom/config-mera/SecuritySettingsScreen';
import { useRouter } from 'expo-router';

export default function SecurityPage() {
  const router = useRouter();

  return <SecuritySettingsScreen onBack={() => router.back()} />;
}
