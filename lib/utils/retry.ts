import { CombinedGraphQLErrors } from '@apollo/client/errors';
import logger from '@/lib/logger';

// GraphQL error codes that are permanent client-side failures — retrying them
// just multiplies the request storm while the server keeps rejecting. e.g. a
// 247-topic request that trips the server's BAD_USER_INPUT "too many topics"
// guard will never succeed by retrying.
const NON_RETRYABLE_GRAPHQL_CODES = new Set([
  'BAD_USER_INPUT',
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'GRAPHQL_VALIDATION_FAILED',
]);

/**
 * Marks an error as permanently non-retryable so the scheduler skips its
 * maxAttempts reschedule (and `withRetry` skips its backoff loop). Carries the
 * originating error as `cause` for reporting.
 */
export class NonRetryableError extends Error {
  readonly cause: unknown;
  constructor(message: string, cause: unknown) {
    super(message);
    this.name = 'NonRetryableError';
    this.cause = cause;
  }
}

interface GraphQLErrorLike {
  extensions?: { code?: string };
}

interface NetworkLikeError {
  statusCode?: number;
  response?: { status?: number };
}

/**
 * True when `error` is a permanent client-side failure that must never be
 * retried: a GraphQL/Apollo error carrying a non-retryable extensions.code
 * (directly or in a nested `errors[]`), or a network/ServerError with a 4xx
 * HTTP status.
 */
export function isNonRetryableError(error: unknown): boolean {
  if (error instanceof NonRetryableError) return true;
  if (!error || typeof error !== 'object') return false;

  // Apollo v4 wraps GraphQL errors in CombinedGraphQLErrors.
  if (CombinedGraphQLErrors.is(error)) {
    return error.errors.some((e) =>
      NON_RETRYABLE_GRAPHQL_CODES.has(
        (e as GraphQLErrorLike).extensions?.code ?? '',
      ),
    );
  }

  // A bare GraphQL error, or a wrapper carrying a nested `errors[]` array.
  const direct = (error as GraphQLErrorLike).extensions?.code;
  if (direct && NON_RETRYABLE_GRAPHQL_CODES.has(direct)) return true;

  const nested = (error as { errors?: GraphQLErrorLike[] }).errors;
  if (
    Array.isArray(nested) &&
    nested.some((e) => NON_RETRYABLE_GRAPHQL_CODES.has(e?.extensions?.code ?? ''))
  ) {
    return true;
  }

  // Network / ServerError with a 4xx status code — deterministic client error.
  const ne = error as NetworkLikeError;
  const status = ne.statusCode ?? ne.response?.status;
  return typeof status === 'number' && status >= 400 && status < 500;
}

/**
 * True when `error` is a 401 / UNAUTHENTICATED, in any of the shapes Apollo
 * Client v4 surfaces it in (GraphQL extensions, network error, wrapped network
 * error).
 *
 * ONE DEFINITION, DELIBERATELY. The 401 reporting rule has to be identical at
 * every catch site — the Apollo error link, `ArticleService.reportQueryError`
 * and the scheduler runner all suppress on it — and a second copy that drifts
 * is enough to re-open the duplicate-event storm this predicate exists to stop.
 * It lives beside `isNonRetryableError` because the two answer the same kind of
 * question about the same error shapes, and because `lib/utils/retry` is
 * dependency-light: importing it must never drag Apollo's client instance into
 * a module (the scheduler runner) that has no business constructing one.
 */
export function isUnauthenticatedError(error: unknown): boolean {
  if (CombinedGraphQLErrors.is(error)) {
    return error.errors.some((e) => {
      const ext = (e as GraphQLErrorLike & { extensions?: { statusCode?: number } })
        .extensions;
      return ext?.code === 'UNAUTHENTICATED' || ext?.statusCode === 401;
    });
  }

  const ne = error as
    | (NetworkLikeError & { networkError?: { statusCode?: number } })
    | undefined;
  const status =
    ne?.statusCode ?? ne?.response?.status ?? ne?.networkError?.statusCode;
  return status === 401;
}

export async function withRetry<T>(
  op: () => Promise<T>,
  signal?: AbortSignal,
  maxRetries = 3,
  tag = '[retry]',
): Promise<T> {
  let delay = 100;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (signal?.aborted) throw createCancellationError();
    try {
      return await op();
    } catch (err) {
      if (signal?.aborted) throw createCancellationError();
      // Never retry a permanent client-side failure — rethrow immediately so
      // the caller (and scheduler) can treat it as terminal.
      if (isNonRetryableError(err)) throw err;
      if (attempt === maxRetries) throw err;
      logger.warn(`${tag} retry ${attempt + 1}/${maxRetries}`);
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay *= 2;
    }
  }
  throw new Error(`${tag} withRetry: unexpected exit`);
}

/**
 * The one way to signal "this operation was CANCELLED", as opposed to "this
 * operation failed".
 *
 * `name` is 'AbortError' so it matches the same predicate the Apollo error link
 * already uses to keep a screen unmount from faking a server outage
 * (`isCancellation` in lib/apollo-client.ts); `message` stays the literal
 * 'aborted' that `lib/utils/transient-error.ts` substring-matches on, so both
 * existing readers keep working unchanged.
 *
 * A cancellation is not a defect: nobody can act on "the user navigated away
 * mid-request", and reporting it spends an issue on a non-event (Sentry
 * MERA-APP-6W). `logger.captureException` drops these, which is why every abort
 * throw in the app should come from here rather than `new Error('aborted')`.
 */
export function createCancellationError(): Error {
  const err = new Error('aborted');
  err.name = 'AbortError';
  return err;
}

/** True when `error` represents a cancellation rather than a failure. */
export function isCancellationError(error: unknown): boolean {
  return (error as { name?: string } | undefined)?.name === 'AbortError';
}
