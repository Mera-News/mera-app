import { useEffect } from 'react';
import { AppState, AppStateStatus } from 'react-native';
import * as Updates from 'expo-updates';

import {
  markOtaRestartAttempted,
  otaRestartAlreadyAttempted,
  requestRestart,
  restartWouldReload,
} from '@/lib/app-restart';
import logger from '@/lib/logger';
import { isTransientNetworkError } from '@/lib/utils/transient-error';

/**
 * Fetches OTA updates and shows the user NOTHING. Renders null by design.
 *
 * This is the whole OTA lifecycle: when to look, and when a downloaded bundle is
 * worth a restart. It is the app's only restart trigger that fires on its own.
 *
 * WHAT IT DOES, AND THE TWO CASES ARE DIFFERENT
 *   - ON MOUNT: check and fetch, and NEVER restart. expo-updates already
 *     launches a downloaded update at the next cold start via its own
 *     launch-time check, so reloading seconds into a launch buys nothing — and
 *     it is the one restart that can land on a credential screen during
 *     onboarding. Mounting is also when a device that stays open all day does
 *     its only check, which is why the fetch still happens here.
 *   - ON A TRUE `background` -> `active` RETURN: check, fetch, and restart only
 *     if an update is actually downloaded and pending.
 *
 * A RETURN ON ITS OWN IS NOT A REASON TO RESTART. The app briefly reloaded on
 * every true return whether or not anything had changed, and the owner rejected
 * it in production: "the app refreshes every time it's foregrounded, even if
 * it's at the latest version". Nothing here may restart a reader who is already
 * on the current bundle.
 *
 * DO NOT REINTRODUCE A PROMPT HERE. This used to be a tappable toast, then a
 * non-dismissible takeover modal (`OTAUpdateModal`, deleted) that fired on
 * `isUpdatePending` — which meant every publish, including a copy tweak,
 * interrupted every user and demanded a tap before they could carry on. The
 * restart is the silent version of closing that gap, and it is not a licence to
 * ask again. There is exactly ONE non-dismissible update surface left in the app
 * and it is not this one: `NativeUpdateGate` -> `ForceUpdateScreen`, driven by
 * the server's `appVersionInfo.minSupportedVersion` floor.
 *
 * ARMS ON `background` ONLY, NEVER `!== 'active'`. iOS reports `inactive` for
 * the app switcher, a notification banner pulled down and a Control Centre
 * swipe, and none of those is a departure — arming on them would restart a user
 * who never left, mid-tap. `lib/subscriptions/subscribe-flow.ts` draws the same
 * line for the same reason. Note an `inactive` on the way OUT is part of the
 * normal iOS departure sequence and must not disarm what follows.
 *
 * Route blocking and the holds live in `lib/app-restart.ts`, applied to every
 * reason. They are not this file's business and must not be duplicated here.
 *
 * Since nothing is user-visible, confirm a rollout through Sentry: every event
 * carries `ota_update_id` / `ota_channel` / `runtime_version` from
 * `lib/observability/app-context.ts`.
 */

/**
 * Whether a fetch result is the success arm of the union.
 *
 * `UpdateFetchResult` has three arms and only `UpdateFetchResultSuccess` carries
 * `isNew: true`; the failure arm and the `isRollBackToEmbedded` arm both report
 * false. Gating on "the call resolved" would restart on every check that found
 * nothing.
 *
 * `isNew` is NOT a comparison against the running bundle, despite its docstring:
 * natively it is hardcoded `true` on the loader's success arm
 * (`UpdatesModule.swift` / `UpdatesModule.kt`). So it means "a download
 * completed", which is why it is only one half of the gate below.
 */
function fetchedSomethingNew(result: Updates.UpdateFetchResult): boolean {
  return result.isNew === true;
}

export default function OTASilentUpdater() {
  useEffect(() => {
    if (!Updates.isEnabled || __DEV__) return;

    /**
     * @param mayRestart false on the mount check. See the header.
     */
    const checkForUpdate = async (mayRestart: boolean) => {
      try {
        const result = await Updates.checkForUpdateAsync();
        let fetchedNew = false;
        if (result.isAvailable) {
          fetchedNew = fetchedSomethingNew(await Updates.fetchUpdateAsync());
        }
        if (!mayRestart) return;

        // THE DISJUNCTION, and both arms are load-bearing.
        //
        // `fetchUpdateAsync()` awaits the native module and returns its result
        // directly; NOTHING on that path writes `latestContext`. The context is
        // written only by a separate asynchronous native event
        // (`Expo.nativeUpdatesStateChangeEvent`), which is additionally dropped
        // when its sequence number is not ahead of the last one. So the context
        // is eventually correct, not synchronously correct.
        //
        //   - `isNew` catches a download that completed on THIS transition,
        //     before that event landed.
        //   - `isUpdatePending` catches an update downloaded in an EARLIER
        //     session that never launched. It is already pending at boot and
        //     needs no new fetch, so the `isNew` arm never sees it.
        //
        // No JS test can pin the ordering between them — the state machine is
        // native — which is exactly why this is an OR and not a choice.
        const context = Updates.latestContext;
        if (!fetchedNew && !context?.isUpdatePending) return;

        // AT MOST ONE RESTART PER UPDATE ID. The OTA check is the only restart
        // trigger left and it runs on every return, so a bundle that downloads,
        // reloads and fails to launch would otherwise restart on every return
        // for as long as it keeps downloading. The 10s floor spaces that cycle;
        // this is what bounds it. Both arms carry the id as `manifest.id` — on
        // the context it is `downloadedManifest`, not the `downloadedUpdate`
        // that `useUpdates()` exposes.
        const updateId = context?.downloadedManifest?.id;
        if (!updateId) {
          // Nothing to record an attempt against, so a restart here could not be
          // bounded. The update still launches at the next cold start.
          logger.debug('[ota] pending update with no id, leaving it for the next cold start');
          return;
        }
        if (await otaRestartAlreadyAttempted(updateId)) return;

        // ONE RELOAD PER BUNDLE — not one request per bundle.
        //
        // The guard bounds "reloaded and failed to launch". A request that was
        // BLOCKED never reloaded, so it cannot have failed to launch, and the
        // next return SHOULD try it again: by then the hold has cleared or the
        // reader has left the blocked route. Spending the attempt on it instead
        // stranded the bundle for the reader mid-chat-stream, mid-checkout or on
        // `/verify-otp` when the download finished — they would only ever get it
        // at a cold start, and the reader who never cold-starts is the whole
        // reason this exists.
        //
        // So mark only when it would genuinely reload. The mark is still AWAITED
        // and still BEFORE the request, because a write after `reloadAsync()`
        // never runs.
        //
        // `requestRestart` is called either way, so the blocker still reaches
        // the log and a simulator pass can see which gate stopped it.
        //
        // RESIDUAL RACE, weighed and accepted: a hold can appear between the
        // predicate and `reloadAsync()`, a few lines later, and that attempt is
        // consumed. Closing it would mean `requestRestart` reporting its own
        // outcome, which it cannot do on the path where it succeeds — the JS
        // context dies mid-call. The cost is one deferred update, not a lost
        // one: it still launches at the next cold start.
        if (restartWouldReload()) {
          await markOtaRestartAttempted(updateId);
        }
        await requestRestart('ota');
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
    // the app is already `active`, so no transition happens and a listener alone
    // would not fire until the user backgrounded the app and came back. An app
    // left open — the normal case for someone using it — would never check at
    // all, and a freshly published update would reach that device only via
    // expo-updates' own launch-time check on the NEXT cold start. The mount
    // check is what gets the bundle downloaded in time for that.
    void checkForUpdate(false);

    let armed = false;
    const handleAppStateChange = (state: AppStateStatus) => {
      if (state === 'background') {
        armed = true;
        return;
      }
      if (state !== 'active' || !armed) return;
      armed = false;
      void checkForUpdate(true);
    };

    const subscription = AppState.addEventListener('change', handleAppStateChange);
    return () => subscription.remove();
  }, []);

  return null;
}
