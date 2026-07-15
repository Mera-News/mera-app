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

export async function withRetry<T>(
  op: () => Promise<T>,
  signal?: AbortSignal,
  maxRetries = 3,
  tag = '[retry]',
): Promise<T> {
  let delay = 100;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (signal?.aborted) throw new Error('aborted');
    try {
      return await op();
    } catch (err) {
      if (signal?.aborted) throw new Error('aborted');
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
