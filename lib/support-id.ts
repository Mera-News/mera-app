// The numeric support handle minted server-side for every new anonymous
// account (auth wave S5). VARIABLE LENGTH: the server mints 7 digits and
// escalates to 8-9 under collision pressure; existing accounts carry 8. The
// client accepts 6-12 digits, no leading zero, and passes the string through
// UNCHANGED everywhere — never truncate, never pad. It is the LOOKUP KEY support uses instead
// of an email address, survives an email attach, and never changes — so it can
// ride every support surface automatically and the user never has to copy it.
//
// Source of truth is the session user payload (`user.supportId`, a custom
// Better Auth user field). The launch gate also saves it in the
// `cached_support_id` settings row so the Settings footer and the sign-in gate
// can show it with no session (offline, dead session). Every consumer hides its
// UI when neither has a valid id, per the wave rule "don't guess silently".
//
// CYCLE NOTE: this module imports auth-client, and auth-client imports
// lib/intercom (logoutIntercom) — so lib/intercom must require THIS module
// lazily, never statically.

import { authClient } from '@/lib/auth-client';
import { emailLooksAnonymous } from '@/lib/subscription/email-capture';

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

/** The id to show: the session's when there is one, else the copy saved on
 *  this phone (`cached_support_id`). Both go through the same validation. */
export function resolveSupportId(sessionUser: unknown, cached: string | null): string | null {
  return readSupportIdFromUser(sessionUser) ?? readSupportIdFromUser({ supportId: cached });
}

export type AccountHandle = { kind: 'supportId' | 'email'; value: string };

/** What the Settings footer shows so a person can tell support who they are:
 *  the Support ID, else (an old email account that has none yet) the real
 *  email, never the placeholder address. Null shows nothing. */
export function accountHandle(supportId: string | null, email: string | null): AccountHandle | null {
  if (supportId) return { kind: 'supportId', value: supportId };
  if (email && !emailLooksAnonymous(email)) return { kind: 'email', value: email };
  return null;
}

/**
 * Best-effort read of the CURRENT account's support id, bounded so no support
 * surface ever waits on a dead network: the session's, else the copy saved on
 * this phone (the sign-in gate has no session). Resolves null when neither has
 * one (pre-wave email accounts) — callers hide the id then.
 */
export async function getSupportId(): Promise<string | null> {
  let user: unknown = null;
  try {
    const session = (await Promise.race([
      authClient.getSession(),
      new Promise<null>((resolve) => setTimeout(resolve, SUPPORT_ID_FETCH_TIMEOUT_MS, null)),
    ])) as { data?: { user?: unknown } } | null;
    user = session?.data?.user ?? null;
  } catch {
    // Fall through to the saved copy.
  }
  let cached: string | null = null;
  try {
    // Lazy: the settings service reaches the database, and this module sits in auth-client's graph.
    const { getSetting } = require('@/lib/database/services/setting-service') as typeof import('@/lib/database/services/setting-service');
    cached = await getSetting('cached_support_id');
  } catch {
    cached = null;
  }
  return resolveSupportId(user, cached);
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
