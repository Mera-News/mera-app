import ErrorBoundary from '@/components/custom/ErrorBoundary';
import { FullScreenErrorFallback } from '@/components/custom/ErrorFallback';
import ManageSubscriptionScreen from '@/components/custom/config-mera/ManageSubscriptionScreen';
import { useRouter } from 'expo-router';

export default function ManageSubscriptionPage() {
    const router = useRouter();
    return (
        // S7: a crash here stays on this page instead of reaching the root
        // boundary, which swaps the whole app for a fallback.
        <ErrorBoundary level="screen" FallbackComponent={FullScreenErrorFallback}>
            <ManageSubscriptionScreen onBack={() => router.back()} />
        </ErrorBoundary>
    );
}
