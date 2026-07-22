import { ApolloClient, ApolloLink, InMemoryCache, Observable } from '@apollo/client';
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
import { recordAuthFailure, recordAuthSuccess } from './auth-failure-breaker';
import logger from './logger';
import { useForYouStore } from './stores/for-you-store';
import { useNetworkStore } from './stores/network-store';
import { toastManager } from './toast-manager';
import { GRAPHQL_SERVER_ENDPOINT } from './config/endpoints';

// Cache TTL in milliseconds (10 minutes)
const CACHE_TTL_MS = 10 * 60 * 1000;
// Create HTTP link with credentials set to 'omit' to avoid interfering with manual cookie headers
const httpLink = new HttpLink({
    uri: `${GRAPHQL_SERVER_ENDPOINT}/graphql`,
    credentials: 'omit', // Important: prevents interference with manually set cookies
});

const MAX_THROTTLE_RETRIES = 3;

// Create error link to handle GraphQL errors (Apollo Client v4 syntax)
const errorLink = new ErrorLink(({ error, operation, forward }) => {
    // Note: the "active subscription required" 402 (PAYMENT_REQUIRED) is NOT
    // handled globally any more. The server only emits it on the For You feed
    // queries, and the paywall is triggered explicitly there (article-service),
    // so it stays scoped to the For You screen instead of firing from arbitrary
    // background queries.

    if (CombinedGraphQLErrors.is(error)) {
        // Handle GraphQL errors
        for (const graphQLError of error.errors) {
            const { extensions } = graphQLError;
            const ext = extensions as GraphQLErrorExtensions | undefined;
            const errorCode = ext?.code;

            // UNAUTHENTICATED is logged but does NOT auto-logout. A single
            // failed request — e.g. a transient keychain-locked window during
            // a background-push wake — must not nuke the user's session. The
            // auth gate in app/index.tsx routes to /login when useSession()
            // actually reports no session; let server truth drive that, not
            // a single error response.
            if (errorCode === 'UNAUTHENTICATED') {
                // Downgraded from a per-request Sentry capture to a breadcrumb:
                // the auth-failure breaker's single trip event replaces the
                // per-request storm (this used to emit ~700 events over two
                // weeks). recordAuthFailure() drives the breaker.
                logger.addBreadcrumb(
                    'GraphQL UNAUTHENTICATED',
                    'apollo-error-link',
                    { operationName: operation.operationName },
                    'warning',
                );
                recordAuthFailure();
                return;
            }

            // Retry on rate-limit with exponential backoff before logging
            if (errorCode === 'TOO_MANY_REQUESTS') {
                const attempt = (operation.getContext().throttleRetryCount as number | undefined) ?? 0;
                if (attempt < MAX_THROTTLE_RETRIES) {
                    const delay = Math.min(500 * 2 ** attempt, 16000);
                    return new Observable((observer) => {
                        const timer = setTimeout(() => {
                            operation.setContext({ throttleRetryCount: attempt + 1 });
                            forward(operation).subscribe({
                                next: (value) => observer.next(value),
                                error: (err) => observer.error(err),
                                complete: () => observer.complete(),
                            });
                        }, delay);
                        return () => clearTimeout(timer);
                    });
                }
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
        // Handle network errors. (The 402 "not subscribed" case is handled at
        // the For You feed layer, not here — see article-service.)
        const networkError = error as
            | { statusCode?: number; response?: { status?: number } }
            | undefined;
        const statusCode = networkError?.statusCode || networkError?.response?.status;

        // 401 is logged but does NOT auto-logout (see GraphQL UNAUTHENTICATED
        // branch above for rationale).
        if (statusCode === StatusCodes.UNAUTHORIZED) {
            // Downgraded to a breadcrumb — see the GraphQL UNAUTHENTICATED
            // branch above. The breaker's single trip event is the signal.
            logger.addBreadcrumb(
                'Network 401',
                'apollo-error-link',
                { operationName: operation.operationName },
                'warning',
            );
            recordAuthFailure();
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

        // Show a user-friendly toast — but only when we're actually online.
        // Every no-cache query fails the same way while offline (there's no
        // cache to fall back to), so without this gate a screen with a few
        // background queries spams several toasts per second in airplane
        // mode. The offline banners (Feed/Dashboard headers) already cover
        // that state; a breadcrumb is enough here for diagnostics.
        if (useNetworkStore.getState().isConnected) {
            toastManager.showNetworkError();
        } else {
            logger.addBreadcrumb(
                'Network error while offline — toast suppressed',
                'apollo-error-link',
                { operationName: operation.operationName },
                'info',
            );
        }
    }
});

// Observe successful operations to reset the auth-failure breaker. Any response
// that comes back without errors proves auth is working, so it closes the
// breaker (and resumes feed-sync) if a transient failure had tripped it.
const authSuccessLink = new ApolloLink((operation, forward) =>
    new Observable((observer) => {
        const subscription = forward(operation).subscribe({
            next: (result) => {
                if (!result.errors || result.errors.length === 0) {
                    recordAuthSuccess();
                }
                observer.next(result);
            },
            error: (err) => observer.error(err),
            complete: () => observer.complete(),
        });
        return () => subscription.unsubscribe();
    }),
);

// Whether a failed operation should be retried. Exported for testing.
// Two gates:
//  1. Connectivity — never retry with no network. There's nothing to retry
//     against, and reconnect already triggers refetches elsewhere (feed-sync,
//     FeedSyncMachine); retrying anyway just burns 3 backoff cycles per
//     operation for a guaranteed failure.
//  2. Error shape — only retry transient/transport failures. Never retry
//     client (4xx) errors — e.g. a 402 "not subscribed" is deterministic, so
//     retrying just multiplies the request storm while the gate is active.
export function shouldRetryOperation(error: unknown): boolean {
    if (!useNetworkStore.getState().isConnected) return false;
    if (!error || (error as { result?: unknown }).result) return false;
    const status =
        (error as { statusCode?: number }).statusCode ??
        (error as { response?: { status?: number } }).response?.status;
    if (typeof status === 'number' && status >= 400 && status < 500) {
        return false;
    }
    return true;
}

// Create retry link with exponential backoff for network errors
// This prevents infinite error loops when network is unavailable
const retryLink = new RetryLink({
    attempts: {
        max: 3, // Maximum 3 retry attempts
        retryIf: (error) => shouldRetryOperation(error),
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
// Link chain: errorLink → authSuccessLink → retryLink → cacheEvictionLink → authLink → httpLink
const client = new ApolloClient({
    link: errorLink.concat(authSuccessLink.concat(retryLink.concat(cacheEvictionLink.concat(authLink.concat(httpLink))))),
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
