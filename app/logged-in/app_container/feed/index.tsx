import ErrorBoundary from '@/components/custom/ErrorBoundary';
import { FullScreenErrorFallback } from '@/components/custom/ErrorFallback';
import FeedScreen from '@/components/custom/feed/FeedScreen';
import { useReportSurface } from '@/components/custom/nav/current-surface';
import { useRegisterTabStack } from '@/components/custom/nav/navigate-to-page';

export default function FeedTab() {
  useRegisterTabStack('feed');
  useReportSurface('feed');
  return (
    <ErrorBoundary level="screen" FallbackComponent={FullScreenErrorFallback}>
      <FeedScreen />
    </ErrorBoundary>
  );
}
