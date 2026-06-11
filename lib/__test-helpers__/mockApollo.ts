/**
 * Shared test helper for unit-testing the Apollo service layer WITHOUT loading
 * the real client (plan Cookbook §2).
 *
 * Services do `import client from './apollo-client'` (default singleton) and call
 * `client.query(...)`, `client.mutate(...)`, `client.cache.reset()`. The
 * `apollo-client.ts` module itself is side-effectful (builds links, imports
 * expo-router / stores / auth at load) so it must never load in a unit test.
 *
 * Recommended inline pattern (mirrors the repo's `mock`-prefixed convention):
 *
 *   const mockQuery = jest.fn();
 *   const mockMutate = jest.fn();
 *   const mockCacheReset = jest.fn(async () => {});
 *   jest.mock('@/lib/apollo-client', () => ({
 *     __esModule: true,
 *     default: {
 *       query: (...a: any[]) => mockQuery(...a),
 *       mutate: (...a: any[]) => mockMutate(...a),
 *       cache: { reset: (...a: any[]) => mockCacheReset(...a) },
 *     },
 *   }));
 *
 *   beforeEach(() => jest.clearAllMocks());
 *   mockQuery.mockResolvedValueOnce({ data: { recentArticleCount: 5 } });
 *
 * `gql` from `@apollo/client` is pure (a template tag whitelisted in
 * transformIgnorePatterns) — import it normally; the service only passes the
 * resulting document to the mocked `client.query`, so no GraphQL document needs
 * mocking. Always also mock `@/lib/logger`.
 *
 * Or use the factory below from inside the jest.mock callback:
 *
 *   jest.mock('@/lib/apollo-client', () => {
 *     const { makeApolloMock } = require('@/lib/__test-helpers__/mockApollo');
 *     return makeApolloMock().module;
 *   });
 *   import client from '@/lib/apollo-client';
 *   const apollo = client as unknown as MockApolloClient;
 *   apollo.query.mockResolvedValueOnce({ data: {} });
 */

export interface MockApolloClient {
  query: jest.Mock;
  mutate: jest.Mock;
  cache: { reset: jest.Mock; evict: jest.Mock; gc: jest.Mock };
}

export function makeApolloMock(): {
  query: jest.Mock;
  mutate: jest.Mock;
  reset: jest.Mock;
  module: { __esModule: true; default: MockApolloClient };
} {
  const query = jest.fn();
  const mutate = jest.fn();
  const reset = jest.fn(async () => {});
  const evict = jest.fn();
  const gc = jest.fn();
  const client: MockApolloClient = { query, mutate, cache: { reset, evict, gc } };
  return { query, mutate, reset, module: { __esModule: true, default: client } };
}

/** Standard logger mock — every Apollo-service test should mock '@/lib/logger'. */
export function makeLoggerMock() {
  return {
    __esModule: true,
    default: {
      captureException: jest.fn(),
      captureMessage: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      info: jest.fn(),
      debug: jest.fn(),
    },
  };
}
