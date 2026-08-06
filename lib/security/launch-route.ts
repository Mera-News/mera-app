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
 * Three-valued because "we could not read" is NOT "nothing is there".
 *
 *  - 'present' — a credential/identity was read back.
 *  - 'absent'  — BOTH reads completed and BOTH returned nothing. Positive
 *                evidence that this device has been signed out.
 *  - 'unknown' — a read threw (the keychain is unreadable before the device's
 *                first post-boot unlock — see secure-store-adapter.ts, Sentry
 *                MERA-APP-5J) and nothing was found on the other side.
 *
 * The distinction is load-bearing: `absent` authorises destroying every byte of
 * local user data (lib/security/local-wipe.ts), so it must never be inferred
 * from a failed read. Same rule the repo already applies in
 * scoring-pipeline-store.getPipeline(), which wipes the persisted run only when
 * the keychain read RESOLVES to null and leaves it alone when the read rejects.
 */
export type LocalIdentityState = 'present' | 'absent' | 'unknown';

/**
 * Reads the two things that make this device "signed in": the previously routed
 * userId (settings) and the better-auth cookie (keychain). Both survive a dead
 * server session — that is the whole point, session death must never look like
 * "logged out" to the launch gate. Only an explicit logout clears them.
 *
 * Lazy-requires its deps so launch-route.ts stays import-free for the pure
 * routing test.
 */
export async function readLocalIdentityState(): Promise<LocalIdentityState> {
  let settingsReadCompleted = false;
  try {
    const { getSetting } =
      require('@/lib/database/services/setting-service') as typeof import('@/lib/database/services/setting-service');
    const userId = await getSetting('cached_user_id');
    settingsReadCompleted = true;
    if (userId) return 'present';
  } catch {
    // fall through to the cookie check; the read did NOT complete, so this
    // alone can never produce 'absent'.
  }

  let cookieReadCompleted = false;
  try {
    const Constants = require('expo-constants').default;
    const slug = Constants.expoConfig?.slug || 'app';
    const { secureStore } =
      require('@/lib/utils/secure-store-adapter') as typeof import('@/lib/utils/secure-store-adapter');
    const cookie = await secureStore.getItemAsync(`${slug}_cookie`);
    cookieReadCompleted = true;
    if (cookie) return 'present';
  } catch {
    // ditto
  }

  return settingsReadCompleted && cookieReadCompleted ? 'absent' : 'unknown';
}

/**
 * Whether this device holds a local identity. `unknown` deliberately reads as
 * "no identity" for ROUTING (a transient keychain failure sends the user to
 * /login, which is recoverable by signing in) — but it must never be treated as
 * "signed out" for WIPING, which is not. Callers that destroy data must switch
 * on readLocalIdentityState() directly.
 *
 * NOTE the OR: `cached_user_id` alone counts, even though it is an identity
 * marker rather than a credential. That is intentional — when the keychain is
 * temporarily unreadable, falling back to the cached id keeps the offline-first
 * behaviour instead of ejecting a user over a transient failure.
 */
export async function hasLocalIdentity(): Promise<boolean> {
  return (await readLocalIdentityState()) === 'present';
}
