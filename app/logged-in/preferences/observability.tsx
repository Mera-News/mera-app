import ErrorBoundary from '@/components/custom/ErrorBoundary';
import { FullScreenErrorFallback } from '@/components/custom/ErrorFallback';
import ObservabilityScreen from '@/components/custom/config-mera/ObservabilityScreen';
import { useRouter } from 'expo-router';

export default function ObservabilityPage() {
    const router = useRouter();
    return (
        // S7: a crash here stays on this page instead of reaching the root
        // boundary, which swaps the whole app for a fallback.
        <ErrorBoundary level="screen" FallbackComponent={FullScreenErrorFallback}>
            <ObservabilityScreen onBack={() => router.back()} />
        </ErrorBoundary>
    );
}
