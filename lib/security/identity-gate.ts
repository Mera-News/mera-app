// Identity coherence gate.
//
// The app sends a `userId` (from `cached_user_id` / the user store) as a query
// ARGUMENT while better-auth sends the session cookie as the identity. When
// those two disagree — user B's session on a device still holding user A's
// `cached_user_id`, persona and facts — every personalized query comes back
// 403 "Access denied: resource belongs to another user", once per query, for
// as long as the app is open.
//
// That mismatch must be resolved BEFORE the app shell is entered. This module
// is the single place that decides what a given (session, local identity) pair
// means, so the cold-start route (app/logged-in/index.tsx) and the onboarding
// gate (components/custom/onboarding/OnboardingScreen.tsx) cannot drift apart.
//
// Split in two on purpose:
//   1. `resolveIdentity()` — pure, import-free, exhaustively unit-testable.
//   2. the ownership-fault recorder + its persisted flag, used by the Apollo
//      error link as a BACKSTOP. Everything there is lazy-required (the link
//      imports this module, and the stores import the link's siblings), same
//      pattern as auth-failure-breaker.ts.

export type IdentityVerdict =
  /** Session and local identity agree — or there is nothing to reconcile. */
  | 'coherent'
  /** Reconcile locally: wipe a different owner's data, then stamp this one. */
  | 'wipeAndProceed'
  /** Unresolvable locally — the user must re-prove identity via OTP. */
  | 'reauth';

export interface IdentityInput {
  /** Live better-auth session user id. Absent = offline / not yet resolved. */
  sessionUserId?: string | null;
  /** `cached_user_id` — the owner of the on-device data. */
  cachedUserId?: string | null;
  /** A server ownership-403 was observed (persisted across launches). */
  ownershipFault?: boolean;
  /**
   * Whether re-auth is reachable. Gate on `=== false` specifically, not on
   * falsiness: `isConnected` is seeded optimistically at store init, so the
   * brief "not yet known" window must fall on the act side, and only a
   * CONFIRMED-offline device may suppress the eject. Ejecting an offline user
   * to a login screen they cannot complete would trap them.
   */
  isConnected?: boolean;
  /**
   * Whether the AUTH SERVER is actually answering. Same `=== false` rule, and
   * the same underlying principle as `isConnected` — this is the second half of
   * the question that flag was only ever half-answering.
   *
   * Device connectivity is NOT sufficient. A user on a healthy LTE connection
   * whose auth service is returning 502, hanging, or unresolvable satisfies
   * `isConnected !== false` and would be ejected into an OTP flow that cannot
   * send an OTP — the exact trap the `isConnected` gate exists to prevent,
   * reached by a different road. Deferring is safe and NOT a weakening of the
   * gate: the fault stays persisted, the next launch with a reachable server
   * ejects exactly as before, the server's own ownership guard still refuses
   * every mismatched query in the meantime, and callers keep `needsReauth` set
   * so no authenticated background task runs while the fault is unresolved.
   */
  serverReachable?: boolean;
}

export function resolveIdentity({
  sessionUserId,
  cachedUserId,
  ownershipFault = false,
  isConnected,
  serverReachable,
}: IdentityInput): IdentityVerdict {
  // Checked FIRST, before the id comparison. A fault means the server has
  // already rejected the pairing we would otherwise "fix" locally, so a wipe
  // would be guesswork — and a fault with mismatched ids must still land on
  // reauth, not on a silent wipe. Do not reorder.
  //
  // Note the fall-through is deliberate and load-bearing: when re-auth is
  // unreachable we do NOT return early with some third verdict, we drop into
  // the id comparison below. That keeps the cross-user wipe intact for a
  // deferred fault whose session and cache genuinely disagree.
  if (ownershipFault && isConnected !== false && serverReachable !== false) {
    return 'reauth';
  }

  // No live session is the OFFLINE path, not a fault. A dead or not-yet-loaded
  // session must never eject a user who has local data to read.
  if (!sessionUserId) return 'coherent';

  // Signed in with nothing stamped on disk yet (fresh login). The wipe is a
  // no-op; the stamp is the point — `cached_user_id` is the only sentinel
  // clearPreviousUserData keys off, so leaving it unwritten makes every later
  // cross-user check a no-op too.
  if (!cachedUserId) return 'wipeAndProceed';

  return sessionUserId === cachedUserId ? 'coherent' : 'wipeAndProceed';
}

// ---------------------------------------------------------------------------
// Ownership-fault backstop
// ---------------------------------------------------------------------------

/** Settings key holding the persisted ownership-fault marker. */
export const IDENTITY_FAULT_KEY = 'identity_fault';

// The server raises this as `ForbiddenException` in exactly two places
// (mera-server-graphql `guards/ownership.guard.ts` and
// `user-persona.service.ts`), both the same ownership check, with the same
// literal. `graphql-exception.filter.ts` maps every 403 to the GENERIC
// `FORBIDDEN` code, so the code alone is not a precise match and would silently
// widen the day a second 403 is introduced — match the code AND the message.
// The message survives production: the filter's HttpException branch builds the
// GraphQLError from the exception message and returns before the
// production stacktrace-stripping branch.
const OWNERSHIP_MESSAGE = 'resource belongs to another user';

interface GraphQLErrorLike {
  message?: string;
  extensions?: { code?: string; statusCode?: number } | Record<string, unknown>;
}

export function isOwnershipFault(error: GraphQLErrorLike | null | undefined): boolean {
  if (!error) return false;
  const ext = error.extensions as { code?: string; statusCode?: number } | undefined;
  const matchesCode = ext?.code === 'FORBIDDEN' || ext?.statusCode === 403;
  if (!matchesCode) return false;
  return typeof error.message === 'string' && error.message.includes(OWNERSHIP_MESSAGE);
}

// Loop guard. One trigger per JS session: a single screen fires several
// personalized queries at once and every one of them comes back 403, so without
// this the user gets N Sentry events, N banners and N reauth flips per screen.
let faultTriggered = false;

/** Test-only: reset the per-session loop guard. */
export function __resetIdentityFaultForTests(): void {
  faultTriggered = false;
}

function setNeedsReauthSafe(value: boolean): void {
  try {
    const { useUserStore } =
      require('../stores/user-store') as typeof import('../stores/user-store');
    useUserStore.getState().setNeedsReauth(value);
  } catch {
    // best-effort — the store may not be available (e.g. in unit tests)
  }
}

function writeFaultFlag(value: '1' | null): void {
  try {
    const { setSetting, deleteSetting } =
      require('../database/services/setting-service') as typeof import('../database/services/setting-service');
    if (value === null) deleteSetting(IDENTITY_FAULT_KEY).catch(() => {});
    else setSetting(IDENTITY_FAULT_KEY, value).catch(() => {});
  } catch {
    // best-effort
  }
}

/**
 * Records an authenticated ownership-403. Idempotent per app session.
 *
 * Deliberately does NOT navigate and does NOT wipe: a forced mid-session eject
 * on a match we cannot A/B is worse than a banner, and which side of the
 * mismatch is stale is exactly what we cannot know locally. It flips the
 * existing needs-reauth flow instead — ReauthBanner appears, AppScheduler stops
 * feed-sync — and persists a marker so the NEXT cold start resolves it before
 * the app shell is entered.
 */
export function recordOwnershipFault(context: { operationName?: string } = {}): void {
  if (faultTriggered) return;
  faultTriggered = true;

  writeFaultFlag('1');
  setNeedsReauthSafe(true);

  try {
    const logger = (require('../logger') as { default: typeof import('../logger').default }).default;
    logger.captureMessage(
      'Identity fault: server rejected a query as belonging to another user',
      {
        level: 'error',
        tags: { source: 'identity-gate' },
        extra: { operationName: context.operationName },
      },
    );
  } catch {
    // best-effort
  }
}

/** Whether a previously observed ownership fault is still unresolved. */
export async function hasIdentityFault(): Promise<boolean> {
  try {
    const { getSetting } =
      require('../database/services/setting-service') as typeof import('../database/services/setting-service');
    return (await getSetting(IDENTITY_FAULT_KEY)) === '1';
  } catch {
    return false;
  }
}

/**
 * Clears the fault after the user re-proves identity via OTP. Called from the
 * OTP success handler alongside the existing `setNeedsReauth(false)` — NOT from
 * the auth-failure breaker's success path, because an unrelated query
 * succeeding proves nothing about the userId argument the 403 was about.
 */
export async function clearIdentityFault(): Promise<void> {
  faultTriggered = false;
  writeFaultFlag(null);
}
