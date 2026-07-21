import ErrorBoundary from '@/components/custom/ErrorBoundary';
import { FullScreenErrorFallback } from '@/components/custom/ErrorFallback';
import SwipeFeedScreen from '@/components/custom/swipe-feed/SwipeFeedScreen';

export default function FeedTab() {
    return (
        <ErrorBoundary level="screen" FallbackComponent={FullScreenErrorFallback}>
            <SwipeFeedScreen />
        </ErrorBoundary>
    );
}
