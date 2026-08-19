// Email-at-purchase: attach a real, verified email to an anonymous account.
//
// Device-signed-in users have no email — the server fabricates one under
// `anon.mera.news` (docs/auth-migration-plan.md, "GATE OVERRIDDEN"). Receipts
// and account recovery need a real one, so after a confirmed purchase the app
// offers (never demands) an email sheet, and the same sheet stays reachable
// from Settings.
//
// The server writes the verified email onto the SAME anonymous user row —
// never the anonymous plugin's link flow, which would fork identity at the
// exact moment money is involved (plan, "Two hard rules"). The client's whole
// job is two POSTs through authClient.$fetch and a local cache refresh.
//
// Friction the tiny listener registry removes: five purchase surfaces all
// converge on refreshUserBillingAfterPurchase (lib/billing-service.ts), but a
// lib function cannot present UI. The registry lets that one chokepoint raise
// "offer the sheet" while a single host component mounted in the logged-in
// layout decides how to show it — the same shape as a store subscription,
// without adding a store for two events.

import { authClient } from '@/lib/auth-client';
import logger from '@/lib/logger';

export const ANON_EMAIL_DOMAIN = 'anon.mera.news';

/** True when this email is the server-fabricated anonymous placeholder (or
 *  absent entirely). */
export function emailLooksAnonymous(email: string | null | undefined): boolean {
  if (!email) return true;
  return email.toLowerCase().endsWith(`@${ANON_EMAIL_DOMAIN}`);
}

interface SessionUserLike {
  email?: string | null;
  isAnonymous?: boolean | null;
}

/** Decide from a session user object. Exported for the settings row, which
 *  already holds one and must not pay a network call per render. */
export function userNeedsEmail(user: SessionUserLike | null | undefined): boolean {
  if (!user) return false; // no session — no account to attach anything to
  if (user.isAnonymous === true) return true;
  return emailLooksAnonymous(user.email);
}

export interface AccountEmailView {
  isAnonAccount: boolean;
  /** What Settings may display (masked). Never the fabricated anon address. */
  displayEmail: string | null;
}

/**
 * The one derivation Settings uses for the identity footer and the
 * "Add email address" row, extracted so it is testable and cannot drift.
 *
 * Precedence is the point (F1): a REAL stored email wins over the session,
 * because the store updates the instant an in-session attach confirms while
 * better-auth's session atom can stay stale until its next refetch — keying on
 * the session first kept the row on screen until an app restart. When the
 * stored email is absent or anonymous, a resolved session decides; an
 * unresolved session (offline) only ever counts a POSITIVE anon-domain match,
 * so a merely-missing email can never flag an email user as anonymous.
 */
export function resolveAccountEmailView({
  storedEmail,
  sessionUser,
}: {
  storedEmail: string | null | undefined;
  sessionUser: SessionUserLike | null | undefined;
}): AccountEmailView {
  if (storedEmail && !emailLooksAnonymous(storedEmail)) {
    return { isAnonAccount: false, displayEmail: storedEmail };
  }
  if (sessionUser) {
    if (userNeedsEmail(sessionUser)) return { isAnonAccount: true, displayEmail: null };
    return { isAnonAccount: false, displayEmail: sessionUser.email ?? null };
  }
  if (storedEmail) {
    return { isAnonAccount: emailLooksAnonymous(storedEmail), displayEmail: null };
  }
  return { isAnonAccount: false, displayEmail: null };
}

/**
 * Whether the CURRENT account has no real email. Resolves false on any
 * error — when unsure, never nag. Session-based rather than local-cache-based:
 * `cached_user_email` is only written for email sign-ins and by this module,
 * so the session is the one source that also covers legacy installs.
 */
export async function accountNeedsEmail(): Promise<boolean> {
  try {
    const session = await authClient.getSession();
    return userNeedsEmail(session?.data?.user ?? null);
  } catch {
    return false;
  }
}

// ─── Server calls ────────────────────────────────────────────────────────────

export type EmailCaptureErrorCode = 'invalid-email' | 'invalid-otp' | 'server';

export type EmailCaptureStepResult =
  | { ok: true }
  | { ok: false; errorCode: EmailCaptureErrorCode };

interface BetterFetchResultLike {
  error?: { status?: number; code?: string; message?: string } | null;
}

function classify(result: BetterFetchResultLike, invalidCode: EmailCaptureErrorCode): EmailCaptureStepResult {
  if (!result?.error) return { ok: true };
  const status = result.error.status;
  if (status !== undefined && status >= 400 && status < 500) {
    return { ok: false, errorCode: invalidCode };
  }
  return { ok: false, errorCode: 'server' };
}

/** POST /device/email/request — sends the OTP to `email`. */
export async function requestEmailOtp(email: string): Promise<EmailCaptureStepResult> {
  try {
    const result = (await authClient.$fetch('/device/email/request', {
      method: 'POST',
      body: { email },
    })) as BetterFetchResultLike;
    return classify(result, 'invalid-email');
  } catch (error) {
    logger.debug('[email-capture] request failed', { error: String(error) });
    return { ok: false, errorCode: 'server' };
  }
}

/** POST /device/email/confirm — verifies the OTP; the server writes the email
 *  onto the current (anonymous) account. On success the local caches are
 *  refreshed so Settings shows the new address without a restart. */
export async function confirmEmailOtp(email: string, otp: string): Promise<EmailCaptureStepResult> {
  try {
    const result = (await authClient.$fetch('/device/email/confirm', {
      method: 'POST',
      body: { email, otp },
    })) as BetterFetchResultLike;
    const outcome = classify(result, 'invalid-otp');
    if (outcome.ok) {
      // Same row the OTP sign-in flow writes; the store hydrates from it.
      // Lazy-required so this module stays importable from lib/billing-service
      // without pulling the store graph into every consumer.
      try {
        const { setSetting } =
          require('@/lib/database/services/setting-service') as typeof import('@/lib/database/services/setting-service');
        await setSetting('cached_user_email', email);
      } catch {
        // Non-fatal: the session is the source of truth; the cache heals on
        // the next hydrate.
      }
      try {
        const { useUserStore } =
          require('@/lib/stores/user-store') as typeof import('@/lib/stores/user-store');
        // Synchronous, direct write — Settings derives its identity footer and
        // the "Add email address" row from this value, and it must flip the
        // moment the attach confirms, not on the next hydrate or restart (F1).
        // This only ADDS the email; the cleared-only-by-explicit-logout
        // contract on `cached_user_email` is untouched.
        useUserStore.setState({ userEmail: email });
      } catch {
        // Store unavailable (tests) — nothing to refresh.
      }
      // Refresh the session atom so `user.email` reflects the real address.
      void authClient.getSession().catch(() => {});
    }
    return outcome;
  } catch (error) {
    logger.debug('[email-capture] confirm failed', { error: String(error) });
    return { ok: false, errorCode: 'server' };
  }
}

// ─── Capture-request registry ────────────────────────────────────────────────

export type EmailCaptureSource = 'purchase' | 'settings' | 'checkout';

type EmailCaptureListener = (source: EmailCaptureSource) => void;

const listeners = new Set<EmailCaptureListener>();

/** Ask the mounted host (EmailCaptureHost) to present the sheet. No-op when
 *  nothing is mounted — an unmounted host means there is no UI to interrupt. */
export function requestEmailCapture(source: EmailCaptureSource): void {
  for (const listener of listeners) {
    try {
      listener(source);
    } catch {
      // One broken listener must not stop the rest.
    }
  }
}

export function subscribeEmailCapture(listener: EmailCaptureListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Settings row marking an INFORMED skip: the user read the consequence step at
 * checkout and chose to continue without an email. Once set, the post-purchase
 * fallback never auto-asks again on this install (user decision, 2026-08-19).
 * The checkout-time page itself still appears on future purchases — it is part
 * of that flow, and they can skip it again. Deliberately device-local: it is
 * excluded from backup (lib/backup/allowlist.ts) so a restored file cannot
 * silence the ask on a new device.
 */
export const EMAIL_CAPTURE_SKIPPED_SETTING_KEY = 'email_capture_skipped';

function persistEmailCaptureSkip(): void {
  try {
    const { setSetting } =
      require('@/lib/database/services/setting-service') as typeof import('@/lib/database/services/setting-service');
    void setSetting(EMAIL_CAPTURE_SKIPPED_SETTING_KEY, '1').catch(() => {});
  } catch {
    // Settings unavailable (tests) — worst case is one extra post-purchase ask.
  }
}

async function emailCaptureWasSkipped(): Promise<boolean> {
  try {
    const { getSetting } =
      require('@/lib/database/services/setting-service') as typeof import('@/lib/database/services/setting-service');
    return !!(await getSetting(EMAIL_CAPTURE_SKIPPED_SETTING_KEY));
  } catch {
    return false;
  }
}

/**
 * The post-purchase trigger, called from refreshUserBillingAfterPurchase once
 * the server confirmed the new tier. Checks the account first so users who
 * signed in with email are never interrupted, and stands down permanently once
 * the user has made an informed skip at checkout.
 */
export async function maybeRequestEmailCaptureAfterPurchase(): Promise<void> {
  try {
    if (await emailCaptureWasSkipped()) return;
    if (await accountNeedsEmail()) {
      requestEmailCapture('purchase');
    }
  } catch {
    // Never let an email nag surface as a purchase-path error.
  }
}

// ─── Email-before-checkout gate (S10, informed skip since 2026-08-19) ────────
//
// The paywall entry points call ensureEmailBeforeCheckout() and only proceed
// when it resolves true. The page reports its outcome through
// completeEmailCapture(): 'verified' and 'skipped' both let checkout proceed —
// a skip is only reachable through the consequence step, so it is an informed
// decision — while 'dismissed' (Not now, hardware back) aborts checkout.

export type EmailCaptureOutcome = 'verified' | 'dismissed' | 'skipped';

let checkoutResolver: ((proceed: boolean) => void) | null = null;

/** Called by EmailCaptureHost when the page closes. Safe no-op for the
 *  post-purchase presentation, which gates nothing. */
export function completeEmailCapture(outcome: EmailCaptureOutcome): void {
  if (outcome === 'skipped') persistEmailCaptureSkip();
  const resolver = checkoutResolver;
  checkoutResolver = null;
  resolver?.(outcome === 'verified' || outcome === 'skipped');
}

/**
 * Resolve true when checkout may proceed: the account already has a real
 * email, the page just verified one, OR the user made an informed skip.
 * False only when the user dismissed the step outright. Fails OPEN on
 * uncertainty (unreadable session, no host mounted) — the email step must
 * never brick a purchase, and the post-purchase trigger remains the fallback
 * collector.
 */
export async function ensureEmailBeforeCheckout(): Promise<boolean> {
  let needsEmail = false;
  try {
    needsEmail = await accountNeedsEmail();
  } catch {
    return true;
  }
  if (!needsEmail) return true;
  if (listeners.size === 0) return true;
  // Supersede any dangling gate before arming a new one.
  completeEmailCapture('dismissed');
  return new Promise<boolean>((resolve) => {
    checkoutResolver = resolve;
    requestEmailCapture('checkout');
  });
}

/** Test seam. */
export function __resetEmailCaptureForTests(): void {
  listeners.clear();
  checkoutResolver = null;
}
