// Anonymous-account email helpers. Device-signed-in users have no real email: the server
// fabricates one under `anon.mera.news`. Settings derives its identity footer from these.

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
 * The one derivation Settings uses for the identity footer,
 * extracted so it is testable and cannot drift.
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
