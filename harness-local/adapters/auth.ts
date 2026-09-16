// harness-local — auth header resolution for the GraphQL/news-api adapter.
//
// target 'local'  → mera-server's GraphQL service runs as a dev-user when
//                    NODE_ENV !== 'production' (no auth headers needed).
// target 'staging'/'prod' → runs the real Better Auth email-OTP flow
//                    (mera-server/apps/mera-server-auth/src/auth.ts:
//                    basePath '/api/auth', emailOTP + bearer() plugins) and
//                    caches the resulting session for ~6 days (Better Auth's
//                    default session length is 7 days).

import * as fs from 'node:fs';
import * as readline from 'node:readline';

import type { HarnessEnv } from '../config/env';
import { authCachePath } from '../config/local-data';

const SESSION_MAX_AGE_MS = 6 * 24 * 60 * 60 * 1000; // 6 days

interface AuthCache {
  cookie?: string;
  bearer?: string;
  savedAt: string;
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
      'harness-local: NEWS_HARNESS_AUTH_EMAIL is required when NEWS_HARNESS_TARGET is staging/prod.',
    );
  }

  // Resolved per call and per TARGET: a cached session belongs to exactly one
  // environment, and a 6-day-fresh prod cookie replayed into a staging run is
  // a silent wrong-environment read (see config/local-data.ts).
  const cachePath = authCachePath(env.target);

  const cached = loadCache(cachePath);
  if (cached && isCacheFresh(cached)) {
    if (cached.cookie) return { Cookie: cached.cookie };
    if (cached.bearer) return { Authorization: `Bearer ${cached.bearer}` };
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

  saveCache(cachePath, { cookie, bearer, savedAt: new Date().toISOString() });

  // Prefer the session cookie (the server accepts it directly); bearer() also
  // works via Authorization: Bearer <token> if only a token came back.
  if (cookie) return { Cookie: cookie };
  return { Authorization: `Bearer ${bearer}` };
}
