// harness-local — auth header resolution for the GraphQL/news-api adapter.
//
// target 'local'  → mera-server's GraphQL service runs as a dev-user when
//                    NODE_ENV !== 'production' (no auth headers needed).
// target 'staging'/'prod' → a TEST account, the only way onto a non-local
//                    target: NEWS_HARNESS_TEST_ACCOUNT_TOKEN and
//                    NEWS_HARNESS_TEST_ACCOUNT_HANDLE (headless, both
//                    environments). The session is cached per handle.

import * as fs from 'node:fs';

import type { HarnessEnv } from '../config/env';
import { authCachePath } from '../config/local-data';

/** Test-account sessions live 24h server side; reuse a cached one for less. */
const TEST_SESSION_MAX_AGE_MS = 20 * 60 * 60 * 1000;

interface AuthCache {
  cookie?: string;
  bearer?: string;
  savedAt: string;
  /** How the session was obtained; only test-account caches are reused. */
  method?: 'test-account';
  /** The test-account handle a 'test-account' cache belongs to. */
  handle?: string;
}

/** The server's handle rule, verbatim (lib/device-auth.ts holds the app's copy). */
export const TEST_ACCOUNT_HANDLE_PATTERN = /^[a-z0-9][a-z0-9-]{1,39}$/;

export type TestAccountRoute = 'sign-in' | 'delete' | 'list';

export interface TestAccountResponse {
  status: number;
  body: unknown;
  /** The session cookie a sign-in set. */
  cookie?: string;
}

/**
 * One call to the test-account routes (POST /api/auth/test-account/<route>,
 * staging and prod). The token travels in the body only; nothing here ever
 * puts it in an error or a log. A wrong, missing or disabled token is an
 * identical 404, by design: the server offers no oracle.
 */
export async function callTestAccountRoute(
  authEndpoint: string,
  token: string,
  route: TestAccountRoute,
  handle?: string,
): Promise<TestAccountResponse> {
  if (handle !== undefined && !TEST_ACCOUNT_HANDLE_PATTERN.test(handle)) {
    throw new Error(`harness-local: invalid test account handle '${handle}' (want ${TEST_ACCOUNT_HANDLE_PATTERN}).`);
  }
  const res = await fetch(`${authEndpoint}/api/auth/test-account/${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(handle === undefined ? { token } : { token, handle }),
  });
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    // An empty or non-JSON body; the status says enough.
  }
  return { status: res.status, body, cookie: extractSetCookie(res) };
}

async function signInWithTestAccount(
  authEndpoint: string,
  token: string,
  handle: string,
): Promise<{ cookie?: string; bearer?: string }> {
  const { status, body, cookie } = await callTestAccountRoute(authEndpoint, token, 'sign-in', handle);
  if (status < 200 || status >= 300) {
    throw new Error(
      `harness-local: test-account sign-in failed: ${status}. ` +
        (status === 404
          ? 'A 404 means a wrong or missing token, test accounts disabled, or the route not deployed (the server answers all four the same).'
          : 'See the auth service logs.'),
    );
  }
  const typed = body as { token?: string; session?: { token?: string } } | null;
  const bearer = typed?.token ?? typed?.session?.token;
  if (!cookie && !bearer) throw new Error('harness-local: test-account sign-in returned neither a cookie nor a token.');
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

function isCacheFresh(cache: AuthCache, maxAgeMs: number): boolean {
  const savedAt = Date.parse(cache.savedAt);
  if (Number.isNaN(savedAt)) return false;
  return Date.now() - savedAt < maxAgeMs;
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
  // The only way onto a non-local target: headless, and it works on both
  // staging and prod. Cached per handle in its own file.
  const testToken = process.env.NEWS_HARNESS_TEST_ACCOUNT_TOKEN?.trim();
  const testHandle = process.env.NEWS_HARNESS_TEST_ACCOUNT_HANDLE?.trim();
  if (!testToken || !testHandle) {
    throw new Error(
      'harness-local: NEWS_HARNESS_TEST_ACCOUNT_TOKEN and NEWS_HARNESS_TEST_ACCOUNT_HANDLE are required when ' +
        'NEWS_HARNESS_TARGET is staging/prod. A test account is the only sign-in the harness supports there.',
    );
  }
  const testCachePath = authCachePath(env.target, testHandle);
  const cachedTest = loadCache(testCachePath);
  if (cachedTest && isCacheFresh(cachedTest, TEST_SESSION_MAX_AGE_MS) && cachedTest.method === 'test-account' && cachedTest.handle === testHandle) {
    if (cachedTest.cookie) return { Cookie: cachedTest.cookie };
    if (cachedTest.bearer) return { Authorization: `Bearer ${cachedTest.bearer}` };
  }
  const { cookie, bearer } = await signInWithTestAccount(env.authEndpoint, testToken, testHandle);
  saveCache(testCachePath, { cookie, bearer, savedAt: new Date().toISOString(), method: 'test-account', handle: testHandle });
  console.log(`harness-local: signed in to ${env.target} test account '${testHandle}'.`);
  return cookie ? { Cookie: cookie } : { Authorization: `Bearer ${bearer}` };
}
