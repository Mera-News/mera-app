import * as Sentry from '@sentry/react-native';
import { AppState } from 'react-native';

type LogLevel = 'debug' | 'info' | 'warning' | 'error' | 'fatal';

interface LogContext {
  [key: string]: unknown;
}

interface CaptureExceptionOptions {
  level?: LogLevel;
  tags?: Record<string, string>;
  extra?: Record<string, unknown>;
  fingerprint?: string[];
  /**
   * INTERNAL. Opts out of captureMessage's default `fingerprint: [message]`.
   *
   * Set by `logger.error(message)` alone. The default is correct for the 11
   * DIRECT captureMessage callers because every one of them emits a static
   * string, so the text is a stable identity. `logger.error` is the opposite
   * case: its messages are routinely built with template literals, so
   * defaulting there would split one condition across an issue per distinct
   * string. That path keeps grouping on its stack, unchanged.
   */
  _groupByStack?: true;
}

// THE SUPPRESSION RULES, APPLIED ONCE.
//
// Five classes of exception never become a Sentry issue, and the rule lives
// HERE rather than at the catch sites. Each of them was a per-site opt-in once,
// and in every case the rule was correct and its COVERAGE was the bug: a
// predicate applied by hand at three or four places leaves every other catch in
// the app reporting the same fact. `isUnauthenticatedError` was defined once in
// lib/utils/retry.ts and applied at three sites while a fourth kept firing; the
// offline gate lived only in the Apollo error link while ArticleService's own
// catch re-reported every offline failure above it (MERA-APP-77); and
// `isTransientNetworkError` is still hand-applied at six unrelated sites.
//
//   cancelled   A screen unmount, a superseded refresh, a scheduler task torn
//               down mid-flight. Dropped outright — nobody can act on it and it
//               is not evidence of anything (MERA-APP-6W).
//
//   auth        A 401. One dead session makes every query in the app fail the
//               same way, so capturing each buys hundreds of duplicates for one
//               root cause. Becomes a breadcrumb and feeds recordAuthFailure();
//               the auth circuit breaker's single trip event stays the ONLY
//               Sentry signal for a dead session. That is the whole design in
//               lib/auth-failure-breaker.ts and it only works while nothing
//               else reports the same fact.
//
//   offline     A network-shaped failure on a device that has told us it has no
//               link. It carries no information: the request was doomed before
//               it left. The user is already told (the offline band, and
//               Explore's own empty state), and recordServerTransportFailure()
//               in the Apollo error link runs BEFORE the reporting decision, so
//               suppressing the event cannot blind the reachability latch.
//               MERA-APP-77 (offline Explore fetch) and MERA-APP-78 (offline
//               Expo push-token fetch, which is not even a GraphQL call and so
//               could never be covered by the link's gate).
//
//   backgrounded-timeout
//               Our own 30s client abort (lib/apollo-fetch.ts) raised while the
//               app is not foreground. iOS deprioritises a backgrounded app's
//               sockets, the run is retried on the next tick or foreground, and
//               nothing user-visible depends on it. MERA-APP-79.
//
//   no-credential
//               The device has no E2EE keypair yet (or it was cleared), so a
//               call that needs one cannot be made. A state, not a defect.
//               Deliberately does NOT call recordAuthFailure(): the session may
//               be perfectly healthy, and feeding the auth breaker here would
//               trip it and pause feed-sync over a missing local key.
//
// WHAT THIS DOES NOT COVER. beforeSend (lib/sentry-init.ts) is not the choke
// point and must not become one: it cannot read a store (that file is the app's
// first import and the module cycle is why it is shaped the way it is), and it
// would drop the breadcrumb along with the event. It stays the privacy
// scrubber. NATIVE crashes reach neither. And `captureMessage` deliberately
// does NOT pass through here — every class below is defined by an ERROR
// OBJECT's shape, and the one recurring message in this area is the auth
// breaker's trip event, which is precisely the signal the auth rule preserves.
//
// The predicates are lazy-required for the reason auth-failure-breaker.ts
// documents: logger is imported by nearly every module, so a static import of
// utils/retry, utils/transient-error, apollo-fetch or the network store would
// form a cycle at module-eval time. Failing open (reporting the event) is the
// safe direction on any throw.
export type SuppressionClass =
  | 'auth'
  | 'cancelled'
  | 'offline'
  | 'backgrounded-timeout'
  | 'no-credential';

/**
 * Exported so the ONE reporting path that cannot go through captureException
 * still gets the same answer. lib/scheduler/scheduler-runner.ts calls Sentry
 * directly inside a withScope (to attach its `scheduler.*` tags) and used to
 * hand-repeat two of these checks; it now calls this instead, so a class added
 * here reaches it for free. Any future direct-to-Sentry path must do the same.
 */
export function classifySuppression(
  error: Error,
  options: CaptureExceptionOptions = {},
): SuppressionClass | null {
  // Duck-typed on the NAME so logger never imports lib/e2ee — that module
  // reaches the stores and apollo-client, i.e. exactly the cycle this file
  // avoids. Checked before anything that consults connectivity: a missing
  // keypair is a local state and has nothing to do with the network.
  if (error?.name === 'NoCredentialError') return 'no-credential';

  try {
    const { isUnauthenticatedError, isCancellationError } =
      require('./utils/retry') as typeof import('./utils/retry');
    if (isCancellationError(error)) return 'cancelled';
    if (isUnauthenticatedError(error)) return 'auth';
  } catch {
    // Predicate unavailable (test harness, partial module graph) — report it.
  }
  // A hand-built `new Error(\`... failed ${res.status}\`)` carries its status in
  // the TEXT, where no predicate can reach it — that shape is what kept
  // e2ee-service and submitInferenceJob reporting dead sessions after the rule
  // existed. Both now attach `statusCode` to the error, but the status is also
  // routinely passed here as a tag or extra, so honour that too rather than
  // depending on every future call site remembering the field.
  // Strict `=== 401` against the NUMBER on purpose: `extra.status` is a generic
  // field and other call sites pass a domain status STRING through it
  // (fact-check-record-service's 'pending'/'done'), which must never be read as
  // an auth failure and silently swallowed.
  if (options.tags?.status === '401' || options.extra?.status === 401) return 'auth';

  try {
    const { isTransientNetworkError } =
      require('./utils/transient-error') as typeof import('./utils/transient-error');
    const { useNetworkStore } =
      require('./stores/network-store') as typeof import('./stores/network-store');

    // `=== false`, never `!isConnected`. `isConnected` is seeded optimistically
    // to "assume online" until NetInfo's first fetch resolves (the rationale is
    // written out at lib/apollo-client.ts:199-208), so "not yet known" must
    // fall on the REPORT side. And `isConnected` (raw device link), never
    // `isOnline()` — that one is a LATCH meaning "Mera's GraphQL has been
    // unhealthy", which is a different question, and reading it here would
    // suppress exactly the server-down evidence we most want.
    //
    // THE COST, stated: isTransientNetworkError matches bare 'timeout',
    // 'aborted', 'offline' and 'network request failed' anywhere in a message,
    // so it is far too broad to use alone — the conjunction with a CONFIRMED
    // offline device is doing all the work. A non-network defect whose message
    // happens to contain one of those substrings, thrown while the device has
    // no link, degrades to a breadcrumb. Accepted: in that window "the device
    // is offline" is the dominant explanation for anything failing at all.
    if (
      useNetworkStore.getState().isConnected === false &&
      isTransientNetworkError(error)
    ) {
      return 'offline';
    }
  } catch {
    // Store or predicate unavailable — report it.
  }

  try {
    const { isRequestTimeoutError } =
      require('./apollo-fetch') as typeof import('./apollo-fetch');
    // Only OUR marked 30s abort, never a bare AbortError: Apollo aborts on
    // unsubscribe with the same shape, and that is a cancellation (already
    // handled above). A synchronous property read of AppState.currentState,
    // deliberately — no listener, no subscription, nothing at import time, in a
    // module that sits under almost every other module in the app.
    if (isRequestTimeoutError(error) && AppState.currentState !== 'active') {
      return 'backgrounded-timeout';
    }
  } catch {
    // Predicate unavailable — report it.
  }

  return null;
}

function recordAuthFailureSafely(): void {
  try {
    const { recordAuthFailure } =
      require('./auth-failure-breaker') as typeof import('./auth-failure-breaker');
    recordAuthFailure();
  } catch {
    // best-effort — the breaker may not be available (e.g. in unit tests)
  }
}

/** One line per suppressed class, so a breadcrumb says WHY it was suppressed
 *  rather than only that it was. `cancelled` is absent on purpose: it is
 *  dropped outright, with no breadcrumb. */
const SUPPRESSION_BREADCRUMB: Record<SuppressionClass, string> = {
  auth: 'Suppressed 401 — auth breaker owns this signal',
  cancelled: 'Suppressed cancellation',
  offline: 'Suppressed network error — device is offline',
  'backgrounded-timeout': 'Suppressed request timeout — app was not in foreground',
  'no-credential': 'Suppressed missing-credential error — device has no keypair yet',
};

const logger = {
  /**
   * Capture an exception and send it to Sentry
   */
  captureException(
    error: unknown,
    options: CaptureExceptionOptions = {}
  ): string {
    const { level = 'error', tags, extra, fingerprint } = options;

    // Ensure we have an Error object
    const errorObject =
      error instanceof Error ? error : new Error(String(error));

    // See the block comment above classifySuppression. Runs BEFORE the __DEV__
    // console log so a suppressed event is quiet in development too — otherwise
    // a red console line would keep suggesting these are still being reported.
    const suppression = classifySuppression(errorObject, options);
    if (suppression === 'cancelled') return '';
    if (suppression !== null) {
      logger.addBreadcrumb(
        `${SUPPRESSION_BREADCRUMB[suppression]}: ${errorObject.message}`,
        tags?.service ?? 'logger',
        { ...tags, ...extra, suppressed: suppression },
        suppression === 'auth' ? 'warning' : 'info',
      );
      // ONLY the 401 class feeds the breaker. A no-credential error means the
      // device has no local keypair, which says nothing about the session —
      // feeding it here would trip the breaker and pause feed-sync over a
      // missing local key. Offline and backgrounded-timeout are not auth
      // failures at all.
      if (suppression === 'auth') recordAuthFailureSafely();
      return '';
    }

    // Log to console in development
    if (__DEV__) {
      console.error(
        '[Logger]',
        errorObject.message,
        JSON.stringify({ tags, extra }, null, 2),
      );
    }

    return Sentry.captureException(errorObject, {
      level: level as Sentry.SeverityLevel,
      tags,
      extra,
      fingerprint,
    });
  },

  /**
   * Capture a message and send it to Sentry
   */
  captureMessage(
    message: string,
    options: CaptureExceptionOptions = {}
  ): string {
    const { level = 'info', tags, extra, fingerprint, _groupByStack } = options;

    if (__DEV__) {
      console.info('[Logger]', message, JSON.stringify({ level, tags, extra }, null, 2));
    }

    // `fingerprint` was accepted by the options type and then silently dropped
    // here, so every captureMessage grouped on its STACK. A message emitted
    // from an async callback has whatever frames happen to be live, which split
    // one recurring event across four Sentry issues (MERA-APP-6J/5P/65/6R are
    // all the single string 'Auth circuit breaker tripped'). Passing it fixed
    // that for callers who remembered to; defaulting it below fixes it for the
    // ones who don't.
    return Sentry.captureMessage(message, {
      level: level as Sentry.SeverityLevel,
      tags,
      extra,
      // Default to the message itself. Every one of the 11 direct callers emits
      // a STATIC string (the one template literal interpolates a module
      // constant), so the text IS the identity and grouping on it is correct.
      // auth-failure-breaker passes its own and keeps it.
      fingerprint: fingerprint ?? (_groupByStack ? undefined : [message]),
    });
  },

  /**
   * Add breadcrumb for context
   */
  addBreadcrumb(
    message: string,
    category: string,
    data?: LogContext,
    level: LogLevel = 'info'
  ): void {
    Sentry.addBreadcrumb({
      message,
      category,
      data,
      level: level as Sentry.SeverityLevel,
    });
  },

  /**
   * Set user context for error tracking
   */
  setUser(user: { id: string; email?: string; username?: string } | null): void {
    Sentry.setUser(user);
  },

  /**
   * Set a tag that will be attached to all future events
   */
  setTag(key: string, value: string): void {
    Sentry.setTag(key, value);
  },

  /**
   * Set extra context that will be attached to all future events
   */
  setExtra(key: string, value: unknown): void {
    Sentry.setExtra(key, value);
  },

  /**
   * Start a performance transaction
   */
  startTransaction(name: string, op: string): Sentry.Span | undefined {
    return Sentry.startInactiveSpan({ name, op });
  },

  /**
   * Wrap a function to capture any errors it throws
   */
  withErrorCapture<T extends (...args: unknown[]) => unknown>(
    fn: T,
    context?: CaptureExceptionOptions
  ): T {
    return ((...args: Parameters<T>) => {
      try {
        const result = fn(...args);
        // Handle async functions
        if (result instanceof Promise) {
          return result.catch((error) => {
            logger.captureException(error, context);
            throw error;
          });
        }
        return result;
      } catch (error) {
        logger.captureException(error, context);
        throw error;
      }
    }) as T;
  },

  /**
   * Log methods for different severity levels
   */
  debug(message: string, context?: LogContext): void {
    // Only print to console when explicitly opted in — debug is chatty and
    // otherwise floods the dev console on every tick/batch.
    if (__DEV__ && process.env.EXPO_PUBLIC_VERBOSE_LOGS === 'true') {
      if (context !== undefined) {
        console.debug('[Debug]', message, context);
      } else {
        console.debug('[Debug]', message);
      }
    }
    // Breadcrumbs only in dev — chatty debug calls would otherwise evict
    // useful context from the 100-breadcrumb ring ahead of prod crash reports.
    if (__DEV__) {
      this.addBreadcrumb(message, 'debug', context, 'debug');
    }
  },

  info(message: string, context?: LogContext): void {
    if (__DEV__) {
      if (context !== undefined) {
        console.info('[Info]', message, context);
      } else {
        console.info('[Info]', message);
      }
    }
    this.addBreadcrumb(message, 'info', context, 'info');
  },

  warn(message: string, context?: LogContext): void {
    if (__DEV__) {
      if (context !== undefined) {
        console.warn('[Warn]', message, context);
      } else {
        console.warn('[Warn]', message);
      }
    }
    this.addBreadcrumb(message, 'warning', context, 'warning');
  },

  error(message: string, error?: unknown, context?: LogContext): void {
    if (__DEV__) {
      const args: unknown[] = ['[Error]', message];
      if (error !== undefined) args.push(error);
      if (context !== undefined) args.push(context);
      console.error(...args);
    }

    if (error) {
      this.captureException(error, { extra: { message, ...context } });
    } else {
      // `_groupByStack`: logger.error messages are commonly interpolated, so
      // they keep the stack-based grouping they have always had.
      this.captureMessage(message, { level: 'error', extra: context, _groupByStack: true });
    }
  },
};

export default logger;
