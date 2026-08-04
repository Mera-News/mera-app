// Mock DB services and logger BEFORE any import
const mockGetSetting = jest.fn((_key: string): Promise<string | null> => Promise.resolve(null));
const mockSetSetting = jest.fn((_key: string, _value: string) => Promise.resolve());

jest.mock('@/lib/database/services/setting-service', () => ({
    getSetting: (key: string) => mockGetSetting(key),
    setSetting: (key: string, value: string) => mockSetSetting(key, value),
    deleteSetting: jest.fn(() => Promise.resolve()),
}));

// Mutable so each case can pose as a different device. `null` is expo-device's
// "couldn't determine" and must NOT be read as low-memory.
let mockTotalMemory: number | null = null;
jest.mock('expo-device', () => ({
    get totalMemory() {
        return mockTotalMemory;
    },
}));

const GB = 1024 * 1024 * 1024;

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
        mockTotalMemory = null;
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

    // ── device-derived default when the user has never chosen (B1.8) ───────
    // `null` from getSetting means "no row", which is NOT the same as '0'. Only
    // the null case consults the device.
    describe('unset preference falls back to the device default', () => {
        it('stays animated when total memory is unknown (null)', async () => {
            mockTotalMemory = null;
            mockGetSetting.mockResolvedValueOnce(null);
            await useDisplayPrefsStore.getState().hydrate();
            expect(useDisplayPrefsStore.getState().staticGradient).toBe(false);
            expect(useDisplayPrefsStore.getState().hydrated).toBe(true);
        });

        it('stays animated on an 8 GB device', async () => {
            mockTotalMemory = 8 * GB;
            mockGetSetting.mockResolvedValueOnce(null);
            await useDisplayPrefsStore.getState().hydrate();
            expect(useDisplayPrefsStore.getState().staticGradient).toBe(false);
        });

        it('defaults to the static backdrop on a 4 GB device', async () => {
            mockTotalMemory = 4 * GB;
            mockGetSetting.mockResolvedValueOnce(null);
            await useDisplayPrefsStore.getState().hydrate();
            expect(useDisplayPrefsStore.getState().staticGradient).toBe(true);
        });

        it('treats exactly 6 GB as not-low', async () => {
            mockTotalMemory = 6 * GB;
            mockGetSetting.mockResolvedValueOnce(null);
            await useDisplayPrefsStore.getState().hydrate();
            expect(useDisplayPrefsStore.getState().staticGradient).toBe(false);
        });

        it('never overrides an explicit "0" on a low-memory device', async () => {
            mockTotalMemory = 4 * GB;
            mockGetSetting.mockResolvedValueOnce('0');
            await useDisplayPrefsStore.getState().hydrate();
            expect(useDisplayPrefsStore.getState().staticGradient).toBe(false);
        });

        it('honours an explicit "1" on a high-memory device', async () => {
            mockTotalMemory = 8 * GB;
            mockGetSetting.mockResolvedValueOnce('1');
            await useDisplayPrefsStore.getState().hydrate();
            expect(useDisplayPrefsStore.getState().staticGradient).toBe(true);
        });
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
