// PLACEHOLDER until L5's YouPages lands.
import ErrorBoundary from '@/components/custom/ErrorBoundary';
import { FullScreenErrorFallback } from '@/components/custom/ErrorFallback';
import ProfileTabScreen from '@/components/custom/config-panel/ProfileTabScreen';
import { useReportSurface } from '@/components/custom/nav/current-surface';
import { useRegisterTabStack } from '@/components/custom/nav/navigate-to-page';

export default function YouTab() {
  useRegisterTabStack('you');
  useReportSurface('profile');
  return (
    <ErrorBoundary level="screen" FallbackComponent={FullScreenErrorFallback}>
      <ProfileTabScreen />
    </ErrorBoundary>
  );
}
