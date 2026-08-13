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
 */
const SECURE_STORE_KEYS = [
  `${APP_SLUG}_cookie`,
  `${APP_SLUG}_session_data`,
  `${APP_SLUG}_pin_record`,
  `${APP_SLUG}_pin_attempts`,
  `${APP_SLUG}_app_lock_enabled`,
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

  // Last, and allowed to throw: WatermelonDB (persona, facts, topics, saved
  // articles, reading history, tracked stories, notifications, settings KV) plus
  // every in-memory Zustand store and the E2EE attestation cache.
  const { clearAllStores } = require('@/lib/stores');
  await clearAllStores();
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
