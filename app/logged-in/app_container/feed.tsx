import ErrorBoundary from '@/components/custom/ErrorBoundary';
import { FullScreenErrorFallback } from '@/components/custom/ErrorFallback';
import FeedScreen from '@/components/custom/feed/FeedScreen';

export default function FeedTab() {
    return (
        <ErrorBoundary level="screen" FallbackComponent={FullScreenErrorFallback}>
            <FeedScreen />
        </ErrorBoundary>
    );
}
