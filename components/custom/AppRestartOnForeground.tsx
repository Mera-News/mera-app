import { useEffect } from 'react';
import { AppState, type AppStateStatus } from 'react-native';

import logger from '@/lib/logger';
import { requestRestart } from '@/lib/app-restart';
import { getCurrentPathname } from '@/lib/nav-state';

/**
 * Restarts the app on every true background -> foreground return. Renders null.
 *
 * EVERY return, with no time threshold. A user who leaves and comes back gets a
 * fresh process: hydrated stores, a fresh session, the bundle that was current
 * when they left. The owner chose this over a 30s / 2min / 5min threshold, so
 * do not add one. The gates that DO apply live in `lib/app-restart.ts` (active
 * app state, a 10s floor, an in-flight latch, holds).
 *
 * ARMS ON `background` ONLY, NEVER `!== 'active'`. iOS reports `inactive` for
 * the app switcher, a notification banner pulled down and a Control Centre
 * swipe, and none of those is a departure — arming on them would restart a user
 * who never left, mid-tap. `lib/subscriptions/subscribe-flow.ts` draws the same
 * line for the same reason and is the precedent. Deliberately NOT built on
 * `lib/hooks/useRefetchOnForeground.ts`, which fires on inactive -> active too.
 *
 * ROUTE BLOCKING. These routes hold an in-progress step the return itself
 * delivered: a login, an OTP the user just fetched from their mail app, a PIN
 * being set or entered, onboarding answers. Wiping a code on the return that
 * carried it is the worst version of this feature, so those routes never
 * restart. The route is read from `lib/nav-state.ts`'s module mirror rather
 * than `usePathname()`, which is what that mirror exists for — non-React code
 * needing the live route — and it keeps this component free of a re-render on
 * every navigation.
 *
 * `/pin-lock` is on the list for a SECURITY reason, not a convenience one:
 * `locked` lives only in memory, so a restart recomputes it from the threshold
 * and a three-second trip to a password manager would come back unlocked.
 * `lib/stores/pin-store.ts` also takes a `holdRestart('pin-lock')` for the
 * whole time the gate is engaged, which is the order-independent half of that
 * fix and covers an OTA restart landing on the lock screen. This list is the
 * cheap half. Do not remove either one on the grounds that the other exists.
 *
 * MOUNTED INSIDE `NativeUpdateGate`'s CHILDREN, deliberately. The gate renders
 * its checking splash or `ForceUpdateScreen` INSTEAD of its children and calls
 * `AppScheduler.suspend()` when it blocks, so a user held on the force-update
 * screen has no mounted listener here and cannot be restarted out from under
 * it. Verified structurally: both non-`allowed` branches return early, before
 * `<>{children}</>`.
 */

/** Routes where a return must not wipe what the user came back to finish. */
export const RESTART_BLOCKED_ROUTES = [
  '/login',
  '/verify-otp',
  '/pin-setup',
  '/pin-lock',
  '/logged-in/onboarding',
] as const;

export function isRestartBlockedRoute(pathname: string): boolean {
  return RESTART_BLOCKED_ROUTES.some((route) => pathname.startsWith(route));
}

export default function AppRestartOnForeground() {
  useEffect(() => {
    let armed = false;

    const handleAppStateChange = (state: AppStateStatus) => {
      if (state === 'background') {
        armed = true;
        return;
      }
      if (state !== 'active' || !armed) return;
      armed = false;

      const pathname = getCurrentPathname();
      if (isRestartBlockedRoute(pathname)) {
        logger.debug(`[app-restart] return not restarted on ${pathname}`);
        return;
      }

      void requestRestart('foreground');
    };

    const subscription = AppState.addEventListener('change', handleAppStateChange);
    return () => subscription.remove();
  }, []);

  return null;
}
