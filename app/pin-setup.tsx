import ErrorBoundary from '@/components/custom/ErrorBoundary';
import { FullScreenErrorFallback } from '@/components/custom/ErrorFallback';
import PinSetupScreen from '@/components/custom/auth/PinSetupScreen';
import { router } from 'expo-router';

// One-time mandatory PIN setup for identified users without a PIN record
// (existing users on first launch after this update; a user who quit before
// setting one). On completion the launch gate re-runs via /logged-in.
export default function PinSetup() {
  return (
    <ErrorBoundary level="screen" FallbackComponent={FullScreenErrorFallback}>
      <PinSetupScreen onComplete={() => router.replace('/logged-in')} />
    </ErrorBoundary>
  );
}
