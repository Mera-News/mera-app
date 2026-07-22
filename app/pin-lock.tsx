import ErrorBoundary from '@/components/custom/ErrorBoundary';
import { FullScreenErrorFallback } from '@/components/custom/ErrorFallback';
import PinLockScreen from '@/components/custom/auth/PinLockScreen';
import { router } from 'expo-router';

export default function PinLock() {
  return (
    <ErrorBoundary level="screen" FallbackComponent={FullScreenErrorFallback}>
      <PinLockScreen
        onUnlock={() => router.replace('/logged-in')}
        // Forgot PIN → OTP re-login in reauth mode (proves identity to reset
        // the PIN); local data is preserved for the same user.
        onForgot={() => router.replace('/login?reauth=1')}
      />
    </ErrorBoundary>
  );
}
