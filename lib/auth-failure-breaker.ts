import logger from './logger';

// Circuit breaker for the app's soft-fail auth handling.
//
// The Apollo ErrorLink deliberately does NOT log out or refresh on a single
// UNAUTHENTICATED / 401 — a transient keychain-locked window during a
// background-push wake must not nuke a healthy session (see the rationale in
// lib/apollo-client.ts). But that soft-fail has no escape hatch: feed-sync
// polls every ~10s, so a genuinely dead session produces an unbounded stream
// of 401s (this shipped a two-week, ~700-event Sentry storm in prod).
//
// This breaker is that escape hatch. After AUTH_FAILURE_THRESHOLD consecutive
// auth failures it trips ONCE: it kicks off a single deduped server-truth
// session re-check to decide transient-vs-dead, and only pauses the feed-sync
// task (stopping the poll loop) + captures a single Sentry event when that
// re-check does NOT come back alive.
//
// Repair before pause is deliberate. The original order paused first and
// re-checked afterwards, so a merely-stale session cost the user a stopped
// poller even though the very next call proved it healthy.

const AUTH_FAILURE_THRESHOLD = 3;

// When a re-check can't reach the server (offline), keep the breaker open and
// let a later auth failure re-attempt the re-check — but not more often than
// this, so we don't hammer getSession while offline.
const RECHECK_COOLDOWN_MS = 60_000;

const FEED_SYNC_TASK = 'feed-sync';

// NOT counting a failure while the auth-read quarantine is engaged was tried
// and withdrawn. The latch defaults to ENGAGED at import and is released only
// by `enforceInstallBoundary`, so in any process that never boots the launch
// gate it stays engaged forever - and suppressing there blinds the breaker to
// real 401s. lib/__tests__/logger.test.ts pins exactly that contract ("a
// network 401 feeds the auth breaker"), written after one dead session shipped
// five separate Sentry issues. The verdict gate in triggerRecheck is where the
// cookie-less case is handled instead: it costs a transient feed-sync pause
// during the launch window, and buys back nothing that the breaker needs to
// stay blind for.

// Module-level state (mirrors the in-flight-dedupe style of auth-client's JWT
// cache). Reset in tests via _resetForTests().
let consecutiveFailures = 0;
let breakerOpen = false;
let pendingRecheck: Promise<RecheckOutcome> | null = null;
let lastRecheckAt = 0;
// Monotonic — deliberately NOT reset by _resetForTests, so an abandoned run can
// never collide with the token of the run that replaced it.
let recheckToken = 0;
// Details of the most recent re-check, for the trip callback to attach to its
// Sentry event. Module state rather than a wider return type, to keep
// RecheckOutcome a single value that callers can compare.
let lastRecheckDetail: {
  deadReason?: DeadReason;
  credentialState: CredentialState;
} = { credentialState: 'unknown' };

// What the server-truth re-check concluded. Returned (rather than inferred
// from breakerOpen) so callers can't confuse "session proved alive" with
// "breaker closed by a concurrent recordAuthSuccess".
//
// 'no-credential' is NOT a weaker 'dead'. It means the re-check request went
// out with no Cookie header at all, because the install-boundary latch was
// hiding the keychain - so the server's "no session" answer describes OUR
// request, not the session. Kept distinct from 'inconclusive' because that one
// still reports (see the trip callback): only 'alive' and 'no-credential'
// return without a Sentry event.
type RecheckOutcome = 'alive' | 'dead' | 'inconclusive' | 'no-credential';

// Why a 'dead' verdict was reached. 'rejected' is the server explicitly
// refusing the credential we sent; 'no-session' is a 200 that simply carried
// no session. Split because ONE string for both is what made MERA-APP-75
// unreadable: four unrelated causes all rendered as "dead".
type DeadReason = 'rejected' | 'no-session';

// Diagnostic only - never gates a verdict. Answers "which of the cookie-less
// causes was this" on the Sentry event.
type CredentialState =
  | 'present'      // getCookie() returned something: the server really saw it
  | 'expired'      // nothing sent, but the keychain holds entries - better-auth
                   // filters expired cookies client-side, so this is a real lapse
  | 'absent'       // nothing sent and nothing stored
  | 'quarantined'  // the install-boundary latch was hiding the sync read
  | 'unreadable'   // the keychain read rejected (locked / transient)
  | 'unknown';     // the probe itself failed; never blocks the verdict

interface AuthErrorLike {
  status?: number;
  statusCode?: number;
}

interface SessionResult {
  data?: { session?: unknown } | null;
  error?: AuthErrorLike | null;
}

// Lazy require to avoid an import cycle:
//   apollo-client → auth-failure-breaker → { auth-client, AppScheduler }
//   AppScheduler  → auth-failure-breaker (foreground reset)
// Statically importing these here would form a cycle at module-eval time.
function pauseFeedSync(): void {
  try {
    const { AppScheduler } =
      require('./scheduler/AppScheduler') as typeof import('./scheduler/AppScheduler');
    AppScheduler.pauseTask(FEED_SYNC_TASK);
  } catch {
    // best-effort — scheduler may not be initialized (e.g. in unit tests)
  }
}

function resumeFeedSync(): void {
  try {
    const { AppScheduler } =
      require('./scheduler/AppScheduler') as typeof import('./scheduler/AppScheduler');
    AppScheduler.resumeTask(FEED_SYNC_TASK);
  } catch {
    // best-effort
  }
}

// Drop the cached inference-gateway JWT. GraphQL auth is the better-auth
// COOKIE (apollo-client's SetContextLink), which getSession refreshes for us,
// so this alone never repairs a GraphQL 401 — but the JWT is the second thing
// a dead-then-revived session leaves stale, and re-minting it is free.
// Lazy-required for the same no-cycle-at-module-eval reason as above.
function invalidateJwtCache(): void {
  try {
    const { invalidateJwtCache: invalidate } =
      require('./auth-client') as typeof import('./auth-client');
    invalidate();
  } catch {
    // best-effort
  }
}

// Flip the persisted needs-reauth flag WITHOUT ejecting the user. A confirmed
// dead server session no longer wipes local auth/data — the app stays
// offline-usable behind the PIN, and a banner prompts a re-login (which clears
// the flag). Lazy-require to avoid an import cycle through the user store.
function setNeedsReauth(value: boolean): void {
  try {
    const { useUserStore } =
      require('./stores/user-store') as typeof import('./stores/user-store');
    useUserStore.getState().setNeedsReauth(value);
  } catch {
    // best-effort — store may not be available (e.g. in unit tests)
  }
}

/** Current persisted needs-reauth flag; false when the store isn't available. */
function getNeedsReauth(): boolean {
  try {
    const { useUserStore } =
      require('./stores/user-store') as typeof import('./stores/user-store');
    return useUserStore.getState().needsReauth === true;
  } catch {
    return false;
  }
}

/**
 * What `authLink` would put on the wire right now. An empty string means it
 * would send NO Cookie header - which better-auth's expo client returns both
 * for an EXPIRED cookie (it filters expired entries client-side,
 * @better-auth/expo/dist/client.mjs:78-90) and for a read the install-boundary
 * latch is quarantining.
 *
 * Read SYNCHRONOUSLY at the moment a request is built. Sampled after an await
 * it describes a different instant: the latch can release mid-flight, and we
 * would then credit a cookie to a request that went out without one.
 */
function safeGetCookie(): string {
  try {
    const { authClient } =
      require('./auth-client') as typeof import('./auth-client');
    return authClient.getCookie() || '';
  } catch {
    return '';
  }
}

/** Whether the install-boundary latch is hiding sync auth reads right now. */
function isQuarantineActive(): boolean {
  try {
    const { isAuthReadQuarantineActive } =
      require('./security/install-boundary-latch') as typeof import('./security/install-boundary-latch');
    return isAuthReadQuarantineActive();
  } catch {
    return false;
  }
}

/**
 * Diagnostic explainer for the Sentry event: which cookie-less cause was in
 * play. Deliberately NOT part of any verdict - it runs after the decision is
 * made and degrades to 'unknown' on any failure.
 *
 * Uses the ASYNC keychain API on purpose. That one is neither quarantined nor
 * error-swallowing (lib/utils/secure-store-adapter.ts), so it is the only way
 * to tell "nothing stored" from "stored but filtered out as expired", and a
 * rejection from it is a genuinely unreadable keychain. Never returns or logs
 * the cookie VALUE, only the derived state.
 */
async function readCredentialState(
  cookieAtRequest: string,
  quarantinedAtRequest: boolean,
): Promise<CredentialState> {
  if (cookieAtRequest) return 'present';
  if (quarantinedAtRequest) return 'quarantined';

  let raw: string | null;
  try {
    const { secureStore } =
      require('./utils/secure-store-adapter') as typeof import('./utils/secure-store-adapter');
    const Constants = (require('expo-constants') as { default?: { expoConfig?: { slug?: string } } })
      .default;
    const slug = Constants?.expoConfig?.slug || 'app';
    raw = await secureStore.getItemAsync(`${slug}_cookie`);
  } catch {
    return 'unreadable';
  }

  try {
    if (!raw) return 'absent';
    const parsed = JSON.parse(raw) as Record<string, unknown> | null;
    if (!parsed || typeof parsed !== 'object') return 'absent';
    return Object.keys(parsed).length === 0 ? 'absent' : 'expired';
  } catch {
    return 'unknown';
  }
}

/**
 * Records one auth failure (a 401 / UNAUTHENTICATED observed by the Apollo
 * ErrorLink or by a service-level catch). On the AUTH_FAILURE_THRESHOLD-th
 * consecutive failure the breaker trips: it attempts repair first (drop the
 * cached JWT + one deduped server-truth session re-check) and only pauses
 * feed-sync + captures a single Sentry event if that re-check does NOT come
 * back alive. An alive session means the failures were transient and the
 * poller is never stopped.
 *
 * While the breaker is already open and a re-check is pending we do NOT re-trip
 * or re-capture. If a prior re-check failed offline, a later failure re-attempts
 * the re-check after RECHECK_COOLDOWN_MS.
 */
export function recordAuthFailure(): void {
  consecutiveFailures += 1;

  if (!breakerOpen) {
    if (consecutiveFailures < AUTH_FAILURE_THRESHOLD) return;

    // Mark the breaker open immediately so concurrent failures dedupe onto
    // this repair attempt rather than starting their own.
    breakerOpen = true;
    const failuresAtTrip = consecutiveFailures;
    // Sampled BEFORE the re-check: if the app already knew this session was
    // dead, this trip is rediscovering a state it has carried since the last
    // launch and must not re-report it. Breaker state is module-local and dies
    // with the process, but the verdict persists in the needs_reauth settings
    // row and rehydrates, which is why "trips once" was only ever true PER
    // PROCESS - MERA-APP-75 collected one event per cold start per user.
    // The in-memory read suffices: app/logged-in/index.tsx awaits
    // hydrateFromDb() before firing the authenticated queries that trip this.
    const alreadyDead = getNeedsReauth();

    invalidateJwtCache();
    void triggerRecheck().then((outcome) => {
      // Alive → transient. triggerRecheck already closed the breaker and reset
      // the counter; feed-sync was never paused and Sentry never heard about it.
      if (outcome === 'alive') return;
      // The verdict is now several hundred ms old. If a successful
      // authenticated op closed the breaker while we were asking the server,
      // that is fresher and stronger proof — pausing here would strand
      // feed-sync paused with breakerOpen === false, which nothing resumes.
      if (!breakerOpen) return;

      // We never presented a credential, so nothing was proven. Pause the
      // poller (there is nothing to poll WITH) but assert nothing: no
      // needs_reauth, no Sentry event. Recovery needs no new machinery - the
      // flag was never set, so onAppForeground / onNetworkReconnect do NOT
      // early-return and re-ask once the latch releases; an 'alive' answer
      // then closes the breaker and resumes feed-sync.
      if (outcome === 'no-credential') {
        logger.addBreadcrumb(
          'Auth breaker re-check had no credential to present',
          'auth-breaker',
          { credentialState: lastRecheckDetail.credentialState },
          'warning',
        );
        pauseFeedSync();
        return;
      }

      // Report the TRANSITION into the dead state, not every rediscovery of
      // it. Pausing stays unconditional below: it is idempotent, and skipping
      // it would leave a known-dead session polling.
      if (!alreadyDead) {
      logger.captureMessage('Auth circuit breaker tripped', {
        level: 'warning',
        tags: { source: 'auth-breaker', type: 'auth' },
        extra: {
          consecutiveFailures: failuresAtTrip,
          recheck: outcome,
          // Which branch produced the verdict, and what we actually held at
          // the time. Without these, unrelated causes are one opaque string.
          deadReason: lastRecheckDetail.deadReason,
          credentialState: lastRecheckDetail.credentialState,
          repeat: alreadyDead,
        },
        // This message is emitted from a .then() callback, so its stack is
        // whatever async frames happened to be live at the time. Sentry groups
        // captureMessage on that stack, which split ONE recurring event across
        // four issues (MERA-APP-6J / 5P / 65 / 6R), one of them attributed to
        // persistFeedMetadata — a function that has nothing to do with auth.
        // The message IS the identity here; pin it so the breaker keeps
        // producing exactly one issue, which is the whole point of a breaker
        // that trips once.
        fingerprint: ['auth-breaker-tripped'],
      });
      }
      pauseFeedSync();
    });
    return;
  }

  // Breaker already open. Don't re-trip / re-capture while a re-check is in
  // flight. If the last re-check couldn't reach the server (offline) and the
  // cooldown has elapsed, re-attempt it.
  if (!pendingRecheck && Date.now() - lastRecheckAt >= RECHECK_COOLDOWN_MS) {
    void triggerRecheck();
  }
}

/**
 * Records a successful authenticated operation. Resets the consecutive-failure
 * counter and, if the breaker had tripped on a transient issue, closes it and
 * resumes feed-sync.
 */
export function recordAuthSuccess(): void {
  const wasOpen = breakerOpen;
  consecutiveFailures = 0;
  // "Error-free response" is NOT the same as "authenticated response". The
  // Apollo success link calls this for ANY result without errors, including
  // ones for operations that carried no credential and needed none - and
  // clearing needs_reauth on one of those retracts a confirmed-dead verdict
  // that nothing re-establishes until the next trip. app/logged-in/index.tsx
  // already carries a local workaround for this exact defect.
  //
  // We cannot see the operation from here, but we can see whether there was a
  // credential to authenticate WITH: an empty cookie means this success cannot
  // have been ours. Narrow, and it fails safe - a present cookie behaves
  // exactly as before.
  if (safeGetCookie()) {
    setNeedsReauth(false);
  }
  if (wasOpen) {
    breakerOpen = false;
    resumeFeedSync();
  }
}

/**
 * Treats an app-foreground event as a chance to recover: if the breaker had
 * tripped, revalidate against the server and resume feed-sync only once the
 * session is proven alive (a user who re-authenticated, or whose keychain is
 * now unlocked, shouldn't stay stuck behind a paused poller).
 *
 * Stays SYNCHRONOUS — AppScheduler._onForeground calls this inline on the
 * foreground path and must not be delayed by a network round-trip, so the
 * re-check is fired and the resume happens from its callback.
 */
export function onAppForeground(): void {
  if (!breakerOpen && consecutiveFailures === 0) return;

  // A confirmed-dead session does not heal on its own. ReauthBanner is the
  // recovery path, and re-login clears the flag; resuming here would only buy
  // AUTH_FAILURE_THRESHOLD more 401s and an immediate re-trip.
  if (getNeedsReauth()) return;

  const wasOpen = breakerOpen;
  consecutiveFailures = 0;
  // Nothing was paused, so there is nothing to revalidate — don't spend a
  // getSession round-trip on every foreground after one or two stray 401s.
  if (!wasOpen) return;

  // Deliberately do NOT close the breaker here. The old code did, which meant
  // every single foreground resumed the poller unconditionally and bought
  // exactly AUTH_FAILURE_THRESHOLD more 401s before re-tripping — that loop is
  // what a 324-event Sentry issue looks like. Only triggerRecheck's 'alive'
  // branch may close it.
  //
  // Clearing pendingRecheck/lastRecheckAt forces a genuinely fresh round-trip:
  // the cooldown shouldn't apply to an explicit foreground, and a re-check
  // started before backgrounding may never settle (iOS freezes timers), so we
  // abandon rather than join it. triggerRecheck's finally is identity-guarded,
  // so the abandoned run can't clear the handle of the one we start here.
  pendingRecheck = null;
  lastRecheckAt = 0;

  // Note: an inconclusive re-check (offline foreground) now leaves feed-sync
  // paused where the old code resumed. It self-heals on the next foreground
  // with connectivity, or on any successful request via recordAuthSuccess.
  void triggerRecheck();
}

/**
 * Connectivity just came back. If the breaker had tripped on failures we could
 * NOT conclude anything from — offline or 5xx, i.e. 'inconclusive' — this is the
 * moment to re-ask the server.
 *
 * Without this, a breaker-paused feed-sync never resumes on reconnect:
 * AppScheduler._onNetworkReconnect skips paused tasks as its very first check,
 * so the reconnect trigger cannot revive the poller by itself. Recovery
 * otherwise required a real background→foreground cycle (onAppForeground) or an
 * unrelated successful query — so a user who went out of range for an hour and
 * came back without ever backgrounding the app stayed paused.
 *
 * Mirrors onAppForeground exactly, INCLUDING its proven-dead early return: a
 * confirmed-dead session must not self-heal, or we buy AUTH_FAILURE_THRESHOLD
 * more 401s and an immediate re-trip. ReauthBanner stays the only path out of
 * that state.
 */
export function onNetworkReconnect(): void {
  if (!breakerOpen) return;
  if (getNeedsReauth()) return;

  // Abandon rather than join any in-flight re-check: one started before the
  // outage may never settle, and an explicit reconnect should not be subject to
  // the cooldown. triggerRecheck's finally is identity-guarded, so the abandoned
  // run cannot clear the handle of the one we start here.
  pendingRecheck = null;
  lastRecheckAt = 0;

  void triggerRecheck();
}

/**
 * Single deduped server-truth session re-check. Only one runs at a time
 * (mirrors auth-client's _pendingJwtRequest pattern).
 *  - alive     → transient: reset counter, close breaker, resume feed-sync.
 *  - dead      → set the persisted needsReauth flag (no eject); feed-sync stays
 *                paused and a banner prompts re-login. Local data + PIN survive.
 *  - offline   → 'inconclusive': keep breaker open; a later recordAuthFailure
 *                retries after cooldown.
 */
function triggerRecheck(): Promise<RecheckOutcome> {
  if (pendingRecheck) return pendingRecheck;

  // Monotonic identity for this run, used by the guard in the finally below.
  // (A token rather than the promise itself: a const can't be referenced from
  // inside its own initializer.)
  const token = ++recheckToken;

  const run: Promise<RecheckOutcome> = (async (): Promise<RecheckOutcome> => {
    lastRecheckAt = Date.now();
    const { authClient } =
      require('./auth-client') as typeof import('./auth-client');

    // Sampled SYNCHRONOUSLY, immediately before the request, because this is
    // the only instant at which they describe the request we are about to
    // make. The install-boundary latch can release mid-flight, and a cookie
    // read after the await would credit a credential to a request that went
    // out without one - reproducing the false 'dead' this exists to remove.
    const cookieAtRequest = safeGetCookie();
    const quarantinedAtRequest = isQuarantineActive();
    lastRecheckDetail = { credentialState: 'unknown' };

    try {
      // disableCookieCache forces a server round-trip instead of trusting the
      // locally cached cookie — we need server truth here. (better-auth-expo
      // rewrites secure-store from this response, which is the actual repair.)
      const result = (await authClient.getSession({
        query: { disableCookieCache: true },
      })) as SessionResult | null | undefined;

      if (result?.data?.session) {
        // Transient — session is actually alive. Close the breaker.
        consecutiveFailures = 0;
        breakerOpen = false;
        // Server truth beats a stale flag: a live session means the banner has
        // nothing left to prompt for (same policy as recordAuthSuccess).
        setNeedsReauth(false);
        resumeFeedSync();
        return 'alive';
      }

      const error = result?.error;
      if (!error) {
        // A 200 carrying no session does NOT prove the session is dead - it is
        // also exactly what a request with no Cookie header gets back. If the
        // latch was hiding the keychain when we built this request, we asked
        // the question anonymously and the answer is about us, not the session.
        // (better-auth's expo client also drops EXPIRED cookies client-side, so
        // a real lapse arrives here too, with the latch inactive - that one is
        // a genuine 'dead' and still flags for re-auth.)
        if (!cookieAtRequest && quarantinedAtRequest) {
          lastRecheckDetail = { credentialState: 'quarantined' };
          return 'no-credential';
        }
        lastRecheckDetail = {
          deadReason: 'no-session',
          credentialState: await readCredentialState(
            cookieAtRequest,
            quarantinedAtRequest,
          ),
        };
        // Past the gate above, a credential really was available, so "no
        // session" IS the server's verdict on it: genuinely logged out. Flag
        // for re-auth instead of ejecting; keep the breaker open so feed-sync
        // stays paused until the user signs in again.
        setNeedsReauth(true);
        return 'dead';
      }

      const status = error.status ?? error.statusCode;
      if (status === 401 || status === 403) {
        // An explicit rejection is server truth whatever we think we sent, so
        // this branch is NOT gated on the credential state.
        lastRecheckDetail = {
          deadReason: 'rejected',
          credentialState: await readCredentialState(
            cookieAtRequest,
            quarantinedAtRequest,
          ),
        };
        // Server explicitly rejected the session — flag for re-auth, no eject.
        setNeedsReauth(true);
        return 'dead';
      }

      // Any other error (offline, 5xx, unknown) — can't conclude the session is
      // dead. Keep the breaker open; a later failure retries after the cooldown.
      logger.addBreadcrumb(
        'Auth breaker re-check inconclusive (network/server error)',
        'auth-breaker',
        { status },
        'warning',
      );
      lastRecheckDetail = {
        credentialState: await readCredentialState(
          cookieAtRequest,
          quarantinedAtRequest,
        ),
      };
      return 'inconclusive';
    } catch (e) {
      // Threw (typically a network failure) — keep the breaker open for retry.
      logger.addBreadcrumb(
        'Auth breaker re-check threw',
        'auth-breaker',
        { error: String(e) },
        'warning',
      );
      lastRecheckDetail = {
        credentialState: await readCredentialState(
          cookieAtRequest,
          quarantinedAtRequest,
        ),
      };
      return 'inconclusive';
    } finally {
      // Identity guard: onAppForeground abandons an in-flight re-check by
      // nulling the handle, so a late-settling run must not clear the handle of
      // the fresh run that replaced it.
      if (recheckToken === token) pendingRecheck = null;
    }
  })();

  pendingRecheck = run;
  return run;
}

/** Test-only: reset all module-level breaker state. */
export function _resetForTests(): void {
  consecutiveFailures = 0;
  breakerOpen = false;
  pendingRecheck = null;
  lastRecheckAt = 0;
  lastRecheckDetail = { credentialState: 'unknown' };
}

/** Test-only / diagnostics: current breaker state snapshot. */
export function _getBreakerState(): {
  consecutiveFailures: number;
  breakerOpen: boolean;
  recheckInFlight: boolean;
} {
  return {
    consecutiveFailures,
    breakerOpen,
    recheckInFlight: pendingRecheck !== null,
  };
}
