import * as Sentry from '@sentry/react-native';

type LogLevel = 'debug' | 'info' | 'warning' | 'error' | 'fatal';

interface LogContext {
  [key: string]: unknown;
}

interface CaptureExceptionOptions {
  level?: LogLevel;
  tags?: Record<string, string>;
  extra?: Record<string, unknown>;
  fingerprint?: string[];
}

// THE 401 RULE AND THE CANCELLATION RULE, APPLIED ONCE.
//
// Both used to be per-call-site opt-ins. `isUnauthenticatedError` was defined
// once in lib/utils/retry.ts and then applied by hand at three sites (the
// Apollo error link, ArticleService.reportQueryError, the scheduler runner),
// which left every OTHER service catch reporting the same dead session. One
// cold start with an expired session emitted five separate Sentry issues:
// account-service's 401 (MERA-APP-3P), e2ee-service's NEAR attestation 401
// (MERA-APP-18/23), submitInferenceJob's 401 (MERA-APP-6Q), the breaker's own
// trip event, and the model-fallback message that followed from it. The rule
// was correct and its coverage was the bug, so it moves to the one chokepoint
// every reporting path already goes through.
//
// A 401 becomes a breadcrumb and feeds recordAuthFailure(). The auth circuit
// breaker's single trip event stays the ONLY Sentry signal for a dead session —
// that is the whole design in lib/auth-failure-breaker.ts, and it only works if
// nothing else reports the same fact.
//
// A cancellation (AbortError — a screen unmount, a superseded refresh, a
// scheduler task torn down mid-flight) is dropped outright. Nobody can act on
// it and it is not evidence of anything (MERA-APP-6W).
//
// Both predicates are lazy-required for the reason auth-failure-breaker.ts
// documents: logger is imported by nearly every module, so a static import of
// utils/retry or auth-failure-breaker here would form a cycle at module-eval
// time. Failing open (reporting the event) is the safe direction on any throw.
function classifySuppression(
  error: Error,
): 'auth' | 'cancelled' | null {
  try {
    const { isUnauthenticatedError, isCancellationError } =
      require('./utils/retry') as typeof import('./utils/retry');
    if (isCancellationError(error)) return 'cancelled';
    if (isUnauthenticatedError(error)) return 'auth';
  } catch {
    // Predicate unavailable (test harness, partial module graph) — report it.
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
    const suppression = classifySuppression(errorObject);
    if (suppression === 'cancelled') return '';
    if (suppression === 'auth') {
      logger.addBreadcrumb(
        'Suppressed 401 — auth breaker owns this signal',
        tags?.service ?? 'logger',
        { ...tags, ...extra },
        'warning',
      );
      recordAuthFailureSafely();
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
    const { level = 'info', tags, extra, fingerprint } = options;

    if (__DEV__) {
      console.info('[Logger]', message, JSON.stringify({ level, tags, extra }, null, 2));
    }

    // `fingerprint` was accepted by the options type and then silently dropped
    // here, so every captureMessage grouped on its STACK. A message emitted
    // from an async callback has an unstable stack, which split one recurring
    // event across four Sentry issues (MERA-APP-6J/5P/65/6R are all the single
    // string 'Auth circuit breaker tripped'). Callers that own a stable
    // identity for their message pass it explicitly.
    return Sentry.captureMessage(message, {
      level: level as Sentry.SeverityLevel,
      tags,
      extra,
      fingerprint,
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
      this.captureMessage(message, { level: 'error', extra: context });
    }
  },
};

export default logger;
