// Override the global netinfo mock with a controllable version
// so we can simulate connectivity callbacks.
const mockUnsubscribe = jest.fn();
let registeredListener: ((state: { isConnected: boolean | null }) => void) | null = null;

jest.mock('@react-native-community/netinfo', () => ({
    __esModule: true,
    default: {
        fetch: jest.fn(() => Promise.resolve({ isConnected: true, isInternetReachable: true })),
        addEventListener: jest.fn((cb: (state: { isConnected: boolean | null }) => void) => {
            registeredListener = cb;
            return mockUnsubscribe;
        }),
    },
}));

jest.mock('@/lib/logger', () => ({
    __esModule: true,
    default: {
        captureException: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
        info: jest.fn(),
    },
}));

import { renderHook } from '@testing-library/react-native';
import {
    useNetworkStore,
    initNetworkListener,
    stopNetworkListener,
    useIsConnected,
    _resetNetworkTrackingForTests,
    isOnline,
    markServerUnreachable,
    probeServerReachable,
    recordServerReachable,
    recordServerTransportFailure,
    reportRequestSlow,
    reportSlowRequestEnded,
    resetSlowRequests,
} from '../network-store';

describe('useNetworkStore', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        registeredListener = null;
        // Stop any running listener from a previous test
        stopNetworkListener();
        // Reset the store to the "NetInfo available" default (isConnected: true)
        useNetworkStore.setState({ isConnected: true });
    });

    afterEach(() => {
        stopNetworkListener();
    });

    // ── initial state ──────────────────────────────────────────────────────
    it('starts with isConnected: true when NetInfo is available', () => {
        expect(useNetworkStore.getState().isConnected).toBe(true);
    });

    // ── setIsConnected ────────────────────────────────────────────────────
    it('setIsConnected(false) updates store', () => {
        useNetworkStore.getState().setIsConnected(false);
        expect(useNetworkStore.getState().isConnected).toBe(false);
    });

    it('setIsConnected(true) updates store', () => {
        useNetworkStore.getState().setIsConnected(false);
        useNetworkStore.getState().setIsConnected(true);
        expect(useNetworkStore.getState().isConnected).toBe(true);
    });

    // ── initNetworkListener ───────────────────────────────────────────────
    it('initNetworkListener registers an addEventListener callback', () => {
        const NetInfo = require('@react-native-community/netinfo').default;
        initNetworkListener();
        expect(NetInfo.addEventListener).toHaveBeenCalledTimes(1);
        expect(registeredListener).toBeInstanceOf(Function);
    });

    // ── cold-start seeding via NetInfo.fetch() ──────────────────────────────
    it('initNetworkListener seeds isConnected from NetInfo.fetch() on cold start', async () => {
        const NetInfo = require('@react-native-community/netinfo').default;
        (NetInfo.fetch as jest.Mock).mockResolvedValueOnce({
            isConnected: false,
            isInternetReachable: false,
        });
        // Store defaults to true (module-present) before the fetch resolves.
        expect(useNetworkStore.getState().isConnected).toBe(true);

        initNetworkListener();
        expect(NetInfo.fetch).toHaveBeenCalledTimes(1);

        // Flush the fetch() promise microtask.
        await Promise.resolve();
        await Promise.resolve();

        expect(useNetworkStore.getState().isConnected).toBe(false);
    });

    it('initNetworkListener treats a null isConnected from NetInfo.fetch() as true (conservative default)', async () => {
        const NetInfo = require('@react-native-community/netinfo').default;
        (NetInfo.fetch as jest.Mock).mockResolvedValueOnce({
            isConnected: null,
            isInternetReachable: null,
        });

        initNetworkListener();
        await Promise.resolve();
        await Promise.resolve();

        expect(useNetworkStore.getState().isConnected).toBe(true);
    });

    it('initNetworkListener captures NetInfo.fetch() rejections without throwing', async () => {
        const NetInfo = require('@react-native-community/netinfo').default;
        const logger = require('@/lib/logger').default;
        const fetchError = new Error('fetch failed');
        (NetInfo.fetch as jest.Mock).mockRejectedValueOnce(fetchError);

        expect(() => initNetworkListener()).not.toThrow();
        await Promise.resolve();
        await Promise.resolve();

        expect(logger.captureException).toHaveBeenCalledWith(
            fetchError,
            expect.objectContaining({
                tags: expect.objectContaining({ store: 'network-store' }),
            }),
        );
    });

    it('initNetworkListener is idempotent — second call does not double-subscribe', () => {
        const NetInfo = require('@react-native-community/netinfo').default;
        initNetworkListener();
        initNetworkListener();
        expect(NetInfo.addEventListener).toHaveBeenCalledTimes(1);
    });

    it('connectivity callback sets isConnected to false when network drops', () => {
        initNetworkListener();
        registeredListener!({ isConnected: false });
        expect(useNetworkStore.getState().isConnected).toBe(false);
    });

    it('connectivity callback sets isConnected to true when network restores', () => {
        initNetworkListener();
        registeredListener!({ isConnected: false });
        registeredListener!({ isConnected: true });
        expect(useNetworkStore.getState().isConnected).toBe(true);
    });

    it('connectivity callback treats null isConnected as true (conservative default)', () => {
        initNetworkListener();
        registeredListener!({ isConnected: null });
        expect(useNetworkStore.getState().isConnected).toBe(true);
    });

    // ── stopNetworkListener ───────────────────────────────────────────────
    it('stopNetworkListener calls the unsubscribe handle returned by addEventListener', () => {
        initNetworkListener();
        stopNetworkListener();
        expect(mockUnsubscribe).toHaveBeenCalledTimes(1);
    });

    it('stopNetworkListener is safe to call when no listener is running', () => {
        expect(() => stopNetworkListener()).not.toThrow();
    });

    it('after stopNetworkListener, initNetworkListener can restart the listener', () => {
        const NetInfo = require('@react-native-community/netinfo').default;
        initNetworkListener();
        stopNetworkListener();
        // Reset mock call count
        (NetInfo.addEventListener as jest.Mock).mockClear();
        initNetworkListener();
        expect(NetInfo.addEventListener).toHaveBeenCalledTimes(1);
    });

    // ── useIsConnected selector ───────────────────────────────────────────
    it('useIsConnected returns isConnected value', () => {
        const { result } = renderHook(() => useIsConnected());
        expect(result.current).toBe(true);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Server reachability — device connectivity and SERVER reachability are
// different facts. Conflating them is what ejected users into a "Welcome back"
// screen they could not complete: a live LTE connection to a dead server
// satisfies `isConnected`.
// ─────────────────────────────────────────────────────────────────────────────
describe('server reachability', () => {
    beforeEach(() => {
        useNetworkStore.setState({
            isConnected: true,
            serverReachable: true,
            serverSlow: false,
        });
        _resetNetworkTrackingForTests();
        jest.restoreAllMocks();
    });

    describe('transport-failure threshold', () => {
        it('tolerates a single failure — one blip is not an outage', () => {
            recordServerTransportFailure();
            expect(useNetworkStore.getState().serverReachable).toBe(true);
        });

        it('declares the server unreachable on the second consecutive failure', () => {
            recordServerTransportFailure();
            recordServerTransportFailure();
            expect(useNetworkStore.getState().serverReachable).toBe(false);
        });

        it('resets the run — an interleaved success makes the next failure start over', () => {
            recordServerTransportFailure();
            recordServerReachable();
            recordServerTransportFailure();
            expect(useNetworkStore.getState().serverReachable).toBe(true);
        });

        it('markServerUnreachable bypasses the threshold (the probe is authoritative)', () => {
            markServerUnreachable();
            expect(useNetworkStore.getState().serverReachable).toBe(false);
        });
    });

    describe('isOnline', () => {
        it('requires BOTH device connectivity and a reachable server', () => {
            expect(isOnline()).toBe(true);
            useNetworkStore.setState({ isConnected: false });
            expect(isOnline()).toBe(false);
            useNetworkStore.setState({ isConnected: true, serverReachable: false });
            expect(isOnline()).toBe(false);
        });

        it('ignores serverSlow — a slow server can still complete an OTP', () => {
            useNetworkStore.setState({ serverSlow: true });
            expect(isOnline()).toBe(true);
        });
    });

    describe('slow-request tracking', () => {
        it('arms on the first slow request and disarms when the last one settles', () => {
            reportRequestSlow();
            expect(useNetworkStore.getState().serverSlow).toBe(true);
            reportRequestSlow();
            reportSlowRequestEnded();
            // One slow request still outstanding.
            expect(useNetworkStore.getState().serverSlow).toBe(true);
            reportSlowRequestEnded();
            expect(useNetworkStore.getState().serverSlow).toBe(false);
        });

        it('never underflows on an extra settle', () => {
            reportSlowRequestEnded();
            reportSlowRequestEnded();
            expect(useNetworkStore.getState().serverSlow).toBe(false);
            // The counter really is at zero, so one slow request still arms.
            reportRequestSlow();
            expect(useNetworkStore.getState().serverSlow).toBe(true);
        });

        it('resetSlowRequests clears a band stranded by a frozen background timer', () => {
            // iOS freezes timers while backgrounded: a request interrupted
            // mid-flight can arm the band from a timer that fires on resume and
            // then never settle, so the decrementing `finally` never runs and
            // the band pins on for the rest of the session.
            reportRequestSlow();
            reportRequestSlow();
            expect(useNetworkStore.getState().serverSlow).toBe(true);

            resetSlowRequests();
            expect(useNetworkStore.getState().serverSlow).toBe(false);

            // And the counter is genuinely zero — not merely the flag.
            reportRequestSlow();
            expect(useNetworkStore.getState().serverSlow).toBe(true);
            reportSlowRequestEnded();
            expect(useNetworkStore.getState().serverSlow).toBe(false);
        });
    });

    describe('probeServerReachable', () => {
        it('short-circuits false when the device is offline (no round-trip spent)', async () => {
            const fetchSpy = jest.spyOn(global, 'fetch');
            useNetworkStore.setState({ isConnected: false });

            await expect(probeServerReachable()).resolves.toBe(false);
            expect(fetchSpy).not.toHaveBeenCalled();
        });

        it('hits the better-auth health route under /api/auth', async () => {
            const fetchSpy = jest
                .spyOn(global, 'fetch')
                .mockResolvedValue({ status: 200 } as Response);

            await expect(probeServerReachable()).resolves.toBe(true);
            expect(String(fetchSpy.mock.calls[0][0])).toContain('/api/auth/ok');
        });

        it('treats any answer below 500 as reachable', async () => {
            jest.spyOn(global, 'fetch').mockResolvedValue({ status: 401 } as Response);
            useNetworkStore.setState({ serverReachable: false });

            await expect(probeServerReachable()).resolves.toBe(true);
            expect(useNetworkStore.getState().serverReachable).toBe(true);
        });

        it('treats a 5xx as unreachable — the user still could not complete an OTP', async () => {
            jest.spyOn(global, 'fetch').mockResolvedValue({ status: 503 } as Response);

            await expect(probeServerReachable()).resolves.toBe(false);
            expect(useNetworkStore.getState().serverReachable).toBe(false);
        });

        it('treats a throw (timeout / DNS / refused) as unreachable', async () => {
            jest.spyOn(global, 'fetch').mockRejectedValue(new Error('connection refused'));

            await expect(probeServerReachable()).resolves.toBe(false);
            expect(useNetworkStore.getState().serverReachable).toBe(false);
        });

        it('is bounded — a hanging probe resolves false rather than blocking launch', async () => {
            jest.spyOn(global, 'fetch').mockImplementation(
                (_input, init) =>
                    new Promise((_resolve, reject) => {
                        (init as RequestInit).signal?.addEventListener('abort', () =>
                            reject(Object.assign(new Error('Aborted'), { name: 'AbortError' })),
                        );
                    }),
            );

            await expect(probeServerReachable(20)).resolves.toBe(false);
        });
    });
});
