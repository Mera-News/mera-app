import { useEffect } from 'react';
import { AppState, AppStateStatus } from 'react-native';
import * as Updates from 'expo-updates';

import logger from '@/lib/logger';
import { isTransientNetworkError } from '@/lib/utils/transient-error';

/**
 * Fetches OTA updates and shows the user NOTHING. Renders null by design.
 *
 * OTA updates are silent. This component downloads the new bundle; expo-updates
 * launches it at the user's next cold start (`EXUpdatesCheckOnLaunch=ALWAYS` /
 * `EXPO_UPDATES_CHECK_ON_LAUNCH=ALWAYS`, both already set in the native config).
 * No banner, no toast, no modal.
 *
 * DO NOT REINTRODUCE A PROMPT HERE. This used to be a tappable toast, then a
 * non-dismissible takeover modal (`OTAUpdateModal`, deleted) that fired on
 * `isUpdatePending` — which meant every publish, including a copy tweak,
 * interrupted every user and demanded a tap before they could carry on. The
 * escalation to a takeover was aimed at "users sit on stale JS", but the cost
 * landed on the wrong side: shipping a small fix became a user-visible event.
 *
 * There is exactly ONE non-dismissible update surface left in the app, and it is
 * not this one: `NativeUpdateGate` -> `ForceUpdateScreen`, driven by the
 * server's `appVersionInfo.minSupportedVersion` floor. Blocking a user is a
 * store-version decision made server-side, not a per-OTA decision made here.
 *
 * The trade is deliberate and known: a user who never force-quits stays on an
 * older bundle for longer. A timed background `reloadAsync()` would close that
 * gap but would make this the THIRD uncoordinated reload caller (language change
 * in `LanguageSettingsScreen`, post-restore in `BackupRecoveryFlow`), so it is
 * out of scope until something actually needs it.
 *
 * Since nothing is user-visible anymore, confirm a rollout through Sentry: every
 * event carries `ota_update_id` / `ota_channel` / `runtime_version` from
 * `lib/observability/app-context.ts`.
 */
export default function OTASilentUpdater() {
  useEffect(() => {
    if (!Updates.isEnabled || __DEV__) return;

    const checkForUpdate = async () => {
      try {
        const result = await Updates.checkForUpdateAsync();
        if (result.isAvailable) {
          await Updates.fetchUpdateAsync();
        }
      } catch (error) {
        // The OTA check is best-effort — a timed-out / lost connection is
        // expected on mobile and recovers on the next foreground. Don't report
        // those (they were noisy `error`s); only surface genuinely unexpected
        // failures.
        if (isTransientNetworkError(error)) return;
        logger.captureException(error as Error, {
          tags: { component: 'OTASilentUpdater', method: 'checkForUpdate' },
        });
      }
    };

    // CHECK ON MOUNT, not only on the next foreground.
    //
    // `AppState.addEventListener('change', …)` fires on a TRANSITION. At mount
    // the app is already `active`, so no transition happens and this effect
    // registered a listener that would not fire until the user backgrounded the
    // app and came back. An app left open — the normal case for someone using
    // it — never checked at all, and a freshly published update reached that
    // device only via expo-updates' own launch-time check on the NEXT cold
    // start. With the update now silent this matters MORE, not less: the mount
    // check is what gets the bundle downloaded in time for that cold start.
    checkForUpdate();

    const handleAppStateChange = (state: AppStateStatus) => {
      if (state === 'active') {
        checkForUpdate();
      }
    };

    const subscription = AppState.addEventListener('change', handleAppStateChange);
    return () => subscription.remove();
  }, []);

  return null;
}
