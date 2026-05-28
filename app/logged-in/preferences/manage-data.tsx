import ManageDataScreen from '@/components/custom/config-mera/ManageDataScreen';
import { useRouter } from 'expo-router';

export default function ManageDataPage() {
    const router = useRouter();

    return <ManageDataScreen onBack={() => router.back()} />;
}
