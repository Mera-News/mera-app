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

import { getStaticAppContext } from './observability/app-context';

// Note: this file intentionally does NOT import from ./config/endpoints.
// sentry-init must initialise Sentry before anything else so that any later
// module-load throw (including endpoints.ts asserting required env vars)
// is captured by Sentry's global handler. Importing endpoints here would
// reverse that order and the bootstrap failure would go unreported.
//
// ./observability/app-context is the ONE exception, and only because it is
// store-free and reads nothing at module scope (every native read happens
// inside getStaticAppContext(), which is called defensively below). The
// runtime half — ./observability/runtime-context.ts — must NEVER be imported
// here: it pulls in five Zustand stores, and those reach apollo-client →
// auth-client, i.e. exactly the cycle this file's ordering rule exists to
// avoid. The runtime tags are pushed onto the scope later by
// ./observability/sentry-scope.ts instead.

// WHAT beforeSend CAN AND CANNOT DO — read before relying on it.
// beforeSend runs in JS, so it only sees events the JS layer sends. NATIVE
// crashes are captured and uploaded by the native SDK directly and never pass
// through here. The real control is therefore always at the SET site: never put
// a value on the scope that must not leave the device. Everything below is
// belt-and-suspenders for the JS path only.

// Blunt cap for free-form string payloads. `extra` blobs and breadcrumb `data`
// across the codebase carry server response bodies, prompts, and other
// model/user-derived content; anything longer than this is replaced with a
// redaction marker so partial plaintext/PII can't ride out on an event.
const MAX_PII_STRING_LEN = 200;

// The length cap alone is not enough: the highest-value leaks are SHORT. A
// userId, an email address, a topic string, or an article title all fit inside
// 200 chars and would sail through untouched. So any key whose NAME suggests
// identity or user-derived content is redacted regardless of its value.
//
// Matching is a case-insensitive SUBSTRING test on the key name, deliberately:
// `userEmail`, `X-Authorization`, `promptTokens` and `topicText` must all hit,
// and for a privacy control over-redaction is the safe direction to err in
// (`keyboard` matching `key` costs us nothing but a diagnostic we didn't need).
const REDACTED_KEY_PATTERN =
  /email|token|statement|topics?|text|title|prompt|content|cookie|key|secret|password|authorization/i;

/**
 * In-place scrub of a free-form payload: denylisted keys are dropped outright,
 * over-long strings are replaced with a length marker, and nested objects AND
 * arrays are walked.
 *
 * Arrays used to be skipped (`!Array.isArray(value)`), which meant a plain
 * `string[]` of prompts or article titles bypassed the cap entirely — the exact
 * shape logger.info/captureException call sites push most often.
 */
function scrubEventValues(
  container: Record<string, unknown> | unknown[] | undefined,
): void {
  if (!container) return;

  if (Array.isArray(container)) {
    // Array elements have no key name, so only the length cap applies here.
    for (let i = 0; i < container.length; i++) {
      const value = container[i];
      if (typeof value === 'string' && value.length > MAX_PII_STRING_LEN) {
        container[i] = `[redacted:${value.length}]`;
      } else if (value !== null && typeof value === 'object') {
        scrubEventValues(value as Record<string, unknown> | unknown[]);
      }
    }
    return;
  }

  for (const key of Object.keys(container)) {
    const value = container[key];
    if (REDACTED_KEY_PATTERN.test(key)) {
      // Null/undefined carry nothing; leave them so "the field was absent"
      // stays distinguishable from "the field was scrubbed".
      if (value !== null && value !== undefined) container[key] = '[redacted:key]';
      continue;
    }
    if (typeof value === 'string' && value.length > MAX_PII_STRING_LEN) {
      container[key] = `[redacted:${value.length}]`;
    } else if (value !== null && typeof value === 'object') {
      scrubEventValues(value as Record<string, unknown> | unknown[]);
    }
  }
}

// Sentry is production-only by default. Set EXPO_PUBLIC_SENTRY_IN_DEV=true in a
// local .env to force-initialise it in a dev build — needed to exercise the
// User Feedback widget (showFeedbackWidget) and other Sentry UI from `expo start`.
// The feedback helper (lib/feedback.ts) reads this same flag so both gates lift
// together.
export const SENTRY_ENABLED =
  !__DEV__ || process.env.EXPO_PUBLIC_SENTRY_IN_DEV === 'true';

if (SENTRY_ENABLED) {
  Sentry.init({
    dsn: process.env.EXPO_PUBLIC_SENTRY_DSN,
    // Separates dev-machine events (opted in via EXPO_PUBLIC_SENTRY_IN_DEV) from
    // real production traffic in the Sentry issue stream. Without this, a local
    // dev run with the flag set pollutes prod issues with local file paths.
    environment: __DEV__ ? 'development' : 'production',
    // Do NOT auto-attach IP address, request headers, or OS-user identifiers to
    // events. This is a privacy/E2EE product; nothing relies on server-side PII
    // inference.
    //
    // THE USER CONTRACT: `user.id` ONLY, and it is the raw better-auth userId —
    // the same value that is RevenueCat's app_user_id and our UserBilling.userId,
    // which is what makes "this crash, that subscriber" answerable at all. It is
    // set in exactly one place (./observability/sentry-scope.ts) and cleared on
    // logout from both sign-out paths. NEVER email, username, ip_address, phone,
    // push token, or an ad identifier — and nothing derived from persona facts,
    // topics, interests, locations or reading history, in tags or contexts
    // either. See the note above on why beforeSend cannot be the control here.
    sendDefaultPii: false,
    integrations: [
      // We render the feedback form ourselves via the <FeedbackWidget> component
      // (components/custom/FeedbackWidgetModal.tsx) so its labels can be
      // localized — the native showFeedbackWidget() freezes English labels at
      // init, before the user's language is applied. This integration stays
      // registered only to supply the widget's THEME (FeedbackWidget reads
      // colorScheme/themeDark via getTheme()); labels and general config
      // (showName, enableTakeScreenshot, …) live on the component. Dark-mode-only
      // app; the accent colors style the submit button to brand purple
      // (Mera orange, primary-400 = rgb(231,138,83)).
      Sentry.feedbackIntegration({
        colorScheme: 'dark',
        themeDark: {
          background: '#000000',
          foreground: '#ffffff',
          accentBackground: 'rgb(231,138,83)',
          accentForeground: '#000000',
        },
      }),
    ],
    // Defensive scrubber: strip residual PII and cap free-form payloads
    // regardless of the flag above, so a future regression can't leak content.
    beforeSend(event) {
      // Keep `user.id` (the join key — see the sendDefaultPii note above) and
      // discard every other user field, whether the SDK attached it or a future
      // contributor set it. Allowlisting rather than deleting known-bad keys
      // means a field Sentry adds in a later SDK version is dropped by default.
      if (event.user) {
        const id = typeof event.user.id === 'string' ? event.user.id : undefined;
        if (id) event.user = { id };
        else delete event.user;
      }
      // Null out request headers/cookies if present.
      if (event.request) {
        delete event.request.cookies;
        delete event.request.headers;
      }
      // Scrub free-form extra payloads (response bodies, prompt metadata, etc.).
      scrubEventValues(event.extra);
      // Scrub breadcrumb data values (logger.info/warn/debug push free-form data).
      if (event.breadcrumbs) {
        for (const crumb of event.breadcrumbs) {
          scrubEventValues(crumb.data);
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

  // Build/device facts, set as TAGS (filterable, and — unlike a local scope —
  // bridged to the native layer at set time by enableSyncToNative, so they
  // survive a native crash) plus one context block for readability when you're
  // already looking at an event. `ota_update_id` is the reason this exists:
  // Sentry's `release` only tracks the native build, so without it an
  // OTA-introduced crash cannot be pinned to the JS bundle that caused it.
  //
  // Wrapped because these are native-module reads and this file is the app's
  // FIRST import — a throw here would take down the whole bundle before Sentry
  // has anything useful to report about it.
  try {
    const appContext = getStaticAppContext();
    // Emitted one-by-one rather than via setTags: it keeps the values that
    // reach native identical either way, and setTag is the API every other
    // call site in the app already uses.
    for (const [key, value] of Object.entries(appContext)) {
      Sentry.setTag(key, String(value));
    }
    Sentry.setContext('mera_app_build', { ...appContext });
  } catch {
    // Diagnostics are never worth a boot failure. The event still ships, just
    // without build attribution.
  }
}
