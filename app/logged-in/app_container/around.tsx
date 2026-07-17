import ErrorBoundary from '@/components/custom/ErrorBoundary';
import { FullScreenErrorFallback } from '@/components/custom/ErrorFallback';
import ExploreScreen from '@/components/custom/explore/ExploreScreen';

// Explore tab (route `around`) — routing only. Revealed in Wave 10 (N5).
export default function AroundTab() {
    return (
        <ErrorBoundary level="screen" FallbackComponent={FullScreenErrorFallback}>
            <ExploreScreen />
        </ErrorBoundary>
    );
}
