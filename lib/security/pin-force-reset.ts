// One-shot: clear the PIN gate on every device, once.
//
// WHY THIS EXISTS. app/login.tsx's reauth handler sent EVERY same-user
// re-authentication to /pin-setup, not just the Forgot-PIN one it was written
// for (see that file, and mera-app-persona invariant 7). So any user who tapped
// the "Sign in again to sync" banner was walked into a PIN enrolment they never
// asked for, and completing it persisted the opt-in flag — after which the
// launch gate legitimately locked them out of their own app on every cold start.
//
// A wrongly-enrolled device is locally INDISTINGUISHABLE from a deliberate
// opt-in: both are just `_app_lock_enabled = '1'` plus a record. There is no
// field that says which, so there is no targeted migration to write. The
// decision (product, 2026-09-17) is therefore to reset everyone once and let
// Settings → Security be the only surface that ever turns the lock back on.
// This does turn the lock off for users who genuinely chose it; that is the
// accepted cost of not being able to tell the two apart.
//
// Silent by design — mera-app-persona invariant 13 forbids a prompt, banner or
// toast for an OTA-delivered change.
//
// ORDERING IS LOAD-BEARING, twice over:
//   - The marker is stamped LAST, so a keychain write failure leaves the reset
//     un-marked and it retries on the next launch rather than recording a reset
//     that never happened.
//   - An unreadable marker ABORTS rather than resetting. Treating a failed read
//     as "not yet reset" would re-run this on every launch the keychain is
//     briefly unreadable, destroying a PIN the user deliberately set after the
//     reset. Doing nothing costs one more launch; guessing costs their PIN.

import Constants from 'expo-constants';
import { secureStore } from '../utils/secure-store-adapter';
import { setAppLockEnabled } from './app-lock-service';
import { clearPin } from './pin-service';
import logger from '../logger';

const APP_SLUG = Constants.expoConfig?.slug || 'app';
const PIN_FORCE_RESET_KEY = `${APP_SLUG}_pin_force_reset_v1`;

/**
 * Idempotent. Safe to call on every launch; does real work at most once per
 * install. Never throws — a failure here must not block the launch gate, and
 * the caller (pin-store.init) fails open to "lock off" anyway.
 */
export async function runPinForceResetOnce(): Promise<void> {
  let alreadyReset: string | null;
  try {
    alreadyReset = await secureStore.getItemAsync(PIN_FORCE_RESET_KEY);
  } catch (err) {
    // Unreadable keychain (pre-first-unlock background wake). Retry next launch.
    logger.addBreadcrumb('pin-force-reset: marker unreadable, deferring', 'pin', {
      message: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  if (alreadyReset) return;

  try {
    await clearPin();
    await setAppLockEnabled(false);
    await secureStore.setItemAsync(PIN_FORCE_RESET_KEY, '1');
    logger.addBreadcrumb('pin-force-reset: cleared the PIN gate', 'pin');
  } catch (err) {
    // Unstamped, so the next launch tries again.
    logger.captureException(err, {
      tags: { service: 'pin-force-reset', method: 'runPinForceResetOnce' },
    });
  }
}
