// Anonymous-account email helpers. Every account signs in with its phone and has no real
// email: the server fabricates one under `anon.mera.news`.

export const ANON_EMAIL_DOMAIN = 'anon.mera.news';

/** True when this email is the server-fabricated anonymous placeholder (or
 *  absent entirely). */
export function emailLooksAnonymous(email: string | null | undefined): boolean {
  if (!email) return true;
  return email.toLowerCase().endsWith(`@${ANON_EMAIL_DOMAIN}`);
}
