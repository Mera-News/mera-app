// Sharing the Stats, pushed in the Library tab's stack from History's Share.
import ErrorBoundary from '@/components/custom/ErrorBoundary';
import { FullScreenErrorFallback } from '@/components/custom/ErrorFallback';
import ShareStatsScreen from '@/components/custom/share-stats/ShareStatsScreen';

export default function ShareStatsRoute() {
  return (
    <ErrorBoundary level="screen" FallbackComponent={FullScreenErrorFallback}>
      <ShareStatsScreen />
    </ErrorBoundary>
  );
}
