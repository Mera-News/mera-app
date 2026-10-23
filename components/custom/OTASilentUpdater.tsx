import { useEffect } from 'react';
import { AppState, AppStateStatus } from 'react-native';
import * as Updates from 'expo-updates';

import {
  autoReloadDisabled,
  captureResumeSpot,
  markOtaRestartAttempted,
  otaRestartAlreadyAttempted,
  requestRestart,
  restartWouldReload,
} from '@/lib/app-restart';
import logger from '@/lib/logger';
import { isTransientNetworkError } from '@/lib/algorithms/transient-error';
import { noticeAppliedUpdate, noticePendingUpdate, readyUpdateId } from '@/lib/ota-notice';
import { BACKGROUND_LOCK_THRESHOLD_MS, shouldLockAfterBackground, usePinStore } from '@/lib/stores/pin-store';

/**
 * Fetches OTA updates, tells the reader, and applies one by itself only when
 * the reader can be put back exactly where they were. Renders null.
 *
 * A DOWNLOAD NEVER RELOADS. A check runs on mount and on every true return;
 * when it downloads something the reader is told (`lib/ota-notice.ts`: toast
 * once per update id plus the `update_available` row) and nothing moves. The
 * reload that used to follow a download finishing during a return dropped the
 * reader on the startup tab seconds after they came back.
 *
 * THE ONE AUTOMATIC RELOAD is decided at the instant of a true return, from
 * local state only (no network, no awaited fetch): an update downloaded BEFORE
 * this return, a spot captured at the departure (`captureResumeSpot`, null
 * when the place cannot be rebuilt), no hold (`restartWouldReload('ota')`
 * includes the auto-only holds: sheets, dialogs, the chat panel), no PIN lock
 * possible on the reload, no restore failed earlier this session, and this
 * update's one attempt unspent. Then the spot rides in the restart marker and
 * the launch gate rebuilds it. Otherwise the reader is told (if not yet) and the
 * update waits for the next return, a Restart tap or the next cold start.
 *
 * AT MOST ONE AUTOMATIC RELOAD PER UPDATE ID (`markOtaRestartAttempted`,
 * awaited before the request because a write after `reloadAsync()` never
 * runs): it bounds a bundle that reloads and fails to launch.
 *
 * A RETURN ON ITS OWN IS NOT A REASON TO RESTART (owner, production): nothing
 * here may restart a reader who already runs the current bundle.
 *
 * THE NOTICE NEVER BLOCKS. `NativeUpdateGate` -> `ForceUpdateScreen` is the
 * app's only non-dismissible update surface.
 *
 * ARMS ON `background` ONLY, NEVER `!== 'active'`. iOS reports `inactive` for
 * the app switcher, a notification banner pulled down and Control Centre, and
 * none of those is a departure. An `inactive` on the way OUT is part of the
 * normal iOS departure and must not disarm what follows.
 *
 * Route blocking and the holds live in `lib/app-restart.ts`, applied to every
 * reason. They are not this file's business and must not be duplicated here.
 *
 * Confirm a rollout through Sentry: every event carries `ota_update_id` /
 * `ota_channel` / `runtime_version` from `lib/observability/app-context.ts`.
 */

/**
 * Slack on the PIN threshold: the reload's boot decides the lock again a moment
 * later against the same departure stamp, and a return just under the
 * threshold must not become a lock screen over the rebuilt spot.
 */
const PIN_LOCK_MARGIN_MS = 30_000;

/**
 * Whether the reload could land on the PIN lock. An undecided gate (not read
 * yet, or deferred from the background) counts as "could": the lock screen
 * replaces the stack, so the rebuilt spot would be thrown away.
 */
function pinLockPossible(departedAt: number | null): boolean {
  const pin = usePinStore.getState();
  if (!pin.initialized || pin.unresolved || pin.locked) return true;
  if (departedAt == null) return true;
  return shouldLockAfterBackground(
    departedAt - PIN_LOCK_MARGIN_MS,
    Date.now(),
    pin.pinSet,
    pin.lockEnabled,
  );
}

/**
 * Whether a fetch result is the success arm of the union. `isNew` is NOT a
 * comparison against the running bundle: natively it is hardcoded `true` on the
 * loader's success arm, so it means "a download completed".
 */
function fetchedSomethingNew(result: Updates.UpdateFetchResult): result is Updates.UpdateFetchResultSuccess {
  return result.isNew === true;
}

/** Check, download, tell. Never reloads. */
async function checkAndFetch(): Promise<void> {
  try {
    const result = await Updates.checkForUpdateAsync();
    const fetched = result.isAvailable ? await Updates.fetchUpdateAsync() : null;
    const fetchedNew = fetched != null && fetchedSomethingNew(fetched);

    // THE DISJUNCTION, and both arms are load-bearing. `fetchUpdateAsync()`
    // writes nothing to `latestContext`; a later native event does. `isNew`
    // catches a download that completed on this check before that event;
    // `isUpdatePending` catches one downloaded in an earlier session.
    const context = Updates.latestContext;
    if (!fetchedNew && !context?.isUpdatePending) return;
    // The fetch result's manifest first: the context may not have caught up.
    const updateId = (fetchedNew ? fetched.manifest?.id : undefined) ?? context?.downloadedManifest?.id;
    if (!updateId) {
      logger.debug('[ota] pending update with no id, leaving it for the next cold start');
      return;
    }
    await noticePendingUpdate(updateId);
  } catch (error) {
    // Best-effort: a lost connection is expected on mobile and recovers on the
    // next return. Only genuinely unexpected failures are reported.
    if (isTransientNetworkError(error)) return;
    logger.captureException(error as Error, {
      tags: { component: 'OTASilentUpdater', method: 'checkForUpdate' },
    });
  }
}

export default function OTASilentUpdater() {
  useEffect(() => {
    if (!Updates.isEnabled || __DEV__) return;

    // After the applied-update row, which replaces `update_available`: the
    // other order could delete the row this check is about to write. On mount
    // a check never reloads: expo-updates launches a downloaded bundle at the
    // next cold start, and a launch has no spot to rebuild.
    void noticeAppliedUpdate().then(() => checkAndFetch());

    let departedAt: number | null = null;
    let departureSpot: unknown = null;

    const onReturn = async (spot: unknown, since: number | null) => {
      const id = readyUpdateId();
      if (id) {
        const reload =
          spot != null &&
          !autoReloadDisabled() &&
          !pinLockPossible(since) &&
          !(await otaRestartAlreadyAttempted(id)) &&
          // Last, after the await: the gate as close to the request as possible.
          restartWouldReload('ota');
        if (reload) {
          await markOtaRestartAttempted(id);
          await requestRestart('ota', { spot });
          return;
        }
        // Told once per id; a reader who left before the download finished
        // gets the toast now.
        await noticePendingUpdate(id);
      }
      await checkAndFetch();
    };

    const handleAppStateChange = (state: AppStateStatus) => {
      if (state === 'background') {
        departedAt = Date.now();
        departureSpot = captureResumeSpot();
        return;
      }
      if (state !== 'active' || departedAt == null) return;
      // Every return clears the departure: a spot is only ever the one this
      // return came back to.
      const spot = departureSpot;
      const since = departedAt;
      departureSpot = null;
      departedAt = null;
      void onReturn(spot, since);
    };

    const subscription = AppState.addEventListener('change', handleAppStateChange);
    return () => subscription.remove();
  }, []);

  return null;
}
