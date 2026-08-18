// The numeric support handle minted server-side for every new anonymous
// account (auth wave S5). VARIABLE LENGTH: the server mints 7 digits and
// escalates to 8-9 under collision pressure; existing accounts carry 8. The
// client accepts 6-12 digits, no leading zero, and passes the string through
// UNCHANGED everywhere — never truncate, never pad. It is the LOOKUP KEY support uses instead
// of an email address, survives an email attach, and never changes — so it can
// ride every support surface automatically and the user never has to copy it.
//
// Source of truth is the session user payload (`user.supportId`, a custom
// Better Auth user field). There is no local cache: every consumer hides its
// UI when the id is absent, per the wave rule "don't guess silently".
//
// CYCLE NOTE: this module imports auth-client, and auth-client imports
// lib/intercom (logoutIntercom) — so lib/intercom must require THIS module
// lazily, never statically.

import { authClient } from '@/lib/auth-client';

const SUPPORT_ID_FETCH_TIMEOUT_MS = 1_500;

// 6-12 digits, no leading zero — deliberately wider than what the server
// mints today (7-9) so a future escalation is not a client release.
const SUPPORT_ID_PATTERN = /^[1-9]\d{5,11}$/;

/** Extract and validate the support id from a session user object. Tolerates
 *  a numeric field; rejects anything outside SUPPORT_ID_PATTERN. */
export function readSupportIdFromUser(user: unknown): string | null {
  const raw = (user as { supportId?: unknown } | null | undefined)?.supportId;
  const candidate =
    typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= 0
      ? String(raw)
      : typeof raw === 'string'
        ? raw
        : null;
  if (candidate !== null && SUPPORT_ID_PATTERN.test(candidate)) {
    return candidate;
  }
  return null;
}

/**
 * Best-effort read of the CURRENT account's support id, bounded so no support
 * surface ever waits on a dead network. Resolves null on timeout, error, or an
 * account without one (pre-wave email accounts) — callers hide the id then.
 */
export async function getSupportId(): Promise<string | null> {
  try {
    const session = (await Promise.race([
      authClient.getSession(),
      new Promise<null>((resolve) => setTimeout(resolve, SUPPORT_ID_FETCH_TIMEOUT_MS, null)),
    ])) as { data?: { user?: unknown } } | null;
    return readSupportIdFromUser(session?.data?.user ?? null);
  } catch {
    return null;
  }
}

/** The one line support surfaces embed. Deliberately English and unlocalized:
 *  it rides email bodies and payloads read by the support team, and the label
 *  must stay greppable on their side. The user-facing Settings row is the
 *  localized copy (`support.supportId`). */
export function supportIdLine(id: string): string {
  return `Support ID: ${id}`;
}

/** mailto: URL for the support address, with the support id pre-filled in the
 *  body when one is known — the user should never have to copy it. */
export function buildSupportMailtoUrl(supportEmail: string, supportId: string | null): string {
  const base = `mailto:${supportEmail}`;
  if (!supportId) return base;
  return `${base}?body=${encodeURIComponent(`${supportIdLine(supportId)}\n\n`)}`;
}
