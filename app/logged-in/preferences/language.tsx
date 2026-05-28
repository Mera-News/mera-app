import LanguageSettingsScreen from '@/components/custom/config-mera/LanguageSettingsScreen';
import { useRouter } from 'expo-router';

export default function LanguagePage() {
    const router = useRouter();

    return <LanguageSettingsScreen onBack={() => router.back()} />;
}
