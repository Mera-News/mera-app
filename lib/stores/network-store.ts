import { create } from 'zustand';
import logger from '@/lib/logger';
import { AUTH_ENDPOINT } from '@/lib/config/endpoints';

// NetInfo requires a native module that may not be available (e.g. Expo Go).
let NetInfo: typeof import('@react-native-community/netinfo').default | null = null;
try {
    NetInfo = require('@react-native-community/netinfo').default;
} catch (err) {
    logger.captureException(err, { tags: { store: 'network-store', method: 'init' } });
}

interface NetworkState {
    /** Device-level connectivity, from NetInfo. */
    isConnected: boolean;
    /**
     * Whether the SERVER is answering. Independent of `isConnected`: a device on
     * a healthy LTE connection talking to a dead/5xx/DNS-broken server is
     * connected but not reachable, and treating those as the same thing is what
     * ejected users into a "Welcome back" screen they could not complete.
     * Seeded true — optimistic-unknown, same policy as `isConnected`.
     */
    serverReachable: boolean;
    /**
     * At least one request has been in flight longer than SLOW_REQUEST_MS. Drives
     * the offline band ONLY — never the identity gate, because a slow-but-
     * answering server can still complete an OTP.
     */
    serverSlow: boolean;

    // Actions
    setIsConnected: (connected: boolean) => void;
    setServerReachable: (reachable: boolean) => void;
    setServerSlow: (slow: boolean) => void;
}

export const useNetworkStore = create<NetworkState>((set) => ({
    // Default false when NetInfo unavailable — conservative (avoids stale online assumption)
    isConnected: NetInfo !== null,
    serverReachable: true,
    serverSlow: false,

    setIsConnected: (connected) => set({ isConnected: connected }),
    setServerReachable: (reachable) => set({ serverReachable: reachable }),
    setServerSlow: (slow) => set({ serverSlow: slow }),
}));

// ---------------------------------------------------------------------------
// Server reachability
// ---------------------------------------------------------------------------

/**
 * Consecutive failed OPERATIONS (not packets) before we call the server
 * unreachable. The Apollo error link sits upstream of the retry link, so it
 * observes one failure per operation AFTER its 3 retries are exhausted — two
 * therefore means "two distinct operations gave up", not "two dropped packets".
 */
const SERVER_FAILURE_THRESHOLD = 2;

let consecutiveTransportFailures = 0;

/**
 * A request failed with no HTTP response at all, or with a 5xx. Only evidence of
 * this shape counts: a 4xx means the server answered, and an aborted request
 * (screen unmount / tab switch) means nothing at all — see `apollo-fetch.ts`,
 * which marks its own timeouts so they can be told apart from cancellations.
 */
export function recordServerTransportFailure(): void {
    consecutiveTransportFailures += 1;
    if (consecutiveTransportFailures < SERVER_FAILURE_THRESHOLD) return;
    if (useNetworkStore.getState().serverReachable) {
        useNetworkStore.getState().setServerReachable(false);
    }
}

/**
 * Any HTTP response at all proves the server answered — including a 4xx and
 * including a 200 carrying GraphQL errors. Resets the counter and clears the
 * unreachable flag.
 */
export function recordServerReachable(): void {
    consecutiveTransportFailures = 0;
    if (!useNetworkStore.getState().serverReachable) {
        useNetworkStore.getState().setServerReachable(true);
    }
}

/** Probe verdict — authoritative, so it bypasses the threshold. */
export function markServerUnreachable(): void {
    consecutiveTransportFailures = SERVER_FAILURE_THRESHOLD;
    if (useNetworkStore.getState().serverReachable) {
        useNetworkStore.getState().setServerReachable(false);
    }
}

// ---------------------------------------------------------------------------
// Slow-request tracking (band signal only)
// ---------------------------------------------------------------------------

let slowInFlight = 0;

/** A request has crossed the slow threshold. */
export function reportRequestSlow(): void {
    slowInFlight += 1;
    if (slowInFlight === 1) useNetworkStore.getState().setServerSlow(true);
}

/** A previously-slow request finally settled (resolved, rejected or aborted). */
export function reportSlowRequestEnded(): void {
    if (slowInFlight === 0) return;
    slowInFlight -= 1;
    if (slowInFlight === 0) useNetworkStore.getState().setServerSlow(false);
}

/**
 * Drop all slow-request bookkeeping.
 *
 * Called on app-foreground (AppScheduler._onForeground). iOS freezes timers
 * while backgrounded, so a request interrupted by a background transition can
 * have its slow timer fire on resume against a promise that NEVER settles — the
 * `finally` that would decrement never runs, `slowInFlight` stays >= 1, and the
 * band is pinned for the rest of the app session. Same rationale, and the same
 * home, as the scheduler's stale-`running`-flag sweep. Self-correcting: a
 * genuinely still-slow request re-arms within SLOW_REQUEST_MS.
 */
export function resetSlowRequests(): void {
    slowInFlight = 0;
    if (useNetworkStore.getState().serverSlow) {
        useNetworkStore.getState().setServerSlow(false);
    }
}

// ---------------------------------------------------------------------------
// Probe
// ---------------------------------------------------------------------------

/** Budget for the reachability probe. Only ever spent on the ownership-fault path. */
const PROBE_TIMEOUT_MS = 3_000;

/**
 * Better Auth's health route. Verified against the deployed service: the auth
 * app is mounted at `/api/auth`, so `${AUTH_ENDPOINT}/ok` is a 404 and
 * `${AUTH_ENDPOINT}/api/auth/ok` returns 200 `{"ok":true}` (checked on both
 * prod and staging, 2026-08-03).
 */
const PROBE_PATH = '/api/auth/ok';

/**
 * One-shot, bounded probe of the AUTH server.
 *
 * Deliberately targets AUTH rather than GraphQL: the only caller is the identity
 * gate's decision about whether to eject a user into an OTP re-auth, and OTP
 * talks to the auth service on a different host. GraphQL health would be a proxy
 * for the wrong thing — a healthy GraphQL server would license an eject into an
 * OTP that cannot be sent. (GraphQL reachability is covered separately, by the
 * passive failure counter above, which observes real GraphQL traffic.)
 */
export async function probeServerReachable(
    timeoutMs: number = PROBE_TIMEOUT_MS,
): Promise<boolean> {
    // Nothing to probe with, and the answer is already known.
    if (!useNetworkStore.getState().isConnected) return false;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetch(`${AUTH_ENDPOINT}${PROBE_PATH}`, {
            method: 'GET',
            signal: controller.signal,
        });
        // Any answer below 500 proves the host is up and serving. A 5xx is the
        // server telling us it is broken, which is not "reachable" for our
        // purposes — the user still could not complete an OTP.
        const reachable = response.status < 500;
        if (reachable) recordServerReachable();
        else markServerUnreachable();
        return reachable;
    } catch {
        // Timeout, DNS failure, TLS failure, refused connection.
        markServerUnreachable();
        return false;
    } finally {
        clearTimeout(timer);
    }
}

/** Test-only: reset module-level reachability/slow bookkeeping. */
export function _resetNetworkTrackingForTests(): void {
    consecutiveTransportFailures = 0;
    slowInFlight = 0;
}

// Unsubscribe handle for cleanup
let unsubscribe: (() => void) | null = null;

/**
 * Start listening to network state changes via NetInfo.
 * Call once from the root layout on app start.
 *
 * Seeds the store with a real `NetInfo.fetch()` read before wiring the event
 * listener — `addEventListener`'s first callback can lag, so without this a
 * cold start in airplane mode is misreported as "online" (the module-present
 * default) until that first event finally arrives.
 */
export function initNetworkListener(): void {
    if (!NetInfo || unsubscribe) return;

    NetInfo.fetch()
        .then((state) => {
            useNetworkStore.getState().setIsConnected(state.isConnected ?? true);
        })
        .catch((err) => {
            logger.captureException(err, {
                tags: { store: 'network-store', method: 'initNetworkListener-fetch' },
            });
        });

    unsubscribe = NetInfo.addEventListener((state) => {
        useNetworkStore.getState().setIsConnected(state.isConnected ?? true);
    });
}

/**
 * Stop listening (useful for cleanup/testing).
 */
export function stopNetworkListener(): void {
    unsubscribe?.();
    unsubscribe = null;
}

// Selector hooks
export const useIsConnected = () => useNetworkStore((s) => s.isConnected);

/**
 * "We can reach Mera and it answers." Feeds the identity gate, ReauthBanner and
 * the onboarding offline guard. Excludes `serverSlow` on purpose — a slow server
 * can still complete an OTP or a mutation.
 */
export const useIsOnline = () =>
    useNetworkStore((s) => s.isConnected && s.serverReachable);

/** Non-reactive equivalent of `useIsOnline`, for non-React callers. */
export function isOnline(): boolean {
    const { isConnected, serverReachable } = useNetworkStore.getState();
    return isConnected && serverReachable;
}

/**
 * "Nothing is going to appear promptly." Feeds the offline BAND only — this is
 * the term that makes a terrible-but-working network visible.
 */
export const useIsNetworkHealthy = () =>
    useNetworkStore((s) => s.isConnected && s.serverReachable && !s.serverSlow);
