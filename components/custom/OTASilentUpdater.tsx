import { useEffect } from 'react';
import { AppState, AppStateStatus } from 'react-native';
import * as Updates from 'expo-updates';

import { requestRestart } from '@/lib/app-restart';
import logger from '@/lib/logger';
import { isTransientNetworkError } from '@/lib/utils/transient-error';

/**
 * Fetches OTA updates and shows the user NOTHING. Renders null by design.
 *
 * OTA updates are silent. This component downloads the new bundle and, when the
 * fetch actually produced a NEW one, hands `requestRestart('ota')` to
 * `lib/app-restart.ts` so the user is on it immediately instead of waiting for
 * a cold start they may never perform. The restart itself is silent too: no
 * prompt, no banner, no toast, and every gate (active app state, a 10s floor,
 * live holds) lives in that module rather than here.
 *
 * DO NOT REINTRODUCE A PROMPT HERE. This used to be a tappable toast, then a
 * non-dismissible takeover modal (`OTAUpdateModal`, deleted) that fired on
 * `isUpdatePending` — which meant every publish, including a copy tweak,
 * interrupted every user and demanded a tap before they could carry on. The
 * escalation to a takeover was aimed at "users sit on stale JS", but the cost
 * landed on the wrong side: shipping a small fix became a user-visible event.
 * The restart closes that same gap with no user-visible event at all, which is
 * the whole point — it is not a licence to ask again.
 *
 * There is exactly ONE non-dismissible update surface left in the app, and it is
 * not this one: `NativeUpdateGate` -> `ForceUpdateScreen`, driven by the
 * server's `appVersionInfo.minSupportedVersion` floor. Blocking a user is a
 * store-version decision made server-side, not a per-OTA decision made here.
 *
 * GATE ON THE RESULT, NOT ON THE CALL RESOLVING. `UpdateFetchResult` is a union
 * and only `UpdateFetchResultSuccess` carries `isNew: true`; both the failure
 * and the `isRollBackToEmbedded` arms report `isNew: false`. Restarting because
 * `fetchUpdateAsync()` resolved would restart on every check that found nothing.
 *
 * This component checks on MOUNT, so it runs on every boot — which is why the
 * 10s floor in `lib/app-restart.ts` is seeded across the reload from the marker
 * rather than kept in module state. Without that, a bundle that keeps fetching
 * as new restarts on every boot with nothing to stop it.
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
        if (!result.isAvailable) return;
        const fetched = await Updates.fetchUpdateAsync();
        // Only the success arm of the union sets this.
        if (fetched.isNew) {
          await requestRestart('ota');
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
