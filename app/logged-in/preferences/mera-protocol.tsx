import ErrorBoundary from '@/components/custom/ErrorBoundary';
import { FullScreenErrorFallback } from '@/components/custom/ErrorFallback';
import MeraProtocolSettingsScreen from '@/components/custom/config-mera/MeraProtocolSettingsScreen';
import { useRouter } from 'expo-router';

export default function MeraProtocolPage() {
    const router = useRouter();

    return (
        // S7: a crash here stays on this page instead of reaching the root
        // boundary, which swaps the whole app for a fallback.
        <ErrorBoundary level="screen" FallbackComponent={FullScreenErrorFallback}>
            <MeraProtocolSettingsScreen onBack={() => router.back()} />
        </ErrorBoundary>
    );
}
