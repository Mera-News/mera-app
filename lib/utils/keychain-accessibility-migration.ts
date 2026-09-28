// One-time re-save of the better-auth keychain items under
// AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY.
//
// The friction: `secure-store-adapter` pins every write to AfterFirstUnlock,
// but expo-secure-store only rewrites the VALUE when the key already exists
// (`SecItemAdd` -> errSecDuplicateItem -> `SecItemUpdate` of kSecValueData,
// node_modules/expo-secure-store/ios/SecureStoreModule.swift `set`/`update`).
// An item first written before the adapter existed therefore keeps the iOS
// default, WhenUnlocked, forever, and a background run on a locked phone
// cannot read the auth cookie. A DELETE followed by an ADD is the only way to
// change an item's accessibility through this library.
//
// Crash safety: the value is copied to a temporary key FIRST, so a kill between
// the delete and the re-add loses nothing; the next call restores it. Losing
// the cookie would be a silent logout, which this app never does.
//
// Call it on a real foreground, when no auth request is likely to be in
// flight. A sync better-auth read that lands in the few milliseconds between
// the delete and the re-add sees no cookie, sends a cookie-less request and
// persists nothing (the same outcome the install-boundary quarantine relies
// on), so the window is harmless, just not useful.

import { Platform } from 'react-native';
import Constants from 'expo-constants';
import { secureStore } from '@/lib/utils/secure-store-adapter';
import logger from '@/lib/logger';

/** KV marker. Bump the suffix only to force a second pass. */
export const KEYCHAIN_AFU_MIGRATION_KEY = 'keychain_afu_migration_v1';

// Same derivation as auth-client.ts's storagePrefix, which is module-private
// there; better-auth-expo writes `${prefix}_cookie` and `${prefix}_session_data`
// (see clearAuthStorage).
const APP_SLUG = Constants.expoConfig?.slug || 'app';

/** The items a background run reads to mint a JWT. The scoring run's private
 *  key is not listed: `clearPipeline` deletes it before every new run, so it is
 *  always a fresh ADD under the adapter's accessibility. */
export const MIGRATED_KEYCHAIN_KEYS = [
  `${APP_SLUG}_cookie`,
  `${APP_SLUG}_session_data`,
] as const;

const tmpKeyFor = (key: string): string => `${key}_afu_tmp`;

export type KeychainMigrationOutcome =
  | 'migrated'
  | 'already-done'
  | 'not-needed'
  | 'failed';

let inFlight: Promise<KeychainMigrationOutcome> | null = null;

async function readMarker(): Promise<string | null> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { getSetting } = require('@/lib/database/services/setting-service') as typeof import('@/lib/database/services/setting-service');
  return getSetting(KEYCHAIN_AFU_MIGRATION_KEY);
}

async function writeMarker(): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { setSetting } = require('@/lib/database/services/setting-service') as typeof import('@/lib/database/services/setting-service');
  await setSetting(KEYCHAIN_AFU_MIGRATION_KEY, String(Date.now()));
}

/** Put back a value a previous pass parked in its temporary key, then drop the
 *  temporary key. */
async function recoverParked(key: string): Promise<void> {
  const parked = await secureStore.getItemAsync(tmpKeyFor(key));
  if (parked === null) return;
  const current = await secureStore.getItemAsync(key);
  if (current === null) await secureStore.setItemAsync(key, parked);
  await secureStore.deleteItemAsync(tmpKeyFor(key));
}

async function resaveOne(key: string): Promise<void> {
  await recoverParked(key);
  const value = await secureStore.getItemAsync(key);
  if (value === null) return; // nothing stored, nothing to move
  await secureStore.setItemAsync(tmpKeyFor(key), value);
  // Re-read right before the delete: a response that rotated the cookie since
  // the first read must not be overwritten with the older value.
  const latest = (await secureStore.getItemAsync(key)) ?? value;
  await secureStore.deleteItemAsync(key);
  await secureStore.setItemAsync(key, latest);
  await secureStore.deleteItemAsync(tmpKeyFor(key));
}

async function run(): Promise<KeychainMigrationOutcome> {
  // Android ignores `keychainAccessible`; there is nothing to move.
  if (Platform.OS !== 'ios') return 'not-needed';
  try {
    if ((await readMarker()) !== null) return 'already-done';
    for (const key of MIGRATED_KEYCHAIN_KEYS) await resaveOne(key);
    await writeMarker();
    return 'migrated';
  } catch (err) {
    // A locked keychain or a DB hiccup: leave the marker unset and try again on
    // the next foreground. Any parked value is restored by that pass.
    logger.warn('[keychain-migration] re-save failed, will retry', {
      message: err instanceof Error ? err.message : String(err),
    });
    return 'failed';
  }
}

/**
 * Re-save the auth cookie and session cache under AfterFirstUnlock, once per
 * install (KV marker). Idempotent and single-flight; never throws.
 */
export function runKeychainAccessibilityMigration(): Promise<KeychainMigrationOutcome> {
  if (!inFlight) {
    inFlight = run().finally(() => {
      inFlight = null;
    });
  }
  return inFlight;
}
