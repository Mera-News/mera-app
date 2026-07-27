// The user's opt-in preference for the local PIN gate (see pin-service.ts).
//
// The PIN used to be mandatory: "a PIN record exists" WAS "the PIN is
// enforced", and the launch gate pushed every identified user without one into
// a setup screen they could not escape. The lock is now opt-in — off unless the
// user turns it on in Settings → Security — and this flag is what carries that
// preference.
//
// ABSENT KEY ⇒ FALSE, deliberately. That default is what makes the lock opt-in
// for users who already set a PIN under the old mandatory flow: they have a
// record but no flag, so they read as "off" on the first launch after this
// ships, with no migration step and no version marker to maintain. (Note this
// is the opposite stance from a capability-style flag like biometrics, where an
// absent key means "never asked, default on" — here an absent key means "never
// opted in".)
//
// A read failure also resolves to false: the alternative is showing a PIN
// screen to someone who may have no usable PIN, which is an unrecoverable
// lockout. The lock protects on-device data that the OS keychain already
// guards, so failing open is the right trade.
//
// Invariant maintained by the callers (pin-store): flag off ⇒ no PIN record.
// Turning the lock off clears the record, and init() clears any record it finds
// while the flag is off. Turning it back on always sets a FRESH PIN, so a stale
// hash can never be resurrected.

import Constants from 'expo-constants';
import { secureStore } from '../utils/secure-store-adapter';
import logger from '../logger';

const APP_SLUG = Constants.expoConfig?.slug || 'app';
const APP_LOCK_ENABLED_KEY = `${APP_SLUG}_app_lock_enabled`;

/** Whether the user has opted into the PIN gate. Absent / unreadable ⇒ false. */
export async function isAppLockEnabled(): Promise<boolean> {
  const start = Date.now();
  try {
    const raw = await secureStore.getItemAsync(APP_LOCK_ENABLED_KEY);
    const enabled = raw === '1';
    logger.info(
      `[pin-timing] isAppLockEnabled read=${Date.now() - start}ms result=${enabled}`,
    );
    return enabled;
  } catch (err) {
    logger.captureException(err, {
      tags: { service: 'app-lock-service', method: 'isAppLockEnabled' },
    });
    return false;
  }
}

/**
 * Persist the preference. Throws on a storage failure so the caller can leave
 * the switch where it was rather than reporting a state it failed to save.
 */
export async function setAppLockEnabled(enabled: boolean): Promise<void> {
  const start = Date.now();
  await secureStore.setItemAsync(APP_LOCK_ENABLED_KEY, enabled ? '1' : '0');
  logger.info(
    `[pin-timing] setAppLockEnabled write=${Date.now() - start}ms enabled=${enabled}`,
  );
}
