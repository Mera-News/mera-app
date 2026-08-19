// The x-mera-client header value: tells mera-server which app version is
// talking to it during the weeks of client-server skew between an EAS release
// and full adoption. The server parses exactly
//
//   <platform>/<app_version>+<app_build> rt/<runtime_version>
//   e.g. ios/1.3.0+412 rt/1.3.0
//
// and treats absent or malformed values (over 120 chars, control characters,
// missing the +build or rt/ segment) as "unknown client", never as an error.
// So the fallback on any local failure is NO header, not a best-effort one.
//
// PRIVACY: build metadata only, same contract as ./app-context.ts (its sole
// input). Nothing user-identifying may enter this value.

import { getStaticAppContext, type StaticAppContext } from './app-context';

/** Lowercase on the wire; the server matches it case-insensitively anyway. */
export const CLIENT_HEADER_NAME = 'x-mera-client';

/** The server rejects longer values, which would read as "unknown client". */
const MAX_VALUE_LENGTH = 120;

/** Control characters make the server reject the whole value; strip them. */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/g;

/**
 * Pure formatter, exported for tests. Returns null when the assembled value
 * would exceed the server's 120-char bound — sending no header (= "unknown
 * client") beats sending a truncated value the server would reject anyway.
 */
export function formatClientHeader(ctx: StaticAppContext): string | null {
  const clean = (s: string) => s.replace(CONTROL_CHARS, '');
  const value = `${clean(ctx.platform).toLowerCase()}/${clean(ctx.app_version)}+${clean(ctx.app_build)} rt/${clean(ctx.runtime_version)}`;
  return value.length > MAX_VALUE_LENGTH ? null : value;
}

/**
 * Computed ONCE at module scope and reused for every GraphQL request.
 * getStaticAppContext() is not internally guarded and `Updates.updateId` is a
 * native read that can throw (e.g. pre-first-unlock on a background-push
 * wake) — an unguarded per-request call would fail every GraphQL request.
 * Same defensive shape as lib/sentry-init.ts around its own call: a missing
 * header is never worth a failed request. Null means "send no header".
 */
export const clientHeaderValue: string | null = (() => {
  try {
    return formatClientHeader(getStaticAppContext());
  } catch {
    return null;
  }
})();
