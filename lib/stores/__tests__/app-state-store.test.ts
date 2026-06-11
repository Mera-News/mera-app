// Mock DB services BEFORE any import
const mockGetSetting = jest.fn((_key: string): Promise<string | null> => Promise.resolve(null));
const mockSetSetting = jest.fn((_key: string, _value: string) => Promise.resolve());
const mockDeleteSetting = jest.fn((_key: string) => Promise.resolve());

jest.mock('@/lib/database/services/setting-service', () => ({
    getSetting: (key: string) => mockGetSetting(key),
    setSetting: (key: string, value: string) => mockSetSetting(key, value),
    deleteSetting: (key: string) => mockDeleteSetting(key),
}));

const mockWarn = jest.fn();

jest.mock('@/lib/logger', () => ({
    __esModule: true,
    default: {
        captureException: jest.fn(),
        warn: (...args: unknown[]) => mockWarn(...args),
        error: jest.fn(),
        debug: jest.fn(),
        info: jest.fn(),
    },
}));

import { renderHook } from '@testing-library/react-native';
import { useAppStateStore, useIsNavigationReady, useIsAppInitialized, useLastAuthenticatedUserId } from '../app-state-store';

describe('useAppStateStore', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        useAppStateStore.getState().resetAppState();
    });

    // ── initial state ──────────────────────────────────────────────────────
    it('starts with all booleans false and null userId', () => {
        const state = useAppStateStore.getState();
        expect(state.isNavigationReady).toBe(false);
        expect(state.isAppInitialized).toBe(false);
        expect(state.lastAuthenticatedUserId).toBeNull();
    });

    // ── setNavigationReady ─────────────────────────────────────────────────
    it('setNavigationReady(true) flips the flag', () => {
        useAppStateStore.getState().setNavigationReady(true);
        expect(useAppStateStore.getState().isNavigationReady).toBe(true);
    });

    it('setNavigationReady(false) resets the flag', () => {
        useAppStateStore.getState().setNavigationReady(true);
        useAppStateStore.getState().setNavigationReady(false);
        expect(useAppStateStore.getState().isNavigationReady).toBe(false);
    });

    // ── setAppInitialized ─────────────────────────────────────────────────
    it('setAppInitialized(true) flips the flag', () => {
        useAppStateStore.getState().setAppInitialized(true);
        expect(useAppStateStore.getState().isAppInitialized).toBe(true);
    });

    it('setAppInitialized(false) resets the flag', () => {
        useAppStateStore.getState().setAppInitialized(true);
        useAppStateStore.getState().setAppInitialized(false);
        expect(useAppStateStore.getState().isAppInitialized).toBe(false);
    });

    // ── setLastAuthenticatedUserId ─────────────────────────────────────────
    it('setLastAuthenticatedUserId(id) stores the userId and calls setSetting', async () => {
        useAppStateStore.getState().setLastAuthenticatedUserId('user-1');
        expect(useAppStateStore.getState().lastAuthenticatedUserId).toBe('user-1');
        // Flush fire-and-forget
        await Promise.resolve();
        expect(mockSetSetting).toHaveBeenCalledWith('last_authenticated_user_id', 'user-1');
    });

    it('setLastAuthenticatedUserId(null) clears the userId and calls deleteSetting', async () => {
        useAppStateStore.getState().setLastAuthenticatedUserId('user-1');
        useAppStateStore.getState().setLastAuthenticatedUserId(null);
        expect(useAppStateStore.getState().lastAuthenticatedUserId).toBeNull();
        await Promise.resolve();
        expect(mockDeleteSetting).toHaveBeenCalledWith('last_authenticated_user_id');
    });

    it('setLastAuthenticatedUserId does not call setSetting when userId is null', async () => {
        useAppStateStore.getState().setLastAuthenticatedUserId(null);
        await Promise.resolve();
        expect(mockSetSetting).not.toHaveBeenCalled();
    });

    // ── resetAppState ─────────────────────────────────────────────────────
    it('resetAppState restores all defaults after mutations', () => {
        useAppStateStore.getState().setNavigationReady(true);
        useAppStateStore.getState().setAppInitialized(true);
        useAppStateStore.getState().setLastAuthenticatedUserId('uid-99');
        useAppStateStore.getState().resetAppState();

        const state = useAppStateStore.getState();
        expect(state.isNavigationReady).toBe(false);
        expect(state.isAppInitialized).toBe(false);
        expect(state.lastAuthenticatedUserId).toBeNull();
    });

    // ── hydrateFromDb ─────────────────────────────────────────────────────
    it('hydrateFromDb populates lastAuthenticatedUserId when found in DB', async () => {
        mockGetSetting.mockResolvedValueOnce('user-from-db');
        await useAppStateStore.getState().hydrateFromDb();
        expect(useAppStateStore.getState().lastAuthenticatedUserId).toBe('user-from-db');
    });

    it('hydrateFromDb does not update state when DB returns null', async () => {
        mockGetSetting.mockResolvedValueOnce(null);
        await useAppStateStore.getState().hydrateFromDb();
        expect(useAppStateStore.getState().lastAuthenticatedUserId).toBeNull();
    });

    it('hydrateFromDb logs a warning when getSetting throws', async () => {
        mockGetSetting.mockRejectedValueOnce(new Error('db error'));
        await useAppStateStore.getState().hydrateFromDb();
        expect(mockWarn).toHaveBeenCalledWith(
            '[app-state-store] hydrateFromDb failed',
            expect.objectContaining({ error: expect.stringContaining('db error') }),
        );
    });

    it('hydrateFromDb does not throw even on error', async () => {
        mockGetSetting.mockRejectedValueOnce(new Error('catastrophic'));
        await expect(useAppStateStore.getState().hydrateFromDb()).resolves.toBeUndefined();
    });

    it('setLastAuthenticatedUserId swallows setSetting errors silently', async () => {
        mockSetSetting.mockRejectedValueOnce(new Error('storage error'));
        useAppStateStore.getState().setLastAuthenticatedUserId('user-err');
        await new Promise((r) => setImmediate(r));
        // No throw — catch callback covers the .catch(() => {}) lambda
        expect(useAppStateStore.getState().lastAuthenticatedUserId).toBe('user-err');
    });

    it('setLastAuthenticatedUserId swallows deleteSetting errors silently', async () => {
        mockDeleteSetting.mockRejectedValueOnce(new Error('storage error'));
        useAppStateStore.getState().setLastAuthenticatedUserId(null);
        await new Promise((r) => setImmediate(r));
        // No throw — catch callback covers the .catch(() => {}) lambda
        expect(useAppStateStore.getState().lastAuthenticatedUserId).toBeNull();
    });

    // ── selector hooks (exported) ──────────────────────────────────────────
    it('useIsNavigationReady returns current value', () => {
        const { result } = renderHook(() => useIsNavigationReady());
        expect(result.current).toBe(false);
    });

    it('useIsAppInitialized returns current value', () => {
        const { result } = renderHook(() => useIsAppInitialized());
        expect(result.current).toBe(false);
    });

    it('useLastAuthenticatedUserId returns current value', () => {
        const { result } = renderHook(() => useLastAuthenticatedUserId());
        expect(result.current).toBeNull();
    });
});
