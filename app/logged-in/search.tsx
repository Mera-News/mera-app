import ErrorBoundary from '@/components/custom/ErrorBoundary';
import { FullScreenErrorFallback } from '@/components/custom/ErrorFallback';
import SearchScreen from '@/components/custom/world/SearchScreen';

// Full-screen search (opened from the World header). Routing only.
export default function SearchRoute() {
    return (
        <ErrorBoundary level="screen" FallbackComponent={FullScreenErrorFallback}>
            <SearchScreen />
        </ErrorBoundary>
    );
}
