import { AppState, type AppStateStatus } from 'react-native';

import { holdRestart } from '../app-restart';
import logger from '../logger';
import { isSecureUrl } from '../secure-url';
import type { appendReferrer, openInAppBrowser } from '../web-browser-utils';

/**
 * IMPORT DISCIPLINE, the same rule `lib/app-restart.ts` states for itself.
 *
 * `web-browser-utils` imports `app-language-store`, which imports
 * `setting-service`, which imports `lib/database/index.ts` — and that
 * constructs the WatermelonDB SQLite adapter AT IMPORT TIME. A static import
 * here therefore drags the native DB adapter into every suite that touches
 * this module, and it now has a second class of importer that has no business
 * with a browser at all: `holdRestartAcrossPurchase` is imported by checkout
 * surfaces. `present-free-tier-paywall.test.ts` failed exactly this way before
 * the require moved. The type-only import above is erased at compile time.
 */
function webBrowserUtils(): {
  appendReferrer: typeof appendReferrer;
  openInAppBrowser: typeof openInAppBrowser;
} {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('../web-browser-utils');
}

/**
 * Opening a publisher's own subscribe page, and knowing when the user came
 * back so the "Did you subscribe to X?" prompt can be asked.
 *
 * It also owns `holdRestartAcrossPurchase`, which is NOT about publishers: it
 * is the shared money-path hold every checkout surface takes. It lives here
 * because this module is the light one. Statically it pulls react-native,
 * app-restart, logger and secure-url, and nothing else (see the require note
 * above); the paywall module pulls RevenueCatUI, billing-service, the
 * subscription store, entitlement-sync, the activation toast and
 * last-known-tier. Putting the helper there and importing it from here would
 * drag RevenueCatUI into this suite, into
 * `components/custom/publication-preferences/use-subscribe-flow.ts` and into
 * the three surfaces that mount it. Heavy depends on light, never the reverse.
 */

/**
 * The subscribe URL with Mera's referrer attached.
 *
 * Deliberately `appendReferrer(uri, 'subscription')` rather than a second
 * URL builder: one builder, no per-publisher param schemes. That means a
 * subscribe link carries `utm_source` and `utm_medium=subscription` and
 * nothing else, and a URI that already has its own `utm_source` is left
 * untouched so we never clobber a publisher's own campaign tracking.
 */
export function buildSubscriptionUrl(uri: string): string {
  return webBrowserUtils().appendReferrer(uri, 'subscription');
}

/**
 * Opens the subscribe page, or returns false when the URI is unusable.
 *
 * The `isSecureUrl` guard is HERE and not inside `openInAppBrowser`, which is
 * deliberately unguarded because the native force-update gate feeds it real
 * store schemes. A `subscription_uri` is curated seed data and should always
 * be https, so a failure here is a catalogue fault worth reporting rather
 * than a user error worth a toast.
 *
 * The restart hold is taken BEFORE the browser opens and is not released
 * here: `holdRestartAcrossPurchase` owns that on a timer, because this
 * function returns the moment the page is up and the user has not left yet.
 * Releasing on the way out would be releasing before the trip it protects.
 */
export async function openSubscribePage(uri: string): Promise<boolean> {
  if (!isSecureUrl(uri)) {
    logger.captureMessage('Refusing to open a non-https subscription_uri', {
      // Pinned: this message's identity is its text, and it is emitted from
      // an async handler whose live frames vary.
      fingerprint: ['subscription-uri-insecure'],
      extra: { uri },
    });
    return false;
  }
  const release = holdRestartAcrossPurchase('purchase');
  try {
    await webBrowserUtils().openInAppBrowser(buildSubscriptionUrl(uri));
  } catch (err) {
    // Nothing opened, so there is no trip to protect and no reason to make the
    // next return wait out the ceiling. The one immediate release in this file.
    release();
    throw err;
  }
  return true;
}

/**
 * Minimum time the app must have spent in the background before a return
 * counts as "came back from the subscribe page". A user who flicks away and
 * straight back did not read a pricing page, let alone buy anything.
 */
export const MIN_AWAY_MS = 3_000;

/**
 * Calls `onReturn` when the user comes back to the app after being away for
 * at least `MIN_AWAY_MS`. Returns an unsubscribe function.
 *
 * WHY AN AppState TRANSITION AND NOT THE BROWSER RESULT: on Android
 * `expo-web-browser` resolves `{ type: 'opened' }` immediately, and the
 * `cancel` / `dismiss` types are iOS-only. So there is no cross-platform
 * "the browser closed" signal to await, and a background -> active
 * transition is the only thing both platforms report.
 *
 * WHY `background` SPECIFICALLY AND NOT `!== 'active'`: iOS reports
 * `inactive` for transients that are not a departure at all - the app
 * switcher, a notification banner pulled down over the browser, a control
 * centre swipe. Arming on `inactive` would fire the prompt at someone who
 * never left. `lib/time-tick.ts` draws the same distinction for the same
 * reason and is the precedent here.
 */
export function onReturnFromBackground(onReturn: () => void): () => void {
  let leftAt: number | null = null;

  const handle = (state: AppStateStatus) => {
    if (state === 'background') {
      leftAt = Date.now();
      return;
    }
    if (state !== 'active' || leftAt == null) return;
    const away = Date.now() - leftAt;
    leftAt = null;
    if (away >= MIN_AWAY_MS) onReturn();
  };

  const sub = AppState.addEventListener('change', handle);
  return () => sub.remove();
}

/**
 * How long after the user comes back the money-path hold stays up.
 *
 * `refreshUserBillingAfterPurchase` is the slow half: 8 attempts with a
 * 1.5s interval backing off by 1.5x to a 4s cap, so ~23s of sleeps plus eight
 * round trips in the worst case. This window is not sized to outlast that —
 * nothing can, without pinning the restart off for a minute — it is sized so
 * the two things that happen ON the return itself survive it: the
 * `onReturnFromBackground` prompt above (armed at >= MIN_AWAY_MS, so it fires
 * within milliseconds of the transition) and the first entitlement read.
 */
export const PURCHASE_HOLD_AFTER_RETURN_MS = 20_000;

/**
 * The hard ceiling. Nothing about a checkout is still in flight after this.
 *
 * It is the answer to "what if the user never comes back", and it is armed
 * when the hold is TAKEN rather than when a return arrives, because on iOS the
 * return may never arrive at all: `RevenueCatUI.presentPaywall` and
 * `openInAppBrowser` (SFSafariViewController) are both presented in-process,
 * so AppState stays `active` and the `background` transition this module and
 * `app-restart` both key on is never reported. A ceiling armed on the return
 * would, on that platform, be armed by an event that never happens. Five
 * minutes comfortably covers the worst-case refresh above plus the window.
 */
export const PURCHASE_HOLD_CEILING_MS = 5 * 60_000;

/**
 * Holds the app restart off across a checkout, and releases it on a timer the
 * caller cannot lose.
 *
 * WHY. Both money paths take the user OUT of the app: the hosted RevenueCat
 * paywall hands off to the store's purchase sheet, and a publisher's subscribe
 * page opens a browser. A pending OTA restarts the app on a true background ->
 * active return (`OTASilentUpdater`), which is precisely the return that
 * carries the user back from a purchase. When it lands there,
 * `onReturnFromBackground` never raises "Did you subscribe to X?" and the
 * post-purchase entitlement round trip is thrown away mid-flight. The user paid
 * and the app does not know.
 *
 * A RARER TRIGGER IS NOT A WEAKER REASON TO HOLD, and it is the argument to
 * refuse. The window is narrow — it needs a bundle to have downloaded during
 * this session — but the cost inside it is a lost purchase, and a fault that
 * only fires when an update happens to be pending is one nobody will reproduce
 * on demand. Sizing the guard to the frequency of the trigger rather than to
 * the damage is how this returns as an unexplained billing complaint.
 *
 * THE RELEASE IS TIMER-OWNED, NOT `finally`-OWNED, and that is the whole
 * design. A `finally` is the wrong moment in both callers: `openSubscribePage`
 * returns the instant the browser opens, before the user has even left, and
 * `presentFreeTierPaywall` returns while the entitlement refresh it fired is
 * still running. So the caller does not decide when this ends. Two timers do:
 *
 *   - a true `background` -> `active` return schedules the release at
 *     +`PURCHASE_HOLD_AFTER_RETURN_MS`, re-scheduled on each further trip
 *     (a user who bounces to their bank's app and back gets a fresh window);
 *   - `PURCHASE_HOLD_CEILING_MS`, armed immediately and never cancelled by a
 *     return, releases regardless.
 *
 * Whichever fires first wins; the release is idempotent, clears both timers
 * and removes the AppState listener. A LEAKED HOLD DISABLES RESTARTS FOR THE
 * REST OF THE SESSION AND FAILS SILENTLY, which is worse than no hold at all,
 * so there is deliberately no path out of this function that depends on a
 * caller remembering anything. Now that a pending OTA is the only thing that
 * restarts on a return, a leak here does not cost one skipped window: it is
 * update delivery switched off for the session, with nothing to observe.
 *
 * `background` ONLY, never `!== 'active'`, for the reason `onReturnFromBackground`
 * gives above. There is no `MIN_AWAY_MS` floor here on purpose: that floor
 * exists to avoid ASKING a question of someone who never left, and asking
 * nothing is the safe side of it. Here the safe side is the other one — a
 * two-second trip is still a return worth not restarting through.
 *
 * Releasing does NOT retry the restart that was blocked. `lib/app-restart.ts`
 * defers a blocked restart to the next unblocked return and never replays it
 * on release, deliberately: replaying it here would reload the app out of the
 * success state the user just paid for.
 *
 * @param label carried into `activeHolds()` and into the `hold:` blocker
 *              string `app-restart` logs, so a stuck hold names itself.
 * @returns an idempotent IMMEDIATE release. Call it only on a path where
 *          nothing was opened and the user therefore cannot be away —
 *          `openSubscribePage`'s catch, where the browser itself threw, is the
 *          only such call site. Never call it in a `finally` around a
 *          checkout; that is the bug this exists to avoid.
 */
export function holdRestartAcrossPurchase(label: string): () => void {
  const releaseHold = holdRestart(label);

  let released = false;
  let returnTimer: ReturnType<typeof setTimeout> | null = null;
  let ceilingTimer: ReturnType<typeof setTimeout> | null = null;
  let subscription: { remove: () => void } | null = null;
  let away = false;

  const release = () => {
    if (released) return;
    released = true;
    if (returnTimer != null) clearTimeout(returnTimer);
    if (ceilingTimer != null) clearTimeout(ceilingTimer);
    returnTimer = null;
    ceilingTimer = null;
    // Or every checkout attempt leaks an AppState subscription for the session.
    subscription?.remove();
    subscription = null;
    releaseHold();
  };

  ceilingTimer = setTimeout(release, PURCHASE_HOLD_CEILING_MS);

  const handle = (state: AppStateStatus) => {
    if (state === 'background') {
      away = true;
      return;
    }
    if (state !== 'active' || !away) return;
    away = false;
    if (returnTimer != null) clearTimeout(returnTimer);
    returnTimer = setTimeout(release, PURCHASE_HOLD_AFTER_RETURN_MS);
  };

  subscription = AppState.addEventListener('change', handle);
  return release;
}
