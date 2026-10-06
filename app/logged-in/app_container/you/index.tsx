import ErrorBoundary from '@/components/custom/ErrorBoundary';
import { FullScreenErrorFallback } from '@/components/custom/ErrorFallback';
import { useRegisterTabStack } from '@/components/custom/nav/navigate-to-page';
import { YouPages } from '@/components/custom/you/YouPages';

export default function YouTab() {
  useRegisterTabStack('you');
  return (
    <ErrorBoundary level="screen" FallbackComponent={FullScreenErrorFallback}>
      <YouPages />
    </ErrorBoundary>
  );
}
