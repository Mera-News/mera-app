import ErrorBoundary from '@/components/custom/ErrorBoundary';
import { FullScreenErrorFallback } from '@/components/custom/ErrorFallback';
import MeraNewsScreen from '@/components/custom/for-you/ForYouScreen';

export default function NewsTab() {
    return (
        <ErrorBoundary level="screen" FallbackComponent={FullScreenErrorFallback}>
            <MeraNewsScreen />
        </ErrorBoundary>
    );
}

