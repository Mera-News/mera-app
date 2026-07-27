import ErrorBoundary from '@/components/custom/ErrorBoundary';
import { FullScreenErrorFallback } from '@/components/custom/ErrorFallback';
import PinSetupScreen from '@/components/custom/auth/PinSetupScreen';
import { usePinStore } from '@/lib/stores/pin-store';
import { router } from 'expo-router';

// Replace a forgotten PIN. Now that the lock is opt-in, this route is reached
// only from Forgot PIN → OTP reauth (app/login.tsx): the old record has just
// been cleared but the user's opt-in still stands, so a new PIN is set and the
// lock stays on. Cancelling turns the lock off rather than trapping the user in
// a setup screen — the whole point of the lock being optional.
export default function PinSetup() {
  const finish = (lockEnabled: boolean) => {
    void usePinStore
      .getState()
      .setLockEnabled(lockEnabled)
      .finally(() => router.replace('/logged-in'));
  };

  return (
    <ErrorBoundary level="screen" FallbackComponent={FullScreenErrorFallback}>
      <PinSetupScreen onComplete={() => finish(true)} onCancel={() => finish(false)} />
    </ErrorBoundary>
  );
}
