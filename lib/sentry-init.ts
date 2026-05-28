// Initialise Sentry at module-load time so it's available in background
// contexts. The TaskManager task in lib/background/inference-task.ts is
// defined and run by iOS/Android when a silent push wakes the JS context,
// often without rendering the React tree — so Sentry.init must not live in
// a component body. Both app/_layout.tsx and lib/background/inference-task.ts
// import this module on their first line.
//
// Sentry.init is idempotent (subsequent calls are no-ops), so importing
// from both entry paths is safe.

import * as Sentry from '@sentry/react-native';

// Note: this file intentionally does NOT import from ./config/endpoints.
// sentry-init must initialise Sentry before anything else so that any later
// module-load throw (including endpoints.ts asserting required env vars)
// is captured by Sentry's global handler. Importing endpoints here would
// reverse that order and the bootstrap failure would go unreported.

// Blunt cap for free-form string payloads. `extra` blobs and breadcrumb `data`
// across the codebase carry server response bodies, prompts, and other
// model/user-derived content; anything longer than this is replaced with a
// redaction marker so partial plaintext/PII can't ride out on an event.
const MAX_PII_STRING_LEN = 200;

function capStringValues(
  obj: Record<string, unknown> | undefined,
): void {
  if (!obj) return;
  for (const key of Object.keys(obj)) {
    const value = obj[key];
    if (typeof value === 'string' && value.length > MAX_PII_STRING_LEN) {
      obj[key] = `[redacted:${value.length}]`;
    }
  }
}

if (!__DEV__) {
  Sentry.init({
    dsn: process.env.EXPO_PUBLIC_SENTRY_DSN,
    // Do NOT auto-attach IP address, request headers, or OS-user identifiers to
    // events. This is a privacy/E2EE product; nothing relies on server-side PII
    // inference (logger.setUser is never called). The beforeSend scrubber below
    // is a belt-and-suspenders defense in case a future contributor re-adds it.
    sendDefaultPii: false,
    integrations: [Sentry.feedbackIntegration()],
    // Defensive scrubber: strip residual PII and cap free-form payloads
    // regardless of the flag above, so a future regression can't leak content.
    beforeSend(event) {
      // Drop any IP / id / email the SDK or a future setUser would attach.
      delete event.user;
      // Null out request headers/cookies if present.
      if (event.request) {
        delete event.request.cookies;
        delete event.request.headers;
      }
      // Cap free-form extra payloads (response bodies, prompt metadata, etc.).
      capStringValues(event.extra);
      // Cap breadcrumb data values (logger.info/warn/debug push free-form data).
      if (event.breadcrumbs) {
        for (const crumb of event.breadcrumbs) {
          capStringValues(crumb.data);
        }
      }
      return event;
    },
  });

  // Attach the inlined EXPO_PUBLIC_* values as a global context so every event
  // (watchdog, 404, anything) carries the endpoints the running bundle was
  // actually built against. Critical for diagnosing "why is prod hitting an
  // ngrok URL?" — these values are baked at Metro bundle time and never
  // change at runtime, so they reflect the bundle the user is currently
  // executing, not the current state of .env on the dev machine.
  // Safe to send: EXPO_PUBLIC_* are public by definition and already shipped
  // in the JS bundle.
  Sentry.setContext('runtime_endpoints', {
    auth: process.env.EXPO_PUBLIC_AUTH_ENDPOINT ?? null,
    graphql: process.env.EXPO_PUBLIC_GRAPHQL_SERVER_ENDPOINT ?? null,
    inference: process.env.EXPO_PUBLIC_INFERENCE_ENDPOINT ?? null,
  });

  // Also expose `inference` as a tag so it's filterable/searchable in the
  // Sentry UI without expanding the context blob on every event.
  Sentry.setTag(
    'inference_endpoint',
    process.env.EXPO_PUBLIC_INFERENCE_ENDPOINT ?? 'unset',
  );
}
