// Local-first launch routing decision. Kept as a pure function (no imports,
// no side effects) so the cold-start routing matrix is unit-testable without
// mocking secure store / the DB.
//
// The gate is deliberately offline-first: it never consults the network. A
// dead server session must not eject the user — identity is a LOCAL fact
// (persisted userId / auth cookie) and app access is protected by the PIN.

export type LaunchRoute = '/login' | '/pin-setup' | '/pin-lock' | '/logged-in';

export interface LaunchRouteInput {
  /** A persisted userId or auth cookie exists on this device. */
  hasIdentity: boolean;
  /** A local PIN record exists. */
  pinSet: boolean;
  /** The PIN gate is currently engaged (cold start / >5 min background). */
  locked: boolean;
}

export function resolveLaunchRoute({
  hasIdentity,
  pinSet,
  locked,
}: LaunchRouteInput): LaunchRoute {
  // First install / logged-out: nothing local to protect.
  if (!hasIdentity) return '/login';

  // Identified but no PIN yet — mandatory one-time setup (existing users on
  // first launch after this update; new users who quit before setting one).
  if (!pinSet) return '/pin-setup';

  // Identified + PIN set + gate engaged → require the PIN.
  if (locked) return '/pin-lock';

  // Identified, PIN set, already unlocked this session.
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
