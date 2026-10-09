// E2E mode: the device test lane (scripts/e2e-android.sh) builds with .env.e2e. It is on only when
// the flag is '1' AND all three endpoints are loopback, so a stale or leaked flag can never act on
// a real backend. Total: a missing or unparseable endpoint gives false and never throws (legacy
// suites mock lib/config/endpoints partially).
//
// This file is the one funnel for process.env.EXPO_PUBLIC_E2E (Metro inlines it per file; see the
// cache note in lib/config/endpoints.ts). Not gated on __DEV__: the e2e APK is a release build.
import * as endpoints from '@/lib/config/endpoints';

const LOOPBACK = new Set(['localhost', '127.0.0.1', '10.0.2.2']);

export interface E2EModeInput {
  flag: string | undefined;
  graphql: unknown;
  auth: unknown;
  inference: unknown;
}

function isLoopbackUrl(value: unknown): boolean {
  if (typeof value !== 'string' || value === '') return false;
  try {
    return LOOPBACK.has(new URL(value).hostname);
  } catch {
    return false;
  }
}

export function isE2EMode(i: E2EModeInput): boolean {
  return (
    i.flag === '1' &&
    [i.graphql, i.auth, i.inference].every(isLoopbackUrl)
  );
}

// The namespace read makes a partial jest.mock of endpoints give undefined, never a throw.
const e = endpoints as Record<string, unknown>;
export const E2E_MODE: boolean = isE2EMode({
  flag: process.env.EXPO_PUBLIC_E2E,
  graphql: e.GRAPHQL_SERVER_ENDPOINT,
  auth: e.AUTH_ENDPOINT,
  inference: e.INFERENCE_ENDPOINT,
});
