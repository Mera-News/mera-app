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
// auth failures it trips ONCE: captures a single Sentry event, pauses the
// feed-sync task (stopping the poll loop), and kicks off a single deduped
// server-truth session re-check to decide transient-vs-dead.

const AUTH_FAILURE_THRESHOLD = 3;

// When a re-check can't reach the server (offline), keep the breaker open and
// let a later auth failure re-attempt the re-check — but not more often than
// this, so we don't hammer getSession while offline.
const RECHECK_COOLDOWN_MS = 60_000;

const FEED_SYNC_TASK = 'feed-sync';

// Module-level state (mirrors the in-flight-dedupe style of auth-client's JWT
// cache). Reset in tests via _resetForTests().
let consecutiveFailures = 0;
let breakerOpen = false;
let pendingRecheck: Promise<void> | null = null;
let lastRecheckAt = 0;

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

/**
 * Records one auth failure (a 401 / UNAUTHENTICATED observed by the Apollo
 * ErrorLink). On the AUTH_FAILURE_THRESHOLD-th consecutive failure the breaker
 * trips: one Sentry event, feed-sync paused, one deduped session re-check.
 *
 * While the breaker is already open and a re-check is pending we do NOT re-trip
 * or re-capture. If a prior re-check failed offline, a later failure re-attempts
 * the re-check after RECHECK_COOLDOWN_MS.
 */
export function recordAuthFailure(): void {
  consecutiveFailures += 1;

  if (!breakerOpen) {
    if (consecutiveFailures < AUTH_FAILURE_THRESHOLD) return;

    breakerOpen = true;
    logger.captureMessage('Auth circuit breaker tripped', {
      level: 'warning',
      tags: { source: 'auth-breaker', type: 'auth' },
      extra: { consecutiveFailures },
    });
    pauseFeedSync();
    void triggerRecheck();
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
  if (wasOpen) {
    breakerOpen = false;
    resumeFeedSync();
  }
}

/**
 * Treats an app-foreground event as a fresh start: if the breaker had tripped,
 * reset it and resume feed-sync so a user who re-authenticated (or whose
 * keychain is now unlocked) isn't stuck behind a paused poller. If the session
 * is still dead, the next run's 401s will simply re-trip the breaker.
 */
export function onAppForeground(): void {
  if (!breakerOpen && consecutiveFailures === 0) return;
  consecutiveFailures = 0;
  breakerOpen = false;
  pendingRecheck = null;
  lastRecheckAt = 0;
  resumeFeedSync();
}

/**
 * Single deduped server-truth session re-check. Only one runs at a time
 * (mirrors auth-client's _pendingJwtRequest pattern).
 *  - alive     → transient: reset counter, close breaker, resume feed-sync.
 *  - dead      → clearAuthStorage() so app/index.tsx's useSession() routes to /login.
 *  - offline   → keep breaker open; a later recordAuthFailure retries after cooldown.
 */
function triggerRecheck(): Promise<void> {
  if (pendingRecheck) return pendingRecheck;

  pendingRecheck = (async () => {
    lastRecheckAt = Date.now();
    const { authClient, clearAuthStorage } =
      require('./auth-client') as typeof import('./auth-client');

    try {
      // disableCookieCache forces a server round-trip instead of trusting the
      // locally cached cookie — we need server truth here.
      const result = (await authClient.getSession({
        query: { disableCookieCache: true },
      })) as SessionResult | null | undefined;

      if (result?.data?.session) {
        // Transient — session is actually alive. Close the breaker.
        consecutiveFailures = 0;
        breakerOpen = false;
        resumeFeedSync();
        return;
      }

      const error = result?.error;
      if (!error) {
        // Server responded with no session — genuinely logged out.
        await clearAuthStorage();
        return;
      }

      const status = error.status ?? error.statusCode;
      if (status === 401 || status === 403) {
        // Server explicitly rejected the session — logged out.
        await clearAuthStorage();
        return;
      }

      // Any other error (offline, 5xx, unknown) — can't conclude the session is
      // dead. Keep the breaker open; a later failure retries after the cooldown.
      logger.addBreadcrumb(
        'Auth breaker re-check inconclusive (network/server error)',
        'auth-breaker',
        { status },
        'warning',
      );
    } catch (e) {
      // Threw (typically a network failure) — keep the breaker open for retry.
      logger.addBreadcrumb(
        'Auth breaker re-check threw',
        'auth-breaker',
        { error: String(e) },
        'warning',
      );
    } finally {
      pendingRecheck = null;
    }
  })();

  return pendingRecheck;
}

/** Test-only: reset all module-level breaker state. */
export function _resetForTests(): void {
  consecutiveFailures = 0;
  breakerOpen = false;
  pendingRecheck = null;
  lastRecheckAt = 0;
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
