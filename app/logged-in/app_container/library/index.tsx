import ErrorBoundary from '@/components/custom/ErrorBoundary';
import { FullScreenErrorFallback } from '@/components/custom/ErrorFallback';
import { LibraryPages } from '@/components/custom/library/LibraryPages';
import { useRegisterTabStack } from '@/components/custom/nav/navigate-to-page';

export default function LibraryTab() {
  useRegisterTabStack('library');
  return (
    <ErrorBoundary level="screen" FallbackComponent={FullScreenErrorFallback}>
      <LibraryPages />
    </ErrorBoundary>
  );
}
