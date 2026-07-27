// Local-first launch routing decision. Kept as a pure function (no imports,
// no side effects) so the cold-start routing matrix is unit-testable without
// mocking secure store / the DB.
//
// The gate is deliberately offline-first: it never consults the network. A
// dead server session must not eject the user — identity is a LOCAL fact
// (persisted userId / auth cookie).
//
// The PIN gate is OPT-IN (see app-lock-service.ts). Unless the user turned it
// on in Settings → Security, an identified user goes straight into the app;
// this gate never forces PIN setup.

export type LaunchRoute = '/login' | '/pin-lock' | '/logged-in';

export interface LaunchRouteInput {
  /** A persisted userId or auth cookie exists on this device. */
  hasIdentity: boolean;
  /** The user opted into the PIN gate. */
  lockEnabled: boolean;
  /** A local PIN record exists. */
  pinSet: boolean;
  /** The PIN gate is currently engaged (cold start / >5 min background). */
  locked: boolean;
}

export function resolveLaunchRoute({
  hasIdentity,
  lockEnabled,
  pinSet,
  locked,
}: LaunchRouteInput): LaunchRoute {
  // First install / logged-out: nothing local to protect.
  if (!hasIdentity) return '/login';

  // Opted in + PIN set + gate engaged → require the PIN. `pinSet` is checked
  // alongside the flag on purpose: a flag with no usable record would strand
  // the user on a screen no entry can satisfy.
  if (lockEnabled && pinSet && locked) return '/pin-lock';

  // Lock off, or already unlocked this session.
  return '/logged-in';
}

/**
 * Whether this device holds a local identity — a previously routed userId
 * (settings) or the better-auth cookie in secure store. Both survive a dead
 * server session, which is the whole point: session death must never look
 * like "logged out" to the launch gate.
 *
 * Lazy-requires its deps so launch-route.ts stays import-free for the pure
 * routing test.
 */
export async function hasLocalIdentity(): Promise<boolean> {
  try {
    const { getSetting } =
      require('@/lib/database/services/setting-service') as typeof import('@/lib/database/services/setting-service');
    const userId = await getSetting('cached_user_id');
    if (userId) return true;
  } catch {
    // fall through to cookie check
  }

  try {
    const Constants = require('expo-constants').default;
    const slug = Constants.expoConfig?.slug || 'app';
    const { secureStore } =
      require('@/lib/utils/secure-store-adapter') as typeof import('@/lib/utils/secure-store-adapter');
    const cookie = await secureStore.getItemAsync(`${slug}_cookie`);
    return !!cookie;
  } catch {
    return false;
  }
}
