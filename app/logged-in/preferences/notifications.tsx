import NotificationSettingsScreen from '@/components/custom/config-mera/NotificationSettingsScreen';
import { useRouter } from 'expo-router';

export default function NotificationsPage() {
    const router = useRouter();

    return <NotificationSettingsScreen onBack={() => router.back()} />;
}
