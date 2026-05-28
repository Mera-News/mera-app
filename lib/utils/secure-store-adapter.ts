// SecureStore adapter that pins every keychain item to
// AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY. Default accessibility on iOS is
// WhenUnlocked, which makes items unreadable from background tasks whenever
// the device is locked — that's why silent-push wake-ups were silently
// failing on `getJwtToken` before this wrapper existed.
//
// AfterFirstUnlock = readable after the first post-boot unlock, even while
// currently locked. `ThisDeviceOnly` keeps tokens off iCloud Keychain sync.

import * as SecureStore from 'expo-secure-store';

const KEYCHAIN_OPTS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
};

export const secureStore = {
  // Async API — used by the app's own code.
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
  setItem: (key: string, value: string) =>
    SecureStore.setItem(key, value, KEYCHAIN_OPTS),
  getItem: (key: string) => SecureStore.getItem(key, KEYCHAIN_OPTS),
};