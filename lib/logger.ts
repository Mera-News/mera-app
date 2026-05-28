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
    const { level = 'info', tags, extra } = options;

    return Sentry.captureMessage(message, {
      level: level as Sentry.SeverityLevel,
      tags,
      extra,
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
    if (__DEV__) {
      console.debug('[Debug]', message, context);
    }
    this.addBreadcrumb(message, 'debug', context, 'debug');
  },

  info(message: string, context?: LogContext): void {
    if (__DEV__) {
      console.info('[Info]', message, context);
    }
    this.addBreadcrumb(message, 'info', context, 'info');
  },

  warn(message: string, context?: LogContext): void {
    if (__DEV__) {
      console.warn('[Warn]', message, context);
    }
    this.addBreadcrumb(message, 'warning', context, 'warning');
  },

  error(message: string, error?: unknown, context?: LogContext): void {
    if (__DEV__) {
      console.error('[Error]', message, error, context);
    }

    if (error) {
      this.captureException(error, { extra: { message, ...context } });
    } else {
      this.captureMessage(message, { level: 'error', extra: context });
    }
  },
};

export default logger;
