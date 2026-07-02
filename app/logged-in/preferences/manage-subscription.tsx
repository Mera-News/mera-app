import ManageSubscriptionScreen from '@/components/custom/config-mera/ManageSubscriptionScreen';
import { useRouter } from 'expo-router';

export default function ManageSubscriptionPage() {
    const router = useRouter();
    return <ManageSubscriptionScreen onBack={() => router.back()} />;
}
