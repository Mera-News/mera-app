const mockGetSetting = jest.fn((_key: string): Promise<string | null> =>
    Promise.resolve(null),
);

jest.mock('@/lib/database/services/setting-service', () => ({
    getSetting: (key: string) => mockGetSetting(key),
}));

import { parseStartupTab, readStartupTab, STARTUP_TAB_SETTING_KEY } from '../startup-tab';

describe('parseStartupTab', () => {
    it.each(['feed', 'world', 'library'] as const)('accepts %s as-is', (tab) => {
        expect(parseStartupTab(tab)).toBe(tab);
    });

    // Old builds stored the old route names. Translated on read, never rewritten.
    it.each([
        ['for_you', 'feed'],
        ['around', 'world'],
    ] as const)('maps the old route %s to %s', (stored, tab) => {
        expect(parseStartupTab(stored)).toBe(tab);
    });

    it('falls back to feed on null, undefined, or garbage', () => {
        expect(parseStartupTab(null)).toBe('feed');
        expect(parseStartupTab(undefined)).toBe('feed');
        expect(parseStartupTab('dashboard')).toBe('feed'); // the user-facing label, not the route
        expect(parseStartupTab('you')).toBe('feed'); // a tab that is not an open-on-launch option
        expect(parseStartupTab('')).toBe('feed');
    });
});

describe('readStartupTab', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it.each([
        ['feed', 'feed'],
        ['world', 'world'],
        ['library', 'library'],
        ['for_you', 'feed'],
        ['around', 'world'],
    ])('stored %s opens the %s tab', async (stored, route) => {
        mockGetSetting.mockResolvedValue(stored);
        await expect(readStartupTab()).resolves.toBe(route);
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
