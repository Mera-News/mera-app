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
import { useNetworkStore, initNetworkListener, stopNetworkListener, useIsConnected } from '../network-store';

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
