import ErrorBoundary from '@/components/custom/ErrorBoundary';
import { FullScreenErrorFallback } from '@/components/custom/ErrorFallback';
import { useRegisterTabStack } from '@/components/custom/nav/navigate-to-page';
import { ProfilePages } from '@/components/custom/you/YouPages';

export default function ProfileTab() {
  useRegisterTabStack('profile');
  return (
    <ErrorBoundary level="screen" FallbackComponent={FullScreenErrorFallback}>
      <ProfilePages />
    </ErrorBoundary>
  );
}
