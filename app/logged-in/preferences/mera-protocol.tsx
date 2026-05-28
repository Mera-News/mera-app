import MeraProtocolSettingsScreen from '@/components/custom/config-mera/MeraProtocolSettingsScreen';
import { useRouter } from 'expo-router';

export default function MeraProtocolPage() {
    const router = useRouter();

    return <MeraProtocolSettingsScreen onBack={() => router.back()} />;
}
