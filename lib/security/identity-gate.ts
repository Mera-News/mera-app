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
// Split in three on purpose:
//   1. `resolveIdentity()` — pure, import-free, exhaustively unit-testable.
//   2. the ownership-fault recorder + its persisted flag, used by the Apollo
//      error link as a BACKSTOP. Everything there is lazy-required (the link
//      imports this module, and the stores import the link's siblings), same
//      pattern as auth-failure-breaker.ts.
//   3. the AUTHENTICATED-USER recorder: module-level, in-memory, process-lived.
//      See its section for why the id cannot travel as a route param.

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
  /**
   * Who authenticated in THIS process, from `readPendingAuthUserId()`.
   *
   * The session atom is the primary source and always outranks this; the
   * recorder only ever fills a hole. It exists because `sessionUserId` cannot
   * tell "no session because offline" apart from "the session has not come back
   * yet", and the reauth path asks this function to decide inside exactly that
   * window — which is how user B once landed in the shell on user A's data.
   */
  pendingAuthUserId?: string | null;
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

/**
 * The authenticated user id this process should be judged against: the live
 * session atom when it has resolved, else whoever signed in during this
 * process.
 *
 * THE ATOM WINS ON CONFLICT. The recorder is a hole-filler, never an override —
 * a stale recording must not be able to mask a later account switch. Returns
 * `null`, never `undefined`, so callers can gate on it with a single truthiness
 * check.
 *
 * One home for the rule so the two callers (app/logged-in/index.tsx and
 * components/custom/onboarding/OnboardingScreen.tsx) cannot drift.
 */
export function effectiveSessionUserId(
  sessionUserId?: string | null,
  pendingAuthUserId?: string | null,
): string | null {
  // Truthiness, not `??`: an empty-string id is not an identity, and letting it
  // win would suppress the recorder for the one caller that produced it.
  if (sessionUserId) return sessionUserId;
  return pendingAuthUserId || null;
}

export function resolveIdentity({
  sessionUserId,
  pendingAuthUserId,
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

  // INSERTION POINT IS LOAD-BEARING: after the fault check, before the early
  // return below. Above the fault check, a fault carrying a recorded id would
  // silently WIPE instead of ejecting to reauth — the one outcome the fault
  // check exists to prevent. There is an ordering-guard test for this.
  const effective = effectiveSessionUserId(sessionUserId, pendingAuthUserId);

  // No live session is the OFFLINE path, not a fault. A dead or not-yet-loaded
  // session must never eject a user who has local data to read.
  //
  // Still exactly that, and provably so: `pendingAuthUserId` is non-null only
  // after a sign-in call (OTP or device) RESOLVED, which requires the network.
  // An offline device has none, so `effective === sessionUserId` and this
  // function is byte-identical to what it was. The two offline cases in the
  // test file are the regression guard for that claim and must never need
  // editing.
  if (!effective) return 'coherent';

  // Signed in with nothing stamped on disk yet (fresh login). The wipe is a
  // no-op; the stamp is the point — `cached_user_id` is the only sentinel
  // clearPreviousUserData keys off, so leaving it unwritten makes every later
  // cross-user check a no-op too.
  if (!cachedUserId) return 'wipeAndProceed';

  return effective === cachedUserId ? 'coherent' : 'wipeAndProceed';
}

// ---------------------------------------------------------------------------
// Authenticated-user recorder
// ---------------------------------------------------------------------------
//
// Who signed in during THIS process. Written at all three sign-in sites
// (OTPVerificationView, DeepLinkVerifyScreen, and AuthScreen's WelcomeView for
// device sign-in), read by the two identity gates, and cleared the moment it
// is consumed.
//
// WHY MODULE STATE AND NOT A ROUTE PARAM. `/logged-in` is reachable from the
// app's registered URL scheme, so a route param would let a crafted deep link
// name an arbitrary id — and the verdict that id produces triggers a
// DESTRUCTIVE WIPE of the legitimate user's data. The wipe target must never be
// attacker-supplied. Module state is unreachable from a link, survives
// `unsafeResetDatabase()` (so it is still readable AFTER the wipe it triggered),
// costs no I/O on the cold-start path, and dies with the process. Same shape as
// `faultTriggered` below.
//
// WHY NOT A BOUNDED WAIT for the session atom instead: it pays latency on every
// cold start to defend a few hundred milliseconds, and the only safe timeout
// behaviour ("fall through to coherent") reintroduces the bug on slow networks
// after paying the cost.

let pendingAuthUserId: string | null = null;

/**
 * Record a COMPLETED authentication. Call only after the sign-in call
 * (`signIn.emailOtp`, or the device sign-in POST) has resolved with a user —
 * never optimistically, or an offline device could hold an id it never proved.
 */
export function recordAuthenticatedUser(userId: string | null | undefined): void {
  pendingAuthUserId = userId || null;
}

/** The id recorded by this process's own sign-in, if any. */
export function readPendingAuthUserId(): string | null {
  return pendingAuthUserId;
}

/**
 * Drop the recording. Called by the gates once the id has been consumed — i.e.
 * once it has been STAMPED to `cached_user_id`, which is the durable form of
 * the same fact. Leaving it set would let a stale value mask a later switch.
 */
export function clearPendingAuthUserId(): void {
  pendingAuthUserId = null;
}

// ---------------------------------------------------------------------------
// Blocking-screen latch
// ---------------------------------------------------------------------------
//
// Set while the identity-switch failure screen is on screen. Read by the
// watcher in app/logged-in/_layout.tsx, which must not navigate out from under
// a user who is looking at an unrecoverable state — the ids genuinely disagree
// there, which is exactly the condition the watcher fires on.

let identitySwitchBlocked = false;

export function setIdentitySwitchBlocked(value: boolean): void {
  identitySwitchBlocked = value;
}

export function isIdentitySwitchBlocked(): boolean {
  return identitySwitchBlocked;
}

/**
 * Test-only: reset EVERY piece of module state in this file.
 *
 * All of it is process-lived by design, so without this a suite's first test
 * leaks its recording into the rest of the file and the offline cases stop
 * being offline. Call it in `beforeEach` of any suite that imports this module.
 */
export function __resetIdentityStateForTests(): void {
  pendingAuthUserId = null;
  identitySwitchBlocked = false;
  faultTriggered = false;
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
 * Clears the fault after the user re-proves identity — via OTP, or via device
 * sign-in (an assertion resumes the account the device key is bound to, which
 * is the same proof). Called from those success handlers alongside the
 * existing `setNeedsReauth(false)` — NOT from the auth-failure breaker's
 * success path, because an unrelated query succeeding proves nothing about the
 * userId argument the 403 was about.
 */
export async function clearIdentityFault(): Promise<void> {
  faultTriggered = false;
  writeFaultFlag(null);
}
