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

type LaunchRoute = '/login' | '/pin-lock' | '/logged-in';

interface LaunchRouteInput {
  /** A persisted userId or auth cookie exists on this device. */
  hasIdentity: boolean;
  /** The user opted into the PIN gate. */
  lockEnabled: boolean;
  /** A local PIN record exists. */
  pinSet: boolean;
  /** The PIN gate is currently engaged (cold start / >5 min background). */
  locked: boolean;
}

function resolveLaunchRoute({
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

export { type LaunchRoute, type LaunchRouteInput, resolveLaunchRoute };
