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

import { useForYouPrefsStore } from '../for-you-prefs-store';

describe('useForYouPrefsStore', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        // Reset to known initial state
        useForYouPrefsStore.setState({ recent24hOnly: false, hydrated: false });
    });

    // ── initial state ──────────────────────────────────────────────────────
    it('starts with recent24hOnly: false and hydrated: false', () => {
        const state = useForYouPrefsStore.getState();
        expect(state.recent24hOnly).toBe(false);
        expect(state.hydrated).toBe(false);
    });

    // ── hydrate — happy path ───────────────────────────────────────────────
    it('hydrate sets recent24hOnly to true when DB returns "1"', async () => {
        mockGetSetting.mockResolvedValueOnce('1');
        await useForYouPrefsStore.getState().hydrate();
        const state = useForYouPrefsStore.getState();
        expect(state.recent24hOnly).toBe(true);
        expect(state.hydrated).toBe(true);
    });

    it('hydrate sets recent24hOnly to false when DB returns "0"', async () => {
        mockGetSetting.mockResolvedValueOnce('0');
        await useForYouPrefsStore.getState().hydrate();
        const state = useForYouPrefsStore.getState();
        expect(state.recent24hOnly).toBe(false);
        expect(state.hydrated).toBe(true);
    });

    it('hydrate sets recent24hOnly to false when DB returns null', async () => {
        mockGetSetting.mockResolvedValueOnce(null);
        await useForYouPrefsStore.getState().hydrate();
        const state = useForYouPrefsStore.getState();
        expect(state.recent24hOnly).toBe(false);
        expect(state.hydrated).toBe(true);
    });

    it('hydrate reads the correct setting key', async () => {
        mockGetSetting.mockResolvedValueOnce(null);
        await useForYouPrefsStore.getState().hydrate();
        expect(mockGetSetting).toHaveBeenCalledWith('for_you_recent_24h_only');
    });

    // ── hydrate — error path ──────────────────────────────────────────────
    it('hydrate sets hydrated: true even when getSetting throws', async () => {
        mockGetSetting.mockRejectedValueOnce(new Error('db crash'));
        await useForYouPrefsStore.getState().hydrate();
        expect(useForYouPrefsStore.getState().hydrated).toBe(true);
    });

    it('hydrate calls captureException on error', async () => {
        const err = new Error('db crash');
        mockGetSetting.mockRejectedValueOnce(err);
        await useForYouPrefsStore.getState().hydrate();
        expect(mockCaptureException).toHaveBeenCalledWith(
            err,
            expect.objectContaining({ tags: { store: 'for-you-prefs-store' } }),
        );
    });

    it('hydrate does not throw even when getSetting rejects', async () => {
        mockGetSetting.mockRejectedValueOnce(new Error('boom'));
        await expect(useForYouPrefsStore.getState().hydrate()).resolves.toBeUndefined();
    });

    // ── setRecent24hOnly ──────────────────────────────────────────────────
    it('setRecent24hOnly(true) sets recent24hOnly and persists "1"', async () => {
        useForYouPrefsStore.getState().setRecent24hOnly(true);
        expect(useForYouPrefsStore.getState().recent24hOnly).toBe(true);
        await Promise.resolve();
        expect(mockSetSetting).toHaveBeenCalledWith('for_you_recent_24h_only', '1');
    });

    it('setRecent24hOnly(false) sets recent24hOnly and persists "0"', async () => {
        useForYouPrefsStore.setState({ recent24hOnly: true });
        useForYouPrefsStore.getState().setRecent24hOnly(false);
        expect(useForYouPrefsStore.getState().recent24hOnly).toBe(false);
        await Promise.resolve();
        expect(mockSetSetting).toHaveBeenCalledWith('for_you_recent_24h_only', '0');
    });

    it('setRecent24hOnly calls captureException when setSetting rejects', async () => {
        const err = new Error('persist fail');
        mockSetSetting.mockRejectedValueOnce(err);
        useForYouPrefsStore.getState().setRecent24hOnly(true);
        // Drain micro-task queue for the catch handler
        await new Promise((r) => setTimeout(r, 0));
        expect(mockCaptureException).toHaveBeenCalledWith(
            err,
            expect.objectContaining({ tags: { store: 'for-you-prefs-store' } }),
        );
    });
});
