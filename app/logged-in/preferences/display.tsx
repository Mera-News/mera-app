import DisplaySettingsScreen from '@/components/custom/config-mera/DisplaySettingsScreen';
import { useRouter } from 'expo-router';

export default function DisplayPage() {
  const router = useRouter();

  return <DisplaySettingsScreen onBack={() => router.back()} />;
}
