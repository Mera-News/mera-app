import ErrorBoundary from '@/components/custom/ErrorBoundary';
import { FullScreenErrorFallback } from '@/components/custom/ErrorFallback';
import { useRegisterTabStack } from '@/components/custom/nav/navigate-to-page';
import { WorldPages } from '@/components/custom/world/WorldPages';

export default function WorldTab() {
  useRegisterTabStack('world');
  return (
    <ErrorBoundary level="screen" FallbackComponent={FullScreenErrorFallback}>
      <WorldPages />
    </ErrorBoundary>
  );
}
