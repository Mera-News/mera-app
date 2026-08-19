// Centralised EXPO_PUBLIC_* endpoint resolution.
//
// Why this file exists: `process.env.EXPO_PUBLIC_*` is replaced with a string
// literal by Babel/Metro at TRANSFORM time, per file. Metro caches transformed
// output per file, and the cache key does NOT include `.env` values. So if
// `.env` changes and only some source files get re-transformed (because their
// contents changed), unchanged files keep their stale inlined values — and
// you end up with a single bundle where two modules disagree on the same
// endpoint URL.
//
// Funnelling every read through this one module means there is exactly ONE
// cached transform output for each endpoint string. Either it's fresh and
// every consumer sees the correct value, or it's stale and every consumer
// sees the same stale value — but they can never disagree. Consumers import
// the named constant and never touch `process.env` directly.
//
// Missing-env policy: fail loud at module load. Falling back to a localhost
// default in a prod build is worse than crashing — it produces silent
// connect failures that look like server outages. We capture to Sentry on
// the way out (sentry-init runs first in every entry point) and re-throw.
//
// Cache-bust marker (bump when env values change): 2026-08-13a (Intercom keys added)

import * as Sentry from '@sentry/react-native';

function requireEnv(name: string, value: string | undefined): string {
  if (!value) {
    const err = new Error(
      `[config/endpoints] Missing required env var EXPO_PUBLIC_${name}. ` +
        `Check the .env used to build / publish this bundle. ` +
        `Copy .env.example to .env and set this value.`,
    );
    // Sentry.init runs first (sentry-init.ts is the first import in every
    // entry point). If it somehow didn't, captureException is a no-op rather
    // than a crash, and the throw below still surfaces via the React Native
    // unhandled-exception handler.
    try {
      Sentry.captureException(err, {
        tags: { module: 'config/endpoints', missing: name },
      });
    } catch {
      // Sentry not initialised yet — fall through to the throw.
    }
    throw err;
  }
  return value;
}

export const INFERENCE_ENDPOINT = requireEnv(
  'INFERENCE_ENDPOINT',
  process.env.EXPO_PUBLIC_INFERENCE_ENDPOINT,
);

export const AUTH_ENDPOINT = requireEnv(
  'AUTH_ENDPOINT',
  process.env.EXPO_PUBLIC_AUTH_ENDPOINT,
);

export const GRAPHQL_SERVER_ENDPOINT = requireEnv(
  'GRAPHQL_SERVER_ENDPOINT',
  process.env.EXPO_PUBLIC_GRAPHQL_SERVER_ENDPOINT,
);

// Optional dev-only flag — absence means "off", which is the safe production
// default. Not gated by requireEnv.
//
// The `__DEV__ &&` interlock is the actual security control: `__DEV__` is a
// Metro-injected boolean literal that is `false` in any release/production
// build, so the whole right-hand side dead-code-eliminates to `false` in a
// release bundle regardless of what EXPO_PUBLIC_DUMP_QUERY_FOR_DEBUGGING was
// set to at bundle time. This makes the plaintext prompt dump branch
// (submitInferenceJob.ts) statically unreachable in release — it can never
// ship enabled, only run in a dev bundle.
export const DUMP_QUERIES_ENABLED =
  __DEV__ && process.env.EXPO_PUBLIC_DUMP_QUERY_FOR_DEBUGGING === 'true';

// RevenueCat public SDK keys. Optional (not requireEnv): subscriptions degrade
// gracefully — when unset, configureRevenueCat() no-ops and the paywall isn't
// shown. The generic Test Store key (`test_…`) works on both platforms in
// development; production uses platform-specific App Store (`appl_`) / Play
// Store (`goog_`) keys. Platform selection happens in lib/revenuecat.ts at call
// time so this module stays free of react-native imports (it loads extremely
// early, before any native module is mockable in tests).
export const REVENUECAT_API_KEY: string =
  process.env.EXPO_PUBLIC_REVENUECAT_API_KEY || '';
export const REVENUECAT_IOS_KEY: string =
  process.env.EXPO_PUBLIC_REVENUECAT_IOS_KEY || '';
export const REVENUECAT_ANDROID_KEY: string =
  process.env.EXPO_PUBLIC_REVENUECAT_ANDROID_KEY || '';

// Intercom keys for the in-app support Messenger. Optional (not requireEnv) for
// the same reason as the RevenueCat trio above: support degrades to a mailto:
// link when unset, and a missing key must never crash launch.
//
// Both an app id AND a platform key are required — unlike RevenueCat there is
// no generic cross-platform key, and Intercom.initialize() rejects on a key
// that does not start with `ios_sdk-` / `android_sdk-`. Platform selection
// happens in lib/intercom.ts at call time so this module stays free of
// react-native imports (it loads extremely early, before any native module is
// mockable in tests).
export const INTERCOM_APP_ID: string =
  process.env.EXPO_PUBLIC_INTERCOM_APP_ID || '';
export const INTERCOM_IOS_KEY: string =
  process.env.EXPO_PUBLIC_INTERCOM_IOS_KEY || '';
export const INTERCOM_ANDROID_KEY: string =
  process.env.EXPO_PUBLIC_INTERCOM_ANDROID_KEY || '';

// Google OAuth client ids, for the Drive backup provider. Optional (not
// requireEnv) for the same reason as the two groups above: a build without them
// must still launch, and Drive simply reports itself unavailable.
//
// Both are PUBLIC identifiers, inlined into the bundle and shipped in the
// binary by design. The web client's SECRET is never used by the mobile SDK and
// must not appear anywhere in this app.
//
// The web id is needed on BOTH platforms despite its name — it is the audience
// the ID token is minted for, not a website's id. There is deliberately no
// ANDROID id: that client is matched implicitly by package name plus SHA-1
// signing certificate and its id is never passed to the SDK.
export const GOOGLE_WEB_CLIENT_ID: string =
  process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID || '';
export const GOOGLE_IOS_CLIENT_ID: string =
  process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID || '';

// Dev-only override for the mandatory-update gate. The gate skips in dev builds
// by default so the team isn't locked out while the server's min-version floor
// is set high; set EXPO_PUBLIC_FORCE_UPDATE_IN_DEV=true to exercise it locally.
// Same `__DEV__ &&` interlock as above: this is only ever consulted in dev — a
// release build runs the gate unconditionally regardless of this value.
export const FORCE_UPDATE_CHECK_IN_DEV =
  __DEV__ && process.env.EXPO_PUBLIC_FORCE_UPDATE_IN_DEV === 'true';
