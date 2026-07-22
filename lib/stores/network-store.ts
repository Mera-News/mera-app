import { create } from 'zustand';
import logger from '@/lib/logger';

// NetInfo requires a native module that may not be available (e.g. Expo Go).
let NetInfo: typeof import('@react-native-community/netinfo').default | null = null;
try {
    NetInfo = require('@react-native-community/netinfo').default;
} catch (err) {
    logger.captureException(err, { tags: { store: 'network-store', method: 'init' } });
}

interface NetworkState {
    isConnected: boolean;

    // Actions
    setIsConnected: (connected: boolean) => void;
}

export const useNetworkStore = create<NetworkState>((set) => ({
    // Default false when NetInfo unavailable — conservative (avoids stale online assumption)
    isConnected: NetInfo !== null,

    setIsConnected: (connected) => set({ isConnected: connected }),
}));

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
