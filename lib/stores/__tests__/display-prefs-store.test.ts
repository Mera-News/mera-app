// Mock DB services and logger BEFORE any import
const mockGetSetting = jest.fn((_key: string): Promise<string | null> => Promise.resolve(null));
const mockSetSetting = jest.fn((_key: string, _value: string) => Promise.resolve());

jest.mock('@/lib/database/services/setting-service', () => ({
    getSetting: (key: string) => mockGetSetting(key),
    setSetting: (key: string, value: string) => mockSetSetting(key, value),
    deleteSetting: jest.fn(() => Promise.resolve()),
}));

const mockCaptureException = jest.fn();

jest.mock('@/lib/logger', () => ({
    __esModule: true,
    default: {
        captureException: (...args: unknown[]) => mockCaptureException(...args),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
        info: jest.fn(),
    },
}));

import { useDisplayPrefsStore } from '../display-prefs-store';

describe('useDisplayPrefsStore', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        useDisplayPrefsStore.setState({ staticGradient: false, hydrated: false });
    });

    // ── initial state ──────────────────────────────────────────────────────
    it('starts with staticGradient: false and hydrated: false', () => {
        const state = useDisplayPrefsStore.getState();
        expect(state.staticGradient).toBe(false);
        expect(state.hydrated).toBe(false);
    });

    // ── hydrate — happy path ───────────────────────────────────────────────
    it('hydrate sets staticGradient to true when DB returns "1"', async () => {
        mockGetSetting.mockResolvedValueOnce('1');
        await useDisplayPrefsStore.getState().hydrate();
        const state = useDisplayPrefsStore.getState();
        expect(state.staticGradient).toBe(true);
        expect(state.hydrated).toBe(true);
    });

    it('hydrate sets staticGradient to false when DB returns "0"', async () => {
        mockGetSetting.mockResolvedValueOnce('0');
        await useDisplayPrefsStore.getState().hydrate();
        expect(useDisplayPrefsStore.getState().staticGradient).toBe(false);
        expect(useDisplayPrefsStore.getState().hydrated).toBe(true);
    });

    // An unset preference means the animated background — the designed default.
    it('hydrate leaves staticGradient false when the setting is absent', async () => {
        mockGetSetting.mockResolvedValueOnce(null);
        await useDisplayPrefsStore.getState().hydrate();
        expect(useDisplayPrefsStore.getState().staticGradient).toBe(false);
        expect(useDisplayPrefsStore.getState().hydrated).toBe(true);
    });

    it('hydrate reads the correct setting key', async () => {
        await useDisplayPrefsStore.getState().hydrate();
        expect(mockGetSetting).toHaveBeenCalledWith('static_gradient');
    });

    // ── hydrate — error path ───────────────────────────────────────────────
    it('hydrate sets hydrated: true even when getSetting throws', async () => {
        mockGetSetting.mockRejectedValueOnce(new Error('db crash'));
        await useDisplayPrefsStore.getState().hydrate();
        expect(useDisplayPrefsStore.getState().hydrated).toBe(true);
    });

    it('hydrate calls captureException on error and does not throw', async () => {
        const err = new Error('db crash');
        mockGetSetting.mockRejectedValueOnce(err);
        await expect(useDisplayPrefsStore.getState().hydrate()).resolves.toBeUndefined();
        expect(mockCaptureException).toHaveBeenCalledWith(
            err,
            expect.objectContaining({ tags: { store: 'display-prefs-store' } }),
        );
    });

    // ── setStaticGradient ──────────────────────────────────────────────────
    it('setStaticGradient(true) updates state and persists "1"', async () => {
        useDisplayPrefsStore.getState().setStaticGradient(true);
        expect(useDisplayPrefsStore.getState().staticGradient).toBe(true);
        await Promise.resolve();
        expect(mockSetSetting).toHaveBeenCalledWith('static_gradient', '1');
    });

    it('setStaticGradient(false) updates state and persists "0"', async () => {
        useDisplayPrefsStore.setState({ staticGradient: true });
        useDisplayPrefsStore.getState().setStaticGradient(false);
        expect(useDisplayPrefsStore.getState().staticGradient).toBe(false);
        await Promise.resolve();
        expect(mockSetSetting).toHaveBeenCalledWith('static_gradient', '0');
    });

    it('setStaticGradient calls captureException when setSetting rejects', async () => {
        const err = new Error('persist fail');
        mockSetSetting.mockRejectedValueOnce(err);
        useDisplayPrefsStore.getState().setStaticGradient(true);
        await new Promise((r) => setTimeout(r, 0));
        expect(mockCaptureException).toHaveBeenCalledWith(
            err,
            expect.objectContaining({ tags: { store: 'display-prefs-store' } }),
        );
    });
});
