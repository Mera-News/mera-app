import { ApolloClient, ApolloLink, InMemoryCache } from '@apollo/client';
import { CombinedGraphQLErrors } from '@apollo/client/errors';

interface GraphQLErrorExtensions {
    exception?: { name?: string };
    code?: string;
}
import { SetContextLink } from '@apollo/client/link/context';
import { ErrorLink } from '@apollo/client/link/error';
import { HttpLink } from '@apollo/client/link/http';
import { RetryLink } from '@apollo/client/link/retry';
import { router } from 'expo-router';
import {
    StatusCodes,
} from 'http-status-codes';
import { authClient } from './auth-client';
import logger from './logger';
import { useForYouStore } from './stores/for-you-store';
import { toastManager } from './toast-manager';
import { GRAPHQL_SERVER_ENDPOINT } from './config/endpoints';

// Cache TTL in milliseconds (10 minutes)
const CACHE_TTL_MS = 10 * 60 * 1000;
// Create HTTP link with credentials set to 'omit' to avoid interfering with manual cookie headers
const httpLink = new HttpLink({
    uri: `${GRAPHQL_SERVER_ENDPOINT}/graphql`,
    credentials: 'omit', // Important: prevents interference with manually set cookies
});

// Create error link to handle GraphQL errors (Apollo Client v4 syntax)
const errorLink = new ErrorLink(({ error, operation }) => {
    if (CombinedGraphQLErrors.is(error)) {
        // Handle GraphQL errors
        for (const graphQLError of error.errors) {
            const { message, extensions } = graphQLError;

            // Check if the error is NotSubscribedException
            const ext = extensions as GraphQLErrorExtensions | undefined;
            const exceptionName = ext?.exception?.name;
            const errorCode = ext?.code;

            if (
                message?.includes('NotSubscribedException') ||
                errorCode === 'NOT_SUBSCRIBED' ||
                exceptionName === 'NotSubscribedException'
            ) {
                // Redirect to not-subscribed page
                router.replace('/logged-in/not-subscribed' as any);
                return;
            }

            // UNAUTHENTICATED is logged but does NOT auto-logout. A single
            // failed request — e.g. a transient keychain-locked window during
            // a background-push wake — must not nuke the user's session. The
            // auth gate in app/index.tsx routes to /login when useSession()
            // actually reports no session; let server truth drive that, not
            // a single error response.
            if (errorCode === 'UNAUTHENTICATED') {
                logger.captureMessage('GraphQL UNAUTHENTICATED', {
                    level: 'warning',
                    tags: { source: 'apollo-error-link', type: 'auth' },
                    extra: { operationName: operation.operationName },
                });
                return;
            }

            // Log other GraphQL errors to Sentry
            logger.captureException(new Error(`GraphQL Error: ${JSON.stringify(graphQLError)}`), {
                tags: { source: 'apollo-error-link', type: 'graphql' },
                extra: {
                    operationName: operation.operationName,
                    errorCode,
                    graphQLError: JSON.stringify(graphQLError, null, 2),
                },
            });

            useForYouStore.getState().setSyncStatusMessage({
                    state: 'failed',
                    headlineKey: 'sync.syncFailed',
                    errorCode: 'unknown',
                    isRecoverable: false,
                });
        }
    } else {
        // Handle network errors
        // Check if the error has a status code of 402 (Payment Required - used for subscription errors)
        const networkError = error as
            | { statusCode?: number; response?: { status?: number } }
            | undefined;
        const statusCode = networkError?.statusCode || networkError?.response?.status;

        if (statusCode === StatusCodes.PAYMENT_REQUIRED) {
            router.replace('/logged-in/not-subscribed' as any);
            return;
        }

        // 401 is logged but does NOT auto-logout (see GraphQL UNAUTHENTICATED
        // branch above for rationale).
        if (statusCode === StatusCodes.UNAUTHORIZED) {
            logger.captureMessage('Network 401', {
                level: 'warning',
                tags: { source: 'apollo-error-link', type: 'auth' },
                extra: { operationName: operation.operationName },
            });
            return;
        }

        // Log network errors to Sentry
        logger.captureException(error, {
            tags: { source: 'apollo-error-link', type: 'network' },
            extra: {
                operationName: operation.operationName,
                statusCode,
            },
        });

        // Show user-friendly toast notification for network errors
        toastManager.showNetworkError();
    }
});

// Create retry link with exponential backoff for network errors
// This prevents infinite error loops when network is unavailable
const retryLink = new RetryLink({
    attempts: {
        max: 3, // Maximum 3 retry attempts
        retryIf: (error) => {
            // Only retry on network errors, not GraphQL errors or auth failures.
            if (!error || (error as { result?: unknown }).result) return false;
            return true;
        },
    },
    delay: {
        initial: 300,    // Start with 300ms delay
        max: 3000,       // Cap at 3 seconds
        jitter: true,    // Add randomness to prevent thundering herd
    },
});

// Attach the better-auth session cookie to every GraphQL request. If the
// keychain is briefly inaccessible (pre-first-unlock on a background-push
// wake), we proceed without a cookie — the request will either succeed (no
// auth required) or come back 401, which the error link now treats as a
// soft failure rather than a forced logout.
const authLink = new SetContextLink(async (prevContext, _operation) => {
    let cookies: string | undefined;
    try {
        cookies = authClient.getCookie();
    } catch {
        cookies = undefined;
    }

    return {
        headers: {
            ...prevContext.headers,
            ...(cookies ? { Cookie: cookies } : {}),
        },
    };
});

// Create InMemoryCache with type policies for normalized caching
const cache = new InMemoryCache({
    typePolicies: {
        Query: {
            fields: {
                // Add type policies here if needed for specific query field caching
            },
        },
        UserPersona: {
            fields: {
                userTopics: {
                    merge(_existing, incoming) {
                        return incoming;
                    },
                },
            },
        },
    },
});

// Track when cache was last cleared
let lastCacheClear = Date.now();

// Track per-query cache timestamps for custom TTL support
const queryTimestamps = new Map<string, number>();

// Create a custom link to track cache age and evict stale data
const cacheEvictionLink = new ApolloLink((operation, forward) => {
    const now = Date.now();

    // Check for per-query TTL in operation context
    const customTTL = operation.getContext().cacheTTL as number | undefined;

    if (customTTL) {
        // Generate a cache key based on operation name and variables
        const cacheKey = `${operation.operationName}:${JSON.stringify(operation.variables)}`;
        const lastFetch = queryTimestamps.get(cacheKey);

        // If cache is stale for this specific query, evict it
        if (lastFetch && now - lastFetch > customTTL) {
            // Evict specific query from cache
            cache.evict({
                fieldName: operation.operationName || undefined,
            });
            cache.gc(); // Run garbage collection to remove orphaned data
            queryTimestamps.delete(cacheKey);
        }

        // Update timestamp when operation starts (optimistic)
        // This prevents multiple simultaneous requests for the same data
        queryTimestamps.set(cacheKey, now);
    }

    // Check if global cache is older than TTL
    if (now - lastCacheClear > CACHE_TTL_MS) {
        // Cache is stale, clear it
        cache.reset().catch((error) => {
            logger.captureException(error, {
                tags: { source: 'apollo-cache-eviction', type: 'cache-reset' },
            });
        });
        lastCacheClear = now;
        // Clear query timestamps when resetting entire cache
        queryTimestamps.clear();
    }

    return forward(operation);
});

// Initialize Apollo Client with error, retry, auth, and http links
// NOTE: Caching is ENABLED with 10-minute TTL
// Link chain: errorLink → retryLink → cacheEvictionLink → authLink → httpLink
const client = new ApolloClient({
    link: errorLink.concat(retryLink.concat(cacheEvictionLink.concat(authLink.concat(httpLink)))),
    cache,
    defaultOptions: {
        watchQuery: {
            fetchPolicy: 'cache-first',
            errorPolicy: 'none',
        },
        query: {
            fetchPolicy: 'cache-first',
            errorPolicy: 'none',
        },
        mutate: {
            errorPolicy: 'none',
        },
    },
});

/**
 * Evicts the Apollo InMemoryCache if it has exceeded the TTL.
 * Called by apollo-cache-evict-task on foreground and on a 10-minute schedule.
 */
export function evictExpiredApolloCache(): void {
    const now = Date.now();
    if (now - lastCacheClear > CACHE_TTL_MS) {
        cache.reset().catch((error) => {
            logger.captureException(error, {
                tags: { source: 'apollo-cache-evict-task', type: 'cache-reset' },
            });
        });
        lastCacheClear = now;
    }
}

export default client;
