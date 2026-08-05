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

import { useImportanceFilterStore } from '../importance-filter-store';

describe('useImportanceFilterStore', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        useImportanceFilterStore.setState({
            feedThreshold: 'medium',
            dashboardThreshold: 'low',
            hydrated: false,
        });
    });

    it('starts at the surface defaults (feed medium, dashboard low), unhydrated', () => {
        const state = useImportanceFilterStore.getState();
        expect(state.feedThreshold).toBe('medium');
        expect(state.dashboardThreshold).toBe('low');
        expect(state.hydrated).toBe(false);
    });

    it('hydrate reads both keys and parses stored values', async () => {
        mockGetSetting.mockImplementation((key: string) =>
            Promise.resolve(
                key === 'feed_importance_filter'
                    ? 'high'
                    : key === 'dashboard_importance_filter'
                      ? 'medium'
                      : null,
            ),
        );
        await useImportanceFilterStore.getState().hydrate();
        const state = useImportanceFilterStore.getState();
        expect(mockGetSetting).toHaveBeenCalledWith('feed_importance_filter');
        expect(mockGetSetting).toHaveBeenCalledWith('dashboard_importance_filter');
        expect(state.feedThreshold).toBe('high');
        expect(state.dashboardThreshold).toBe('medium');
        expect(state.hydrated).toBe(true);
    });

    it('hydrate falls back to per-surface defaults on null and garbage', async () => {
        mockGetSetting.mockImplementation((key: string) =>
            Promise.resolve(key === 'feed_importance_filter' ? 'bogus' : null),
        );
        useImportanceFilterStore.setState({
            feedThreshold: 'low',
            dashboardThreshold: 'high',
            hydrated: false,
        });
        await useImportanceFilterStore.getState().hydrate();
        const state = useImportanceFilterStore.getState();
        expect(state.feedThreshold).toBe('medium'); // feed default
        expect(state.dashboardThreshold).toBe('low'); // dashboard default
    });

    it('hydrate sets hydrated: true even when getSetting throws', async () => {
        const err = new Error('db crash');
        mockGetSetting.mockRejectedValue(err);
        await expect(
            useImportanceFilterStore.getState().hydrate(),
        ).resolves.toBeUndefined();
        expect(useImportanceFilterStore.getState().hydrated).toBe(true);
        expect(mockCaptureException).toHaveBeenCalledWith(
            err,
            expect.objectContaining({ tags: { store: 'importance-filter-store' } }),
        );
        mockGetSetting.mockImplementation(() => Promise.resolve(null));
    });

    it('setFeedThreshold updates state synchronously and persists its own key', async () => {
        useImportanceFilterStore.getState().setFeedThreshold('low');
        expect(useImportanceFilterStore.getState().feedThreshold).toBe('low');
        // dashboard untouched
        expect(useImportanceFilterStore.getState().dashboardThreshold).toBe('low');
        await Promise.resolve();
        expect(mockSetSetting).toHaveBeenCalledWith('feed_importance_filter', 'low');
        expect(mockSetSetting).not.toHaveBeenCalledWith(
            'dashboard_importance_filter',
            expect.anything(),
        );
    });

    it('setDashboardThreshold updates state synchronously and persists its own key', async () => {
        useImportanceFilterStore.getState().setDashboardThreshold('high');
        expect(useImportanceFilterStore.getState().dashboardThreshold).toBe('high');
        expect(useImportanceFilterStore.getState().feedThreshold).toBe('medium');
        await Promise.resolve();
        expect(mockSetSetting).toHaveBeenCalledWith(
            'dashboard_importance_filter',
            'high',
        );
    });

    it('setter captures a persist failure without reverting state', async () => {
        const err = new Error('persist fail');
        mockSetSetting.mockRejectedValueOnce(err);
        useImportanceFilterStore.getState().setFeedThreshold('high');
        await new Promise((r) => setTimeout(r, 0));
        expect(useImportanceFilterStore.getState().feedThreshold).toBe('high');
        expect(mockCaptureException).toHaveBeenCalledWith(
            err,
            expect.objectContaining({ tags: { store: 'importance-filter-store' } }),
        );
    });
});
