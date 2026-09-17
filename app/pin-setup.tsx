import ErrorBoundary from '@/components/custom/ErrorBoundary';
import { FullScreenErrorFallback } from '@/components/custom/ErrorFallback';
import PinSetupScreen from '@/components/custom/auth/PinSetupScreen';
import { usePinStore } from '@/lib/stores/pin-store';
import { router } from 'expo-router';

// Replace a forgotten PIN. The old record has just been cleared but the user's
// opt-in still stands, so a new PIN is set and the lock stays on. Cancelling
// turns the lock off rather than trapping the user in a setup screen — the
// whole point of the lock being optional.
//
// The only sanctioned route in is Forgot PIN → `/login?reauth=pin` → OTP
// (app/login.tsx). An earlier version of this comment claimed that was the only
// way here FULL STOP; it was false for seven weeks. login.tsx branched on
// identity alone, so all four reauth producers landed here and the needs-reauth
// banner enrolled users who had never opted in. The claim is now enforced by
// the `reauth === 'pin'` check rather than asserted here — this route itself is
// still deliberately unguarded, because it renders a cancellable screen and a
// second gate would just be a copy of the real one that can drift from it.
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
