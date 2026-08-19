// Complete erasure of on-device user state, and the launch-time resume check
// that finishes an interrupted one.
//
// THE RULE (owner, 2026-08-05): offline mode is served IF AND ONLY IF the local
// credentials have NOT been cleared. Logout clears them, so after a logout there
// is no offline mode, no cached data, and no way back into the app without
// signing in. A dead *server* session is the opposite case — credentials are
// still on the device, and that user keeps working offline (see
// lib/security/launch-route.ts).
//
// Why this module exists rather than three call sites doing it by hand: "erase
// everything local" was previously spread across clearAuthStorage() (2 keychain
// keys + RevenueCat), usePinStore.setLockEnabled(false) (the PIN record), and
// clearAllStores() (WatermelonDB + Zustand) — with nothing at all covering the
// E2EE pipeline private key. The bug this fixes is precisely that the set was
// incomplete, and there are now TWO callers that need the identical complete
// erasure: explicit logout, and the launch-time resume below. One list, one
// place.

import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';
import logger from '@/lib/logger';
import { secureStore } from '@/lib/utils/secure-store-adapter';

const APP_SLUG = Constants.expoConfig?.slug || 'app';

/**
 * Every keychain item that holds user state. Slug-scoped keys first, then the
 * two fixed-name E2EE secrets.
 *
 * - `_cookie` / `_session_data` — better-auth's session (also cleared by
 *   clearAuthStorage(); repeated here so this list stands alone).
 * - `_pin_record` / `_pin_attempts` — the local PIN gate (pin-service.ts).
 * - `_app_lock_enabled` — the PIN opt-in flag. DELETED rather than set to '0':
 *   app-lock-service.ts documents absent ⇒ false, so the two are equivalent and
 *   deleting keeps this list uniform.
 * - `async_pipeline_privkey` — the E2EE private key for the in-flight scoring
 *   run (scoring-pipeline-store.ts). This one survived logout entirely before
 *   this module existed.
 * - `async_inference_pending_job_privkey` — its legacy single-slot predecessor.
 * - `_backup_key` — the backup recovery code, which IS the key that decrypts
 *   every blob this device has uploaded. Leaving it would let the next user on
 *   the device open the previous user's cloud backups. Clearing it is also why
 *   `adoptRecoveryCode` exists: after a re-login the cloud still holds blobs the
 *   device can no longer read, and typing the code back in is the way home.
 *
 * DELIBERATELY ABSENT (S10): the device sign-in credentials
 * (`_appattest_key_id`, `_device_attest_device_id`, `_device_ref`). They
 * SURVIVE every sign-out flavor so that logging in again resumes the SAME
 * account — the device is the account's credential by design. Only account
 * DELETION and the refusal recovery sever them, via
 * `clearDeviceAuthCredentials()` (lib/device-auth.ts). Logout still wipes all
 * local DATA; only the server-side binding survives.

 */
const SECURE_STORE_KEYS = [
  `${APP_SLUG}_cookie`,
  `${APP_SLUG}_session_data`,
  `${APP_SLUG}_pin_record`,
  `${APP_SLUG}_pin_attempts`,
  `${APP_SLUG}_app_lock_enabled`,
  `${APP_SLUG}_backup_key`,
  'async_pipeline_privkey',
  'async_inference_pending_job_privkey',
];

/** The only AsyncStorage key the app has ever written (a since-deleted LLM
 *  capability token). Everything else lives in WatermelonDB or the keychain. */
const ASYNC_STORAGE_KEYS = ['mera.cycle.capabilityToken'];

/**
 * Tables whose presence means "a user's data is on this device". Deliberately
 * excludes `settings`: benign KV rows (feed order, importance thresholds) would
 * otherwise make a signed-out device look occupied forever.
 */
const USER_DATA_TABLES = [
  'facts',
  'user_personas',
  'saved_article_suggestions',
  'article_suggestions',
  'publication_visits',
  'tracked_stories',
];

/** Guards purgeOrphanedLocalData() to a single attempt per app process. */
let purgeAttempted = false;

/** Whether any user-owned rows survive on this device. */
export async function hasLocalUserData(): Promise<boolean> {
  const database = require('@/lib/database').default;
  for (const table of USER_DATA_TABLES) {
    try {
      const count = await database.get(table).query().fetchCount();
      if (count > 0) return true;
    } catch {
      // A table that cannot be counted tells us nothing; keep checking the
      // rest rather than claiming the device is clean.
    }
  }
  return false;
}

/**
 * Erase every byte of local user state.
 *
 * ORDER IS LOAD-BEARING: keychain and AsyncStorage FIRST, the database LAST.
 * The resume check below can only see the database, so a crash part-way through
 * must leave the DB still populated — that is what makes the next launch detect
 * the half-done wipe and finish it. Wiping the DB first would leave keychain
 * secrets behind with nothing left to signal that they are orphaned.
 *
 * Every step except the final one swallows its own failure: one unreadable
 * keychain item must not stop the database from being wiped.
 */
export async function wipeAllLocalUserData(): Promise<void> {
  for (const key of SECURE_STORE_KEYS) {
    try {
      await secureStore.deleteItemAsync(key);
    } catch (err) {
      logger.addBreadcrumb(
        'local-wipe: secure-store delete failed',
        'local-wipe',
        { key, message: err instanceof Error ? err.message : String(err) },
        'warning',
      );
    }
  }

  for (const key of ASYNC_STORAGE_KEYS) {
    try {
      await AsyncStorage.removeItem(key);
    } catch {
      // Legacy key; absence is the goal and a failure here is not actionable.
    }
  }

  // Back to an anonymous RevenueCat customer so the next signed-in user on this
  // device cannot inherit the previous one's entitlements.
  try {
    const { logoutRevenueCat } = require('@/lib/revenuecat');
    await logoutRevenueCat();
  } catch {
    // Never block the wipe on the billing SDK.
  }

  // And reset the support Messenger, so the next user on this device cannot
  // open Support and read the previous user's conversation — Intercom holds
  // identity natively and a JS sign-out does not touch it. clearAuthStorage()
  // does this too; both sign-out paths are independently complete by design
  // (see this file's header) and logoutIntercom() is idempotent.
  //
  // The guarded require shape matters more here than it looks:
  // purgeOrphanedLocalData() calls this function at LAUNCH on a device whose
  // logout was interrupted, so this runs before most of the app exists.
  try {
    const { logoutIntercom } = require('@/lib/intercom');
    await logoutIntercom();
  } catch {
    // Never block the wipe on the support SDK.
  }

  // And disconnect Google Drive, which holds a Google account natively for the
  // same reason Intercom does. Left connected, the next person signing in on
  // this device finds Drive backup already enabled against a stranger's account
  // and uploads their persona into it. clearAuthStorage() does this too; both
  // sign-out paths are independently complete by design, and the call is
  // idempotent.
  try {
    const { disconnectGoogleDrive } = require('@/lib/backup/providers/google-drive');
    await disconnectGoogleDrive();
  } catch {
    // Never block the wipe on the storage SDK.
  }

  // And drop the Sentry user id, so post-logout errors are not attributed to the
  // user who just left. clearAuthStorage() does this too — both sign-out paths
  // are independently complete by design (see this file's header), and the call
  // is idempotent, so the duplication is deliberate rather than redundant.
  try {
    const { applySentryUser } = require('@/lib/observability/sentry-scope');
    applySentryUser(null);
  } catch {
    // Never block the wipe on telemetry.
  }

  // The PIN store's in-memory copy of the flags we just deleted. Written via
  // setState rather than setLockEnabled(), which persists to the keychain and
  // THROWS on a write failure — that would abort the wipe right before the
  // database step.
  try {
    const { usePinStore } = require('@/lib/stores/pin-store');
    usePinStore.setState({
      pinSet: false,
      lockEnabled: false,
      locked: false,
      lastBackgroundedAt: null,
    });
  } catch {
    // In-memory only; the keychain records behind it are already gone.
  }

  // Staged backup files. This is the only part of the wipe that touches the
  // FILESYSTEM, and its absence was a real leak: a backup blob is the user's
  // whole persona in one file, and the wipe covered the keychain, AsyncStorage,
  // RevenueCat, Intercom, Sentry, the PIN store and the database while leaving
  // that file sitting in app storage for whoever signed in next.
  //
  // Deliberately BEFORE the database step, so the "DB last" ordering above
  // still holds: a crash here leaves the database populated, which is the
  // marker purgeOrphanedLocalData() reads to finish the job on the next launch.
  //
  // The blob is encrypted, but the recovery code is the user's and this is a
  // wipe — "an attacker would need the code" is not a reason to leave a
  // departed user's data on someone else's device.
  try {
    const { Directory, Paths } = require('expo-file-system');
    const {
      BACKUP_DOCUMENT_DIRECTORY,
      BACKUP_SCRATCH_DIRECTORY,
    } = require('@/lib/backup/types');
    for (const [root, name] of [
      [Paths.document, BACKUP_DOCUMENT_DIRECTORY],
      [Paths.cache, BACKUP_SCRATCH_DIRECTORY],
    ] as const) {
      try {
        const dir = new Directory(root, name);
        if (dir.exists) dir.delete();
      } catch (err) {
        logger.addBreadcrumb(
          'local-wipe: backup directory delete failed',
          'local-wipe',
          { name, message: err instanceof Error ? err.message : String(err) },
          'warning',
        );
      }
    }
  } catch {
    // expo-file-system unavailable (tests, or a launch so early the module is
    // not there). Never block the wipe on it.
  }

  // Last, and allowed to throw: WatermelonDB (persona, facts, topics, saved
  // articles, reading history, tracked stories, notifications, settings KV) plus
  // every in-memory Zustand store and the E2EE attestation cache.
  const { clearAllStores } = require('@/lib/stores');
  await clearAllStores();
}

/**
 * Sign out and erase, in the order that keeps the ESCAPE working even when the
 * erase does not.
 *
 * NAVIGATE BEFORE WIPING. This is the whole point of the function: the caller
 * that needs it most is the identity-switch failure screen, reached precisely
 * because `wipeAllLocalUserData()` already threw once. If the navigation waited
 * on the wipe, a second failure would strand the user on a screen whose only
 * two controls both lead through the thing that is broken. Sign-out proper runs
 * first (it is what makes the state self-healing on the next launch: absent
 * credentials with data on disk is the marker `purgeOrphanedLocalData` above
 * reads), then the route, then the erase.
 *
 * `signedOut: '1'` on the route is load-bearing: better-auth does not clear its
 * session atom synchronously on `signOut()`, and login.tsx would otherwise
 * shortcut on the stale session and bounce the user straight back in.
 *
 * Every step before the wipe is individually guarded, for the same reason the
 * logout path in AppPreferencesTab documents at length: past the point where
 * the cookie is gone, the device is half-signed-out and the flow must ALWAYS
 * reach the wipe. The wipe itself is allowed to throw, and the caller decides
 * what that means.
 *
 * NOTE: `components/custom/config-mera/AppPreferencesTab.tsx` performs this same
 * sequence inline for the explicit logout button. It is a second copy, and it is
 * the ordering this function was extracted FROM.
 */
export async function signOutAndWipe(): Promise<void> {
  try {
    // clearAuthStorage() owns the (guarded, bounded) server sign-out; a
    // direct authClient.signOut() before it would reject on an outage and
    // skip the cookie deletion, leaving the wipe below as the only cover.
    const { clearAuthStorage } = require('@/lib/auth-client');
    await clearAuthStorage();
  } catch (err) {
    logger.addBreadcrumb(
      'local-wipe: sign-out failed, continuing to the wipe',
      'local-wipe',
      { message: err instanceof Error ? err.message : String(err) },
      'warning',
    );
  }

  // Drop the identity sentinel BEFORE navigating. `cached_user_id` is what the
  // launch gate reads as "somebody lives here", and app/logged-in/index.tsx
  // re-writes it — so any gate that runs while the row survives routes back
  // into the app AND re-poisons the identity being cleared.
  try {
    const { deleteSetting } = require('@/lib/database/services/setting-service');
    await deleteSetting('cached_user_id');
  } catch {
    // Covered by the wipe below.
  }

  try {
    const { router } = require('expo-router');
    if (router.canDismiss?.()) router.dismissAll();
    router.replace({ pathname: '/login', params: { signedOut: '1' } });
  } catch (err) {
    // A failed navigation must not cancel the erase — the data leaving the
    // device is the more important half of this.
    logger.captureException(err, {
      tags: { service: 'local-wipe', method: 'signOutAndWipe' },
    });
  }

  // Yield a tick so the screens above unmount before their data disappears
  // underneath them.
  await new Promise((resolve) => setTimeout(resolve, 0));
  await wipeAllLocalUserData();
}

/**
 * Launch-time resume check. Credentials provably gone but user data still on
 * disk means a logout was interrupted between the two — the state the owner's
 * rule makes recoverable: the ABSENCE of credentials is itself the "wipe
 * pending" marker, so no extra flag has to be persisted (and no extra flag can
 * be lost).
 *
 * Only the 'absent' identity state may call this, never 'unknown' — see
 * launch-route.ts. Returns whether a wipe actually ran.
 *
 * Latched to once per process: the launch gate's effect keys on the better-auth
 * session atom, which changes at least twice on a cold start, and a database
 * reset per change would stall the login screen for nothing. A failure is not
 * retried within the process — the next launch finds the same orphaned state.
 */
export async function purgeOrphanedLocalData(): Promise<boolean> {
  if (purgeAttempted) return false;
  purgeAttempted = true;

  let orphaned = false;
  try {
    orphaned = await hasLocalUserData();
  } catch {
    return false;
  }
  if (!orphaned) return false;

  logger.info('[local-wipe] credentials absent but local user data present — finishing the interrupted logout');
  try {
    await wipeAllLocalUserData();
  } catch (err) {
    // Next launch will find the same orphaned state and try again.
    logger.captureException(err, { tags: { service: 'local-wipe', method: 'purgeOrphanedLocalData' } });
    return false;
  }
  return true;
}
