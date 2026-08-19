// Install-boundary reset (S10).
//
// The iOS keychain is an artifact that SURVIVES app uninstall — the same
// mechanism the deviceRef trial anchor deliberately relies on. That means the
// better-auth cookie also survives, and after a reinstall the app silently
// resumed the old session, skipping the welcome view entirely (and resuming
// into onboarding with a POP_TO_TOP warning).
//
// The app's OWN storage (the WatermelonDB settings table) dies with the
// uninstall, so a marker there detects the boundary: marker absent AND no
// local identity → this is a fresh-looking install, and any surviving
// keychain credentials are leftovers from a previous install.
//
// What happens at the boundary: the session cookie keys and the ACCOUNT
// credentials (attest keyId, device UUID) are cleared; `_device_ref` is
// PRESERVED — it is the device's trial history, and no flow may clear it.
// Consequence, deliberate and product-consistent: any user (email users
// included) who uninstalls and reinstalls lands signed out on the welcome
// view and signs back in. This is an install-boundary reset, not a silent
// logout — the never-silent-logout invariant guards MID-SESSION state, and
// after a reinstall the local identity is already gone (cached_user_id died
// with the app); the surviving cookie is the anomaly being corrected.
//
// UPDATE SAFETY: an app UPDATE keeps the settings table, so even installs
// predating the marker have `cached_user_id` and are left untouched — only
// a genuinely empty database triggers the reset. Fail-safe: any read error
// clears nothing and leaves the marker unwritten (retried next launch).

import Constants from 'expo-constants';

import logger from '@/lib/logger';
import { releaseAuthReadQuarantine } from '@/lib/security/install-boundary-latch';
import { secureStore } from '@/lib/utils/secure-store-adapter';

const APP_SLUG = Constants.expoConfig?.slug || 'app';

/** Settings-table marker whose ABSENCE (alongside an absent identity) marks a
 *  fresh install. Never in SecureStore — it must die with the uninstall. */
export const HAS_LAUNCHED_SETTING_KEY = 'has_launched';

// Cleared at the boundary. NEVER `${APP_SLUG}_device_ref` — trial history
// survives the boundary by design (it is what denies a second free trial).
const BOUNDARY_CLEARED_KEYS = [
  `${APP_SLUG}_cookie`,
  `${APP_SLUG}_session_data`,
  `${APP_SLUG}_appattest_key_id`,
  `${APP_SLUG}_device_attest_device_id`,
];

let enforcedThisProcess = false;
let resetThisProcess = false;

/** Whether THIS process performed the boundary reset. The launch gate must
 *  then ignore the session atom (it may hold a session fetched with the
 *  now-deleted cookie) and suppress login's session shortcut. */
export function wasInstallBoundaryReset(): boolean {
  return resetThisProcess;
}

/**
 * Run once per process, BEFORE any identity gate reads the keychain. Safe to
 * call on every launch pass — it latches, like purgeOrphanedLocalData.
 */
export async function enforceInstallBoundary(): Promise<void> {
  if (enforcedThisProcess) return;
  enforcedThisProcess = true;
  try {
    const { getSetting, setSetting } =
      require('@/lib/database/services/setting-service') as typeof import('@/lib/database/services/setting-service');

    if (await getSetting(HAS_LAUNCHED_SETTING_KEY)) return;

    // POSITIVELY absent identity only: a present cached_user_id means the
    // settings table survived — an app UPDATE, never a reinstall.
    const localUserId = await getSetting('cached_user_id');
    if (!localUserId) {
      let clearedAny = false;
      for (const key of BOUNDARY_CLEARED_KEYS) {
        try {
          if ((await secureStore.getItemAsync(key)) !== null) {
            await secureStore.deleteItemAsync(key);
            clearedAny = true;
          }
        } catch {
          // Unreadable slot (locked keychain): touch nothing. The marker
          // below still writes — a locked keychain on a genuinely fresh
          // install has nothing to clear anyway, and a transient lock must
          // not re-trigger the reset forever.
        }
      }
      if (clearedAny) {
        resetThisProcess = true;
        logger.warn('[install-boundary] cleared surviving credentials from a previous install', {
          cleared: true,
        });
      }
    }

    await setSetting(HAS_LAUNCHED_SETTING_KEY, '1');
  } catch (error) {
    // A failed read wipes nothing and blocks nothing; the next launch retries.
    logger.captureException(error, {
      tags: { service: 'install-boundary' },
    });
  } finally {
    // Release the sync-read quarantine on EVERY outcome, then poke the
    // session signal so better-auth's atom refetches against the
    // now-authoritative keychain: the quarantined first /get-session went out
    // cookie-less and answered null, and without this poke a normal launch
    // would sit signed-out-looking until some auth route happened to notify.
    releaseAuthReadQuarantine();
    try {
      const { authClient } = require('@/lib/auth-client') as {
        authClient: { $store?: { notify?: (signal: string) => void } };
      };
      authClient.$store?.notify?.('$sessionSignal');
    } catch {
      // Never block launch on the poke.
    }
  }
}

/** Test seam. */
export function __resetInstallBoundaryForTests(): void {
  enforcedThisProcess = false;
  resetThisProcess = false;
}
