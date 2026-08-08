// Mock DB services and logger BEFORE any import.
const mockGetSettingsByPrefix = jest.fn(
    (_prefix: string): Promise<Record<string, string>> => Promise.resolve({}),
);
const mockSetSetting = jest.fn((_key: string, _value: string) => Promise.resolve());
const mockDeleteSetting = jest.fn((_key: string) => Promise.resolve());

jest.mock('@/lib/database/services/setting-service', () => ({
    getSetting: jest.fn(() => Promise.resolve(null)),
    getSettingsByPrefix: (prefix: string) => mockGetSettingsByPrefix(prefix),
    setSetting: (key: string, value: string) => mockSetSetting(key, value),
    deleteSetting: (key: string) => mockDeleteSetting(key),
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

import {
    TUTORIAL_SETTING_PREFIX,
    chapterCompletedKey,
    chapterIdFromKey,
    clearTutorialProgress,
    useTutorialsStore,
} from '../tutorials-store';

describe('tutorial setting keys', () => {
    it('round-trips a chapter id through its settings key', () => {
        const key = chapterCompletedKey('welcome');
        expect(key).toBe('tutorial_chapter_welcome_completed');
        expect(chapterIdFromKey(key)).toBe('welcome');
    });

    it('survives a slug containing the separator', () => {
        // Chapter ids are kebab-case today, but nothing forbids an underscore
        // and a naive split() would truncate one.
        const key = chapterCompletedKey('deep_dive');
        expect(chapterIdFromKey(key)).toBe('deep_dive');
    });

    it('rejects rows that are not chapter completions', () => {
        expect(chapterIdFromKey(`${TUTORIAL_SETTING_PREFIX}menu_seen`)).toBeNull();
        expect(chapterIdFromKey('feed_importance_filter')).toBeNull();
        expect(chapterIdFromKey('tutorial_chapter__completed')).toBeNull();
    });
});

describe('useTutorialsStore', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        useTutorialsStore.getState().reset();
    });

    it('starts empty and unhydrated', () => {
        const state = useTutorialsStore.getState();
        expect(state.completed.size).toBe(0);
        expect(state.menuSeen).toBe(false);
        expect(state.hydrated).toBe(false);
    });

    it('hydrates every chapter row from ONE prefix query', async () => {
        mockGetSettingsByPrefix.mockResolvedValueOnce({
            tutorial_chapter_welcome_completed: 'true',
            tutorial_chapter_privacy_completed: 'true',
            tutorial_menu_seen: 'true',
        });

        await useTutorialsStore.getState().hydrate();

        expect(mockGetSettingsByPrefix).toHaveBeenCalledTimes(1);
        expect(mockGetSettingsByPrefix).toHaveBeenCalledWith(TUTORIAL_SETTING_PREFIX);

        const state = useTutorialsStore.getState();
        expect([...state.completed].sort()).toEqual(['privacy', 'welcome']);
        expect(state.menuSeen).toBe(true);
        expect(state.hydrated).toBe(true);
    });

    it('ignores rows whose value is not exactly true', async () => {
        mockGetSettingsByPrefix.mockResolvedValueOnce({
            tutorial_chapter_welcome_completed: 'false',
            tutorial_chapter_feed_completed: '',
        });

        await useTutorialsStore.getState().hydrate();

        expect(useTutorialsStore.getState().completed.size).toBe(0);
        expect(useTutorialsStore.getState().menuSeen).toBe(false);
    });

    it('still flips hydrated when the read throws, and reports it', async () => {
        mockGetSettingsByPrefix.mockRejectedValueOnce(new Error('db closed'));

        await useTutorialsStore.getState().hydrate();

        // A failed read must not leave the menu spinning forever.
        expect(useTutorialsStore.getState().hydrated).toBe(true);
        expect(mockCaptureException).toHaveBeenCalled();
    });

    it('marks a chapter complete optimistically and persists it', () => {
        useTutorialsStore.getState().markCompleted('feed');

        expect(useTutorialsStore.getState().completed.has('feed')).toBe(true);
        expect(mockSetSetting).toHaveBeenCalledWith(
            'tutorial_chapter_feed_completed',
            'true',
        );
    });

    it('does not write twice for the same chapter', () => {
        useTutorialsStore.getState().markCompleted('feed');
        useTutorialsStore.getState().markCompleted('feed');

        expect(mockSetSetting).toHaveBeenCalledTimes(1);
    });

    it('swallows a failed persist into the logger rather than rejecting', async () => {
        mockSetSetting.mockRejectedValueOnce(new Error('write failed'));

        useTutorialsStore.getState().markCompleted('privacy');
        await Promise.resolve();
        await Promise.resolve();

        // The tick still shows; only the durability was lost.
        expect(useTutorialsStore.getState().completed.has('privacy')).toBe(true);
        expect(mockCaptureException).toHaveBeenCalled();
    });

    it('marks the menu seen once', () => {
        useTutorialsStore.getState().markMenuSeen();
        useTutorialsStore.getState().markMenuSeen();

        expect(useTutorialsStore.getState().menuSeen).toBe(true);
        expect(mockSetSetting).toHaveBeenCalledTimes(1);
        expect(mockSetSetting).toHaveBeenCalledWith('tutorial_menu_seen', 'true');
    });

    it('reset clears progress and un-hydrates', () => {
        useTutorialsStore.getState().markCompleted('feed');
        useTutorialsStore.setState({ hydrated: true });

        useTutorialsStore.getState().reset();

        const state = useTutorialsStore.getState();
        expect(state.completed.size).toBe(0);
        expect(state.menuSeen).toBe(false);
        expect(state.hydrated).toBe(false);
    });
});

describe('clearTutorialProgress', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        useTutorialsStore.getState().reset();
    });

    it('deletes every tutorial row and resets the store', async () => {
        mockGetSettingsByPrefix.mockResolvedValueOnce({
            tutorial_chapter_welcome_completed: 'true',
            tutorial_menu_seen: 'true',
        });
        useTutorialsStore.getState().markCompleted('welcome');

        await clearTutorialProgress();

        expect(mockDeleteSetting).toHaveBeenCalledWith(
            'tutorial_chapter_welcome_completed',
        );
        expect(mockDeleteSetting).toHaveBeenCalledWith('tutorial_menu_seen');
        expect(useTutorialsStore.getState().completed.size).toBe(0);
    });
});
