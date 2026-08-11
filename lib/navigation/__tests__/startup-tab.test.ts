const mockGetSetting = jest.fn((_key: string): Promise<string | null> =>
    Promise.resolve(null),
);

jest.mock('@/lib/database/services/setting-service', () => ({
    getSetting: (key: string) => mockGetSetting(key),
}));

import { parseStartupTab, readStartupTab, STARTUP_TAB_SETTING_KEY } from '../startup-tab';

describe('parseStartupTab', () => {
    it.each(['feed', 'for_you', 'around'] as const)('accepts %s as-is', (tab) => {
        expect(parseStartupTab(tab)).toBe(tab);
    });

    it('falls back to feed on null, undefined, or garbage', () => {
        expect(parseStartupTab(null)).toBe('feed');
        expect(parseStartupTab(undefined)).toBe('feed');
        expect(parseStartupTab('dashboard')).toBe('feed'); // the user-facing label, not the route
        expect(parseStartupTab('')).toBe('feed');
    });
});

describe('readStartupTab', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('reads the settings key and returns a valid stored tab', async () => {
        mockGetSetting.mockResolvedValue('for_you');
        await expect(readStartupTab()).resolves.toBe('for_you');
        expect(mockGetSetting).toHaveBeenCalledWith(STARTUP_TAB_SETTING_KEY);
    });

    it('defaults to feed when nothing is stored', async () => {
        mockGetSetting.mockResolvedValue(null);
        await expect(readStartupTab()).resolves.toBe('feed');
    });

    it('fails safe to feed when the read throws', async () => {
        mockGetSetting.mockRejectedValue(new Error('db unreadable'));
        await expect(readStartupTab()).resolves.toBe('feed');
    });
});
