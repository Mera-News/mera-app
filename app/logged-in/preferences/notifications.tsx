import ErrorBoundary from '@/components/custom/ErrorBoundary';
import { FullScreenErrorFallback } from '@/components/custom/ErrorFallback';
import NotificationSettingsScreen from '@/components/custom/config-mera/NotificationSettingsScreen';
import { useRouter } from 'expo-router';

export default function NotificationsPage() {
    const router = useRouter();

    return (
        // S7: a crash here stays on this page instead of reaching the root
        // boundary, which swaps the whole app for a fallback.
        <ErrorBoundary level="screen" FallbackComponent={FullScreenErrorFallback}>
            <NotificationSettingsScreen onBack={() => router.back()} />
        </ErrorBoundary>
    );
}
