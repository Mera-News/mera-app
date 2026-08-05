// The Mera-bubble JWT (`GET /api/auth/token`) is subscription-gated server-side.
// With FORCE_SUBSCRIPTIONS=true the auth service refuses an unsubscribed user
// with HTTP 403 and `code: 'SUBSCRIPTION_REQUIRED'` (mera-server-auth's
// `subscriptionTokenGate`).
//
// The friction this module removes (the repo rule: name it or don't add it):
// that 403 is a PERMANENT verdict for the session — no amount of retrying can
// change it until the user buys something — but `getJwtToken()` treated it as a
// transient null. Measured on staging: an unsubscribed device produced a
// /token 403 every ~5s indefinitely (AppScheduler's tick re-evaluating the
// `authenticated` condition of tasks whose OTHER conditions keep failing, so
// their `lastRun` never advances and they stay due on every tick), each call
// also spending a `/get-session` round trip — which is what tripped
// better-auth's rate limiter into 429s. At prod cutover every unsubscribed user
// would do this continuously.
//
// So: one session-scoped latch, checked before the network call. It mirrors
// `classifyError`'s `'not-subscribed'` branch in
// lib/scheduler/feed-sync/feed-sync-status.ts — recognised FIRST, treated as a
// quiet terminal state rather than an error to retry or paint chrome for.
//
// Deliberately free of module-scope react-native / zustand / logger imports:
// `lib/auth-client.ts` and `lib/stores/subscription-store.ts` both import it, and
// anything heavier here would drag those graphs into unrelated test suites. The
// two collaborators it needs are lazy-`require`d, the same shape
// `auth-failure-breaker.ts` uses for exactly this reason.

/** The server-defined code. Emitted by nothing else in the auth service. */
export const SUBSCRIPTION_REQUIRED_CODE = 'SUBSCRIPTION_REQUIRED';

interface AuthErrorLike {
    code?: unknown;
    status?: unknown;
    statusCode?: unknown;
    body?: { code?: unknown } | null;
    error?: { code?: unknown; status?: unknown } | null;
    response?: { status?: unknown } | null;
}

function readCode(error: unknown): string | undefined {
    if (typeof error !== 'object' || error === null) return undefined;
    const e = error as AuthErrorLike;
    // Three shapes, one predicate — the same tolerance `not-subscribed-error.ts`
    // documents for the 402 path:
    //  • `{ code, status }`  — better-fetch's non-throwing return, which spreads
    //    the parsed JSON body and stamps `status` onto it.
    //  • `{ status, error: body }` — a thrown BetterFetchError.
    //  • `{ body: { code } }` — a raw better-call APIError, if one ever reaches
    //    the client un-serialised.
    const candidates = [e.code, e.body?.code, e.error?.code];
    for (const c of candidates) {
        if (typeof c === 'string') return c;
    }
    return undefined;
}

function readStatus(error: unknown): number | undefined {
    if (typeof error !== 'object' || error === null) return undefined;
    const e = error as AuthErrorLike;
    const candidates = [e.status, e.statusCode, e.response?.status, e.error?.status];
    for (const s of candidates) {
        if (typeof s === 'number') return s;
    }
    return undefined;
}

/**
 * True only for the server's "you have no active subscription" refusal of
 * `/token` — NOT for a generic 401/403 from an expired or revoked session.
 *
 * Safe in the too-broad direction: `subscriptionTokenGate` fails OPEN when no
 * session resolves (it logs a warn and defers to `/token`, which answers 401 on
 * its own). `SUBSCRIPTION_REQUIRED` can therefore only be emitted once a session
 * HAS resolved, so an expired session is structurally incapable of producing it.
 * Requiring the code — not merely the 403 — is what makes that airtight.
 *
 * Safe in the too-narrow direction: the code is read from every shape the client
 * can surface it in, and a status is only *rejected* when it is present and
 * disagrees. A missed match degrades to today's behaviour (retry), not to a
 * stuck session.
 */
export function isSubscriptionRequiredAuthError(error: unknown): boolean {
    if (readCode(error) !== SUBSCRIPTION_REQUIRED_CODE) return false;
    const status = readStatus(error);
    return status === undefined || status === 403;
}

// Session-scoped, in-memory only. Nothing persists it: a fresh process must ask
// the server again (the user may have subscribed on another device meanwhile),
// and exactly one refused request per launch is the correct cost of finding out.
let locked = false;

/** True while the server has refused this session a JWT for lack of a plan. */
export function isJwtSubscriptionLocked(): boolean {
    return locked;
}

/**
 * Latch the refusal and record it through the EXISTING shared mechanism.
 *
 * `recordAiLocked` sets `serverTier: 'none'` (so `deriveAiAccess` returns
 * `'locked'` and the guarded surfaces stop firing doomed queries) AND forces a
 * `syncEntitlement` — which is what makes this self-correcting: `userBilling`
 * stays ungated server-side, so it confirms or overturns the verdict a moment
 * later, and an overturn clears this latch via `setServerBilling`.
 *
 * Idempotent: only the first refusal of a session does any work.
 */
export function recordJwtSubscriptionLocked(): void {
    if (locked) return;
    locked = true;
    try {
        // Lazy: ai-lock → subscription-store → jwt-subscription-gate is a cycle
        // at module-eval time. Required here, it is not.
        // eslint-disable-next-line @typescript-eslint/no-require-imports -- deliberate, see above.
        const { recordAiLocked } = require('./ai-lock') as typeof import('./ai-lock');
        recordAiLocked('token');
    } catch {
        // Best-effort — the latch is the load-bearing part, and the store may
        // not exist (unit tests, very early boot).
    }
}

/**
 * Lift the latch so the next caller mints a real JWT again.
 *
 * Called from `setServerBilling` on an explicit PAID tier — the same fact the
 * server's own `hasActiveSubscription` check reads — and from the subscription
 * store's `reset()` (logout / user switch, so user B never inherits user A's
 * refusal) and `clearAuthStorage()`.
 *
 * Deliberately NOT called from `invalidateJwtCache()`: that runs on every 401
 * recovery path (auth-failure-breaker, cloudComplete, submitInferenceJob), and
 * clearing the latch there would re-arm the storm on the next stray 401.
 */
export function clearJwtSubscriptionLock(): void {
    locked = false;
}

/** Test-only: forget the latch. */
export function _resetJwtSubscriptionGateForTests(): void {
    locked = false;
}
