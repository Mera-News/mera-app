// SecureStore adapter that pins every keychain item to
// AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY. Default accessibility on iOS is
// WhenUnlocked, which makes items unreadable from background tasks whenever
// the device is locked — that's why silent-push wake-ups were silently
// failing on `getJwtToken` before this wrapper existed.
//
// AfterFirstUnlock = readable after the first post-boot unlock, even while
// currently locked. `ThisDeviceOnly` keeps tokens off iCloud Keychain sync.

import * as SecureStore from 'expo-secure-store';
import logger from '@/lib/logger';
import { isAuthReadQuarantined } from '@/lib/security/install-boundary-latch';

const KEYCHAIN_OPTS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
};

export const secureStore = {
  // Async API — used by the app's own code. Deliberately left UNGUARDED here:
  // every call site already distinguishes "transient keychain error" (retry
  // later) from "key genuinely absent" (safe to treat as logged-out/cleared),
  // e.g. scoring-pipeline-store.ts's getPipeline() only wipes the persisted
  // run when the read resolves to null, but leaves it alone and retries later
  // when the read *rejects*. Swallowing errors here would collapse that
  // distinction and turn a locked keychain into a destructive "wipe" trigger.
  // Confirmed via lib/utils/__tests__/secure-store-adapter.test.ts, which
  // asserts these three propagate rejections.
  getItemAsync: (key: string) => SecureStore.getItemAsync(key, KEYCHAIN_OPTS),
  setItemAsync: (key: string, value: string) =>
    SecureStore.setItemAsync(key, value, KEYCHAIN_OPTS),
  deleteItemAsync: (key: string) =>
    SecureStore.deleteItemAsync(key, KEYCHAIN_OPTS),

  // Sync aliases — satisfy the better-auth expoClient storage contract
  // ({ setItem, getItem }). expo-secure-store exposes synchronous
  // `getItem`/`setItem` on iOS/Android that block the JS thread on native
  // keychain access. Better-auth only stores tiny session metadata so the
  // cost is negligible.
  //
  // Unlike the async API above, these are bare passthroughs with no try/catch
  // of their own — and better-auth's expoClient calls them with none either.
  // The keychain is pinned to AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY (see file
  // header), so a post-reboot background wake (silent push, background
  // fetch) before the device's first unlock throws synchronously straight
  // into better-auth (Sentry MERA-APP-5J). better-auth's storage contract has
  // no way to express "temporarily unavailable" — only null ("nothing
  // stored") — so a locked keychain must degrade to that same "no cached
  // session" outcome rather than an uncaught exception. That's a safe
  // degrade for the sync path specifically: better-auth's own consumers
  // already treat a missing cookie/session as "not logged in yet, will
  // re-fetch" (see auth-client.ts), not as a destructive wipe.
  setItem: (key: string, value: string) => {
    try {
      SecureStore.setItem(key, value, KEYCHAIN_OPTS);
    } catch (err) {
      logger.addBreadcrumb(
        'secureStore.setItem threw (keychain locked?) — write dropped',
        'secure-store-adapter',
        { key, message: err instanceof Error ? err.message : String(err) },
        'warning',
      );
    }
  },
  getItem: (key: string) => {
    // Install-boundary quarantine (S12): until the boundary has decided,
    // sync reads of the auth/device keys answer null so the launch-time
    // /get-session cannot race the boundary's deletes and re-persist a
    // previous install's session. See install-boundary-latch.ts.
    if (isAuthReadQuarantined(key)) return null;
    try {
      return SecureStore.getItem(key, KEYCHAIN_OPTS);
    } catch (err) {
      logger.addBreadcrumb(
        'secureStore.getItem threw (keychain locked?) — returning null',
        'secure-store-adapter',
        { key, message: err instanceof Error ? err.message : String(err) },
        'warning',
      );
      return null;
    }
  },
};