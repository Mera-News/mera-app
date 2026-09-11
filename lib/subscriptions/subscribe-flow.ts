import { AppState, type AppStateStatus } from 'react-native';

import logger from '../logger';
import { isSecureUrl } from '../secure-url';
import { appendReferrer, openInAppBrowser } from '../web-browser-utils';

/**
 * Opening a publisher's own subscribe page, and knowing when the user came
 * back so the "Did you subscribe to X?" prompt can be asked.
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
  return appendReferrer(uri, 'subscription');
}

/**
 * Opens the subscribe page, or returns false when the URI is unusable.
 *
 * The `isSecureUrl` guard is HERE and not inside `openInAppBrowser`, which is
 * deliberately unguarded because the native force-update gate feeds it real
 * store schemes. A `subscription_uri` is curated seed data and should always
 * be https, so a failure here is a catalogue fault worth reporting rather
 * than a user error worth a toast.
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
  await openInAppBrowser(buildSubscriptionUrl(uri));
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
