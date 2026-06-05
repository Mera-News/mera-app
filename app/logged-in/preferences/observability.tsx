import ObservabilityScreen from '@/components/custom/config-mera/ObservabilityScreen';
import { useRouter } from 'expo-router';

export default function ObservabilityPage() {
    const router = useRouter();
    return <ObservabilityScreen onBack={() => router.back()} />;
}
