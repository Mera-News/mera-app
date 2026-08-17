// Where the backup key lives between backups.
//
// **It has to be persisted, and that is a consequence of dropping the escrow.**
// A scheduled backup runs with nobody watching, so it cannot ask for a recovery
// code; the key must already be on the device. The keychain is the only place
// for it.
//
// **`AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY`, which `secureStore` pins for every
// item, is load-bearing twice over.** `AfterFirstUnlock` is what lets a
// background backup task read the key while the phone is locked. `ThisDeviceOnly`
// keeps it OFF iCloud Keychain sync — checked, not assumed. If it synced, a new
// device would silently be able to restore with no recovery code at all, which
// would quietly make the written-down code decorative and move the trust
// boundary to Apple. The code is the only cross-device path, deliberately.
//
// **The recovery code is stored, not just the key.** They are the same secret —
// the code IS the key in Crockford Base32 — so storing the string is no weaker,
// and it means a user who loses the paper can read it again from the device that
// made the backup. The alternative is a user permanently locked out of a backup
// by the very phone that wrote it, which protects nothing.
//
// The keychain item is cleared by `wipeAllLocalUserData()`, which lists it in
// SECURE_STORE_KEYS. That is what makes a re-login on the same device mint a
// NEW key while the cloud still holds blobs under the old one — survivable only
// because `adoptRecoveryCode` exists, and because the importer reports
// `wrong-key` before it touches any local data.

import Constants from 'expo-constants';

import { getSetting, setSetting, deleteSetting } from '@/lib/database/services/setting-service';
import { secureStore } from '@/lib/utils/secure-store-adapter';

import { decodeRecoveryCode, encodeRecoveryCode, generateBackupKey } from './crypto';

const APP_SLUG = Constants.expoConfig?.slug || 'app';

/** Slug-scoped so a renamed fork never reads this one's item. */
export const BACKUP_KEY_ITEM = `${APP_SLUG}_backup_key`;

/**
 * Settings row recording that the user has SEEN and acknowledged their recovery
 * code. `runBackup` refuses without it — see backup-service.ts for why the
 * ordering matters.
 */
export const RECOVERY_CODE_CONFIRMED_KEY = 'backup_recovery_code_confirmed';

/** The stored recovery code, or null when backup has never been set up. */
export async function getRecoveryCode(): Promise<string | null> {
  return secureStore.getItemAsync(BACKUP_KEY_ITEM);
}

/** The 32-byte key, or null. Decode failures return null rather than throwing. */
export async function getBackupKey(): Promise<Uint8Array | null> {
  const code = await getRecoveryCode();
  return code ? decodeRecoveryCode(code) : null;
}

/**
 * Mints a key if there is not one already, and returns the recovery code.
 *
 * Idempotent on purpose: calling it twice must not orphan every existing blob
 * by replacing a key that is still in use. Rotating is a separate, deliberate
 * act (`clearBackupKey` then this), not something a re-entered settings screen
 * can do by accident.
 */
export async function ensureBackupKey(): Promise<string> {
  const existing = await getRecoveryCode();
  if (existing) return existing;
  const code = encodeRecoveryCode(generateBackupKey());
  await secureStore.setItemAsync(BACKUP_KEY_ITEM, code);
  return code;
}

/**
 * Installs a key the user typed in, for "I already have a recovery code".
 *
 * This is the entry point that makes a re-login on the same device survivable:
 * logout wipes the keychain item, so without it the next setup would mint a new
 * key while the cloud still held blobs readable only by the old one.
 *
 * Returns false on an unusable code rather than throwing — every failure here
 * is a typo, and the caller's job is to say "that code isn't right".
 */
export async function adoptRecoveryCode(code: string): Promise<boolean> {
  const key = decodeRecoveryCode(code);
  if (!key) return false;
  // Re-encoded rather than stored verbatim, so what is persisted is canonical:
  // the user may have typed lowercase, no hyphens, or an `O` for a zero.
  await secureStore.setItemAsync(BACKUP_KEY_ITEM, encodeRecoveryCode(key));
  // An adopted code is by definition one the user already holds.
  await setSetting(RECOVERY_CODE_CONFIRMED_KEY, '1');
  return true;
}

/** Forgets the key on this device. Does not touch anything already uploaded. */
export async function clearBackupKey(): Promise<void> {
  await secureStore.deleteItemAsync(BACKUP_KEY_ITEM);
  await deleteSetting(RECOVERY_CODE_CONFIRMED_KEY);
}

export async function isRecoveryCodeConfirmed(): Promise<boolean> {
  return (await getSetting(RECOVERY_CODE_CONFIRMED_KEY)) === '1';
}

export async function markRecoveryCodeConfirmed(): Promise<void> {
  await setSetting(RECOVERY_CODE_CONFIRMED_KEY, '1');
}
