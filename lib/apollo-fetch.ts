// Instrumented `fetch` for Apollo's HttpLink.
//
// Why this file exists (the specific friction, per the repo's pattern rule):
// React Native's `fetch` has NO default timeout, and Apollo's error link only
// increments our failure counter when an operation actually REJECTS. So against
// a server that accepts the socket and never answers, nothing ever rejects:
// `serverReachable` stays true, `isConnected` stays true, and the user sits on a
// blank feed with no explanation and no signal anywhere in the app.
//
// Two thresholds, deliberately NOT one:
//
//   slow (8s)   — arms the offline band. Does NOT touch the request; it keeps
//                 running and will still succeed if the network is merely
//                 terrible. This is a UX signal, nothing more.
//   abort (30s) — a safety net against a genuinely hung socket. Rejects with a
//                 MARKED error so the error link can count it as evidence the
//                 server is down.
//
// Collapsing these into a single abort was considered and rejected: killing a
// request at 15s that would have completed at 20s makes the bad-network case
// worse, and "keep trying" is the explicit requirement.

import {
    reportRequestSlow,
    reportSlowRequestEnded,
} from './stores/network-store';

/** A request in flight longer than this arms the band. The request continues. */
export const SLOW_REQUEST_MS = 8_000;

/** Hard ceiling. Only a hung socket should ever reach this. */
export const REQUEST_ABORT_MS = 30_000;

/**
 * Marker on the error thrown when WE abort a request for exceeding
 * REQUEST_ABORT_MS.
 *
 * Load-bearing: Apollo also aborts in-flight requests when an observable is
 * unsubscribed (screen unmount, tab switch, pull-to-refresh superseding a
 * load), and those produce an `AbortError` with exactly the same "no
 * statusCode" shape as a timeout. Counting a cancellation as a server failure
 * would let ordinary navigation fake an outage, so the error link tells the two
 * apart by this flag alone.
 */
export interface TimeoutError extends Error {
    isRequestTimeout: true;
}

export function isRequestTimeoutError(error: unknown): boolean {
    return (error as TimeoutError | null)?.isRequestTimeout === true;
}

/**
 * Wraps `fetch` with the slow/abort thresholds above. Passed to HttpLink so
 * every GraphQL operation is instrumented; nothing else changes about the call.
 *
 * NOTE: this covers GraphQL only. `authClient` (better-auth) uses its own
 * transport and never passes through here — auth calls must bound themselves.
 */
export const instrumentedFetch: typeof fetch = async (input, init) => {
    const controller = new AbortController();

    // Respect a caller-supplied signal (Apollo passes one for cancellation) by
    // chaining it into ours, so an unsubscribe still aborts the underlying
    // request — it just won't carry our timeout marker.
    const callerSignal = init?.signal;
    const onCallerAbort = () => controller.abort();
    if (callerSignal) {
        if (callerSignal.aborted) controller.abort();
        else callerSignal.addEventListener('abort', onCallerAbort);
    }

    let timedOut = false;
    let markedSlow = false;

    const slowTimer = setTimeout(() => {
        markedSlow = true;
        reportRequestSlow();
    }, SLOW_REQUEST_MS);

    const abortTimer = setTimeout(() => {
        timedOut = true;
        controller.abort();
    }, REQUEST_ABORT_MS);

    try {
        return await fetch(input, { ...init, signal: controller.signal });
    } catch (error) {
        if (timedOut) {
            const timeoutError = Object.assign(
                new Error(`Request timed out after ${REQUEST_ABORT_MS}ms`),
                { isRequestTimeout: true as const },
            );
            throw timeoutError;
        }
        throw error;
    } finally {
        // Unconditional: every settle path — resolve, reject, our abort, the
        // caller's abort — must release the slow bookkeeping, or the band pins
        // on. (The one path this cannot cover is a promise that never settles at
        // all, which is why resetSlowRequests() also runs on app-foreground.)
        clearTimeout(slowTimer);
        clearTimeout(abortTimer);
        if (markedSlow) reportSlowRequestEnded();
        callerSignal?.removeEventListener('abort', onCallerAbort);
    }
};
