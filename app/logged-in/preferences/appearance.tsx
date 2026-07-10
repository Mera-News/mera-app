import AppearanceSettingsScreen from '@/components/custom/config-mera/AppearanceSettingsScreen';
import { useRouter } from 'expo-router';

export default function AppearancePage() {
    const router = useRouter();

    return <AppearanceSettingsScreen onBack={() => router.back()} />;
}
