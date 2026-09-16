// harness-local — auth header resolution for the GraphQL/news-api adapter.
//
// target 'local'  → mera-server's GraphQL service runs as a dev-user when
//                    NODE_ENV !== 'production' (no auth headers needed).
// target 'staging'/'prod' → runs the real Better Auth email-OTP flow
//                    (mera-server/apps/mera-server-auth/src/auth.ts:
//                    basePath '/api/auth', emailOTP + bearer() plugins) and
//                    caches the resulting session for ~6 days (Better Auth's
//                    default session length is 7 days).

import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as readline from 'node:readline';

import type { HarnessEnv } from '../config/env';
import { authCachePath } from '../config/local-data';

const SESSION_MAX_AGE_MS = 6 * 24 * 60 * 60 * 1000; // 6 days

interface AuthCache {
  cookie?: string;
  bearer?: string;
  savedAt: string;
  /** How the session was obtained, so a cache written by one path is not
   *  silently reused by a run that asked for the other. */
  method?: 'otp' | 'dev-bypass';
}

/**
 * Headless staging sign-in: POST /device/sign-in/dev with the staging bypass
 * token and a stable deviceId. The route exists ONLY where the auth service has
 * DEVICE_ATTESTATION_DEV_BYPASS_TOKEN set and 404s everywhere else, so it is
 * staging-only by construction, not by convention.
 *
 * This is what makes an unattended staging run possible at all: the email-OTP
 * flow prompts on stdin, which no agent-run or scheduled job can answer.
 *
 * VERIFIED 2026-09-16 against auth.staging.mera.news: sign-in returned 200 with
 * a session token, and GET /api/auth/token then returned a three-segment JWT.
 * So a dev-bypass account is NOT refused a JWT, which is the fact the gateway
 * lane depends on.
 *
 * The token must be the BARE value. A grep/sed that leaves a `key = "` prefix
 * attached produces a 403 DEVICE_ATTESTATION_FAILED that looks exactly like a
 * rotated secret.
 */
async function signInWithDevBypass(
  authEndpoint: string,
  token: string,
  deviceId: string,
): Promise<{ cookie?: string; bearer?: string }> {
  const res = await fetch(`${authEndpoint}/api/auth/device/sign-in/dev`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token, deviceId }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(
      `harness-local: dev-bypass sign-in failed: ${res.status} ${res.statusText}. ` +
        (res.status === 404
          ? 'A 404 means this environment has no DEVICE_ATTESTATION_DEV_BYPASS_TOKEN set, so the route does not exist. Check you are pointed at staging.'
          : `Check the token is the BARE value with no key = " prefix. Body: ${body.slice(0, 200)}`),
    );
  }
  const cookie = extractSetCookie(res);
  let bearer: string | undefined;
  try {
    const body = (await res.json()) as { token?: string; session?: { token?: string } };
    bearer = body?.token ?? body?.session?.token;
  } catch {
    // A cookie alone is enough.
  }
  if (!cookie && !bearer) {
    throw new Error('harness-local: dev-bypass sign-in returned neither a cookie nor a token.');
  }
  return { cookie, bearer };
}

/**
 * Mints a JWT from a session. The gateway wants this, not the session cookie
 * the GraphQL API accepts.
 */
export async function mintJwt(
  authEndpoint: string,
  headers: Record<string, string>,
): Promise<string> {
  const res = await fetch(`${authEndpoint}/api/auth/token`, { headers });
  if (!res.ok) {
    throw new Error(
      `harness-local: JWT mint failed: ${res.status} ${res.statusText}. ` +
        'A 403 here is the subscription gate, not a broken session.',
    );
  }
  const body = (await res.json()) as { token?: string };
  if (!body.token) throw new Error('harness-local: JWT mint returned no token.');
  return body.token;
}

function loadCache(cachePath: string): AuthCache | null {
  if (!fs.existsSync(cachePath)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(cachePath, 'utf-8')) as AuthCache;
    return parsed?.savedAt ? parsed : null;
  } catch {
    return null;
  }
}

function saveCache(cachePath: string, cache: AuthCache): void {
  fs.writeFileSync(cachePath, JSON.stringify(cache, null, 2) + '\n', 'utf-8');
}

function isCacheFresh(cache: AuthCache): boolean {
  const savedAt = Date.parse(cache.savedAt);
  if (Number.isNaN(savedAt)) return false;
  return Date.now() - savedAt < SESSION_MAX_AGE_MS;
}

function promptForOtp(): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question('Enter OTP: ', (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function extractSetCookie(response: Response): string | undefined {
  const withGetSetCookie = response.headers as Headers & { getSetCookie?: () => string[] };
  if (typeof withGetSetCookie.getSetCookie === 'function') {
    const cookies = withGetSetCookie.getSetCookie();
    if (cookies.length > 0) return cookies.map((c) => c.split(';')[0]).join('; ');
  }
  const single = response.headers.get('set-cookie');
  return single ? single.split(';')[0] : undefined;
}

export async function getAuthHeaders(env: HarnessEnv): Promise<Record<string, string>> {
  if (env.target === 'local') {
    return {};
  }

  if (!env.authEndpoint) {
    throw new Error(
      'harness-local: NEWS_HARNESS_AUTH_ENDPOINT is required when NEWS_HARNESS_TARGET is staging/prod.',
    );
  }
  if (!env.authEmail) {
    throw new Error(
      'harness-local: NEWS_HARNESS_AUTH_EMAIL is required when NEWS_HARNESS_TARGET is staging/prod, ' +
        'unless NEWS_HARNESS_DEV_BYPASS_TOKEN is set for a headless staging sign-in.',
    );
  }

  // Resolved per call and per TARGET: a cached session belongs to exactly one
  // environment, and a 6-day-fresh prod cookie replayed into a staging run is
  // a silent wrong-environment read (see config/local-data.ts).
  const cachePath = authCachePath(env.target);

  // Dev bypass first on staging: it is headless, and the OTP flow below cannot
  // run unattended because it prompts on stdin.
  const bypassToken = process.env.NEWS_HARNESS_DEV_BYPASS_TOKEN?.trim();
  const wantsBypass = env.target === 'staging' && Boolean(bypassToken);
  const method: AuthCache['method'] = wantsBypass ? 'dev-bypass' : 'otp';

  const cached = loadCache(cachePath);
  // A cache written by the other method is ignored rather than reused: the two
  // are different accounts, and silently answering as the wrong one is the same
  // class of mistake the per-target namespacing exists to prevent.
  if (cached && isCacheFresh(cached) && (cached.method ?? 'otp') === method) {
    if (cached.cookie) return { Cookie: cached.cookie };
    if (cached.bearer) return { Authorization: `Bearer ${cached.bearer}` };
  }

  if (wantsBypass) {
    const deviceId =
      process.env.NEWS_HARNESS_DEV_DEVICE_ID?.trim() || `harness-${randomUUID()}`;
    const { cookie, bearer } = await signInWithDevBypass(
      env.authEndpoint,
      bypassToken as string,
      deviceId,
    );
    saveCache(cachePath, { cookie, bearer, savedAt: new Date().toISOString(), method: 'dev-bypass' });
    // eslint-disable-next-line no-console
    console.log(`harness-local: signed in to staging via dev bypass (deviceId ${deviceId}).`);
    return cookie ? { Cookie: cookie } : { Authorization: `Bearer ${bearer}` };
  }

  // --- Email OTP sign-in flow (Better Auth emailOTP + bearer plugins) ---
  const sendResponse = await fetch(
    `${env.authEndpoint}/api/auth/email-otp/send-verification-otp`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: env.authEmail, type: 'sign-in' }),
    },
  );
  if (!sendResponse.ok) {
    const text = await sendResponse.text().catch(() => '');
    throw new Error(
      `harness-local: failed to send OTP to ${env.authEmail}: ${sendResponse.status} ${sendResponse.statusText} — ${text}`,
    );
  }

  // eslint-disable-next-line no-console
  console.log(`harness-local: OTP sent to ${env.authEmail}.`);
  const otp = await promptForOtp();

  const signInResponse = await fetch(`${env.authEndpoint}/api/auth/sign-in/email-otp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: env.authEmail, otp }),
  });
  if (!signInResponse.ok) {
    const text = await signInResponse.text().catch(() => '');
    throw new Error(
      `harness-local: sign-in failed for ${env.authEmail}: ${signInResponse.status} ${signInResponse.statusText} — ${text}`,
    );
  }

  const cookie = extractSetCookie(signInResponse);

  let bearer: string | undefined;
  try {
    const body = (await signInResponse.json()) as {
      token?: string;
      session?: { token?: string };
    };
    bearer = body?.token ?? body?.session?.token;
  } catch {
    // Non-JSON body is fine as long as we got a cookie.
  }

  if (!cookie && !bearer) {
    throw new Error(
      'harness-local: sign-in succeeded but no session cookie or bearer token was returned.',
    );
  }

  saveCache(cachePath, { cookie, bearer, savedAt: new Date().toISOString(), method: 'otp' });

  // Prefer the session cookie (the server accepts it directly); bearer() also
  // works via Authorization: Bearer <token> if only a token came back.
  if (cookie) return { Cookie: cookie };
  return { Authorization: `Bearer ${bearer}` };
}
