// Mock DB services and logger BEFORE any import
const mockGetSetting = jest.fn((_key: string): Promise<string | null> =>
    Promise.resolve(null),
);
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

import { useStartupTabStore } from '../startup-tab-store';

describe('useStartupTabStore', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        // Mocked explicitly per test rather than relying on the module-level
        // default (Promise.resolve(null)) so each case states its own intent.
        mockGetSetting.mockImplementation((_key: string) => Promise.resolve(null));
        useStartupTabStore.setState({ startupTab: 'feed', hydrated: false });
    });

    it('starts at the surface default (feed), unhydrated', () => {
        const state = useStartupTabStore.getState();
        expect(state.startupTab).toBe('feed');
        expect(state.hydrated).toBe(false);
    });

    it('hydrate reads the setting and adopts a valid stored tab', async () => {
        mockGetSetting.mockImplementation((key: string) =>
            Promise.resolve(key === 'startup_tab' ? 'around' : null),
        );
        await useStartupTabStore.getState().hydrate();
        const state = useStartupTabStore.getState();
        expect(mockGetSetting).toHaveBeenCalledWith('startup_tab');
        expect(state.startupTab).toBe('around');
        expect(state.hydrated).toBe(true);
    });

    it('hydrate falls back to the default on null', async () => {
        mockGetSetting.mockImplementation((_key: string) => Promise.resolve(null));
        useStartupTabStore.setState({ startupTab: 'around', hydrated: false });
        await useStartupTabStore.getState().hydrate();
        expect(useStartupTabStore.getState().startupTab).toBe('feed');
    });

    it('hydrate falls back to the default on a garbage/removed value', async () => {
        mockGetSetting.mockImplementation((_key: string) => Promise.resolve('bogus'));
        await useStartupTabStore.getState().hydrate();
        expect(useStartupTabStore.getState().startupTab).toBe('feed');
    });

    it('hydrate sets hydrated: true even when getSetting throws', async () => {
        const err = new Error('db crash');
        mockGetSetting.mockRejectedValue(err);
        await expect(
            useStartupTabStore.getState().hydrate(),
        ).resolves.toBeUndefined();
        expect(useStartupTabStore.getState().hydrated).toBe(true);
        expect(mockCaptureException).toHaveBeenCalledWith(
            err,
            expect.objectContaining({ tags: { store: 'startup-tab-store' } }),
        );
    });

    it('setStartupTab updates state synchronously and persists', async () => {
        useStartupTabStore.getState().setStartupTab('for_you');
        expect(useStartupTabStore.getState().startupTab).toBe('for_you');
        await Promise.resolve();
        expect(mockSetSetting).toHaveBeenCalledWith('startup_tab', 'for_you');
    });

    it('setter captures a persist failure without reverting state', async () => {
        const err = new Error('persist fail');
        mockSetSetting.mockRejectedValueOnce(err);
        useStartupTabStore.getState().setStartupTab('around');
        await new Promise((r) => setTimeout(r, 0));
        expect(useStartupTabStore.getState().startupTab).toBe('around');
        expect(mockCaptureException).toHaveBeenCalledWith(
            err,
            expect.objectContaining({ tags: { store: 'startup-tab-store' } }),
        );
    });

    it('reset returns to the default, unhydrated — clearAllStores() relies on this', () => {
        useStartupTabStore.setState({ startupTab: 'around', hydrated: true });
        useStartupTabStore.getState().reset();
        const state = useStartupTabStore.getState();
        expect(state.startupTab).toBe('feed');
        expect(state.hydrated).toBe(false);
    });
});
