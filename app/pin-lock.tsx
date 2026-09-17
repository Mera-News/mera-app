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
        //
        // `reauth=pin`, NOT `reauth=1`. This is the ONLY producer permitted to
        // reach /pin-setup, and login.tsx keys the setup branch on that exact
        // value. The three other producers of a reauth (the needs-reauth
        // banner, and the identity gate in logged-in/index + onboarding) send
        // `1` and must never touch the PIN — they used to, which enrolled
        // users who had never opted in. See mera-app-persona invariant 7.
        onForgot={() => router.replace('/login?reauth=pin')}
      />
    </ErrorBoundary>
  );
}
