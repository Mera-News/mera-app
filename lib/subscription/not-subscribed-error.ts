// Recognises the server's "active subscription required" (HTTP 402) response
// across the shapes Apollo Client v4 surfaces it in. The GraphQL service maps a
// NotSubscribedException to a GraphQL error with extensions
// `{ code: 'PAYMENT_REQUIRED', statusCode: 402 }` (graphql-exception.filter.ts).
// Older/network paths may instead carry a top-level/network 402. We accept all
// of them in one place so the error-link and the route gate can't drift.

import { CombinedGraphQLErrors } from '@apollo/client/errors';
import { StatusCodes } from 'http-status-codes';

interface NotSubscribedExtensions {
  code?: string;
  statusCode?: number;
  exception?: { name?: string };
}

interface NetworkLikeError {
  statusCode?: number;
  response?: { status?: number };
  networkError?: { statusCode?: number };
}

/** True when `error` is the server's 402 "not subscribed" signal, in any shape. */
export function isNotSubscribedError(error: unknown): boolean {
  if (CombinedGraphQLErrors.is(error)) {
    return error.errors.some((e) => {
      const ext = e.extensions as NotSubscribedExtensions | undefined;
      return (
        ext?.code === 'PAYMENT_REQUIRED' ||
        ext?.code === 'NOT_SUBSCRIBED' ||
        ext?.statusCode === StatusCodes.PAYMENT_REQUIRED ||
        ext?.exception?.name === 'NotSubscribedException' ||
        (typeof e.message === 'string' &&
          e.message.includes('NotSubscribedException'))
      );
    });
  }

  const ne = error as NetworkLikeError | undefined;
  const status =
    ne?.statusCode ?? ne?.response?.status ?? ne?.networkError?.statusCode;
  return status === StatusCodes.PAYMENT_REQUIRED;
}
