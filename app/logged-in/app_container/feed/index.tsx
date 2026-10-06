import ErrorBoundary from '@/components/custom/ErrorBoundary';
import { FullScreenErrorFallback } from '@/components/custom/ErrorFallback';
import FeedPages from '@/components/custom/feed/FeedPages';
import { useRegisterTabStack } from '@/components/custom/nav/navigate-to-page';

export default function FeedTab() {
  useRegisterTabStack('feed');
  return (
    <ErrorBoundary level="screen" FallbackComponent={FullScreenErrorFallback}>
      <FeedPages />
    </ErrorBoundary>
  );
}
