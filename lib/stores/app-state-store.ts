import { create } from 'zustand';
import { getSetting, setSetting, deleteSetting } from '@/lib/database/services/setting-service';

interface AppState {
    // Navigation readiness (used to defer actions until navigation is ready)
    isNavigationReady: boolean;

    // App initialization state
    isAppInitialized: boolean;

    // Last authenticated user ID (useful for detecting user changes)
    lastAuthenticatedUserId: string | null;

    // Actions
    setNavigationReady: (ready: boolean) => void;
    setAppInitialized: (initialized: boolean) => void;
    setLastAuthenticatedUserId: (userId: string | null) => void;
    resetAppState: () => void;
    hydrateFromDb: () => Promise<void>;
}

const initialState = {
    isNavigationReady: false,
    isAppInitialized: false,
    lastAuthenticatedUserId: null,
};

export const useAppStateStore = create<AppState>((set) => ({
    ...initialState,

    setNavigationReady: (ready) => set({ isNavigationReady: ready }),

    setAppInitialized: (initialized) => set({ isAppInitialized: initialized }),

    setLastAuthenticatedUserId: (userId) => {
        set({ lastAuthenticatedUserId: userId });
        if (userId) {
            setSetting('last_authenticated_user_id', userId).catch(() => {});
        } else {
            deleteSetting('last_authenticated_user_id').catch(() => {});
        }
    },

    resetAppState: () => set(initialState),

    hydrateFromDb: async () => {
        try {
            const userId = await getSetting('last_authenticated_user_id');
            if (userId) set({ lastAuthenticatedUserId: userId });
        } catch {
            // Hydration failed — keep default
        }
    },
}));

// Selector hooks for optimized subscriptions
export const useIsNavigationReady = () =>
    useAppStateStore((state) => state.isNavigationReady);

export const useIsAppInitialized = () =>
    useAppStateStore((state) => state.isAppInitialized);

export const useLastAuthenticatedUserId = () =>
    useAppStateStore((state) => state.lastAuthenticatedUserId);
