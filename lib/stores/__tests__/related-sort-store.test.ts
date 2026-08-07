// related-sort-store — the persisted Related Articles sort preference, shared
// by BOTH detail routes.

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

import {
    DEFAULT_RELATED_SORT_MODE,
    parseRelatedSortMode,
    RELATED_SORT_MODES,
    useRelatedSortStore,
} from '../related-sort-store';

describe('parseRelatedSortMode', () => {
    it.each(RELATED_SORT_MODES)('accepts the known mode %s', (mode) => {
        expect(parseRelatedSortMode(mode)).toBe(mode);
    });

    it.each([null, undefined, '', 'RELEVANCE', 'random'])(
        'falls back to the default for %p',
        (raw) => {
            expect(parseRelatedSortMode(raw as never)).toBe(DEFAULT_RELATED_SORT_MODE);
        },
    );

    it('honours an explicit fallback', () => {
        expect(parseRelatedSortMode('nope', 'newest')).toBe('newest');
    });
});

describe('useRelatedSortStore', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        useRelatedSortStore.setState({
            mode: DEFAULT_RELATED_SORT_MODE,
            hydrated: false,
        });
    });

    it('defaults to today\'s ordering, unhydrated', () => {
        expect(useRelatedSortStore.getState().mode).toBe('relevance');
        expect(useRelatedSortStore.getState().hydrated).toBe(false);
    });

    it('hydrate reads the stored mode', async () => {
        mockGetSetting.mockResolvedValue('oldest');
        await useRelatedSortStore.getState().hydrate();
        expect(mockGetSetting).toHaveBeenCalledWith('related_articles_sort');
        expect(useRelatedSortStore.getState().mode).toBe('oldest');
        expect(useRelatedSortStore.getState().hydrated).toBe(true);
    });

    it('hydrate ignores an unrecognised stored value', async () => {
        mockGetSetting.mockResolvedValue('by-vibes');
        await useRelatedSortStore.getState().hydrate();
        expect(useRelatedSortStore.getState().mode).toBe('relevance');
    });

    it('hydrate reports a read failure and still marks itself hydrated', async () => {
        mockGetSetting.mockRejectedValue(new Error('db closed'));
        await useRelatedSortStore.getState().hydrate();
        expect(mockCaptureException).toHaveBeenCalled();
        expect(useRelatedSortStore.getState().hydrated).toBe(true);
        expect(useRelatedSortStore.getState().mode).toBe('relevance');
    });

    it('setMode applies immediately and persists in the background', () => {
        useRelatedSortStore.getState().setMode('newest');
        expect(useRelatedSortStore.getState().mode).toBe('newest');
        expect(mockSetSetting).toHaveBeenCalledWith('related_articles_sort', 'newest');
    });

    it('setMode reports a persist failure without losing the in-memory choice', async () => {
        mockSetSetting.mockRejectedValue(new Error('disk full'));
        useRelatedSortStore.getState().setMode('oldest');
        await Promise.resolve();
        await Promise.resolve();
        expect(useRelatedSortStore.getState().mode).toBe('oldest');
        expect(mockCaptureException).toHaveBeenCalled();
    });

    it('reset returns to the default and unhydrated (clearAllStores path)', async () => {
        mockGetSetting.mockResolvedValue('newest');
        await useRelatedSortStore.getState().hydrate();
        useRelatedSortStore.getState().reset();
        expect(useRelatedSortStore.getState().mode).toBe('relevance');
        expect(useRelatedSortStore.getState().hydrated).toBe(false);
    });
});
