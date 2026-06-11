// ──────────────────────────────────────────────────────────────────────────────
// Mock all seams BEFORE any imports
// ──────────────────────────────────────────────────────────────────────────────

const mockGetSetting = jest.fn((_k: string) => Promise.resolve(null as string | null));
const mockSetSetting = jest.fn((..._args: any[]) => Promise.resolve());

jest.mock('@/lib/database/services/setting-service', () => ({
    getSetting: (k: string) => mockGetSetting(k),
    setSetting: (k: string, v: string) => mockSetSetting(k, v),
}));

const mockApplyLanguage = jest.fn();
jest.mock('@/lib/i18n', () => ({
    applyLanguage: (lang: string) => mockApplyLanguage(lang),
}));

// expo-localization is mocked globally in jest.setup.js → returns [{languageTag:'en-US'}]
// We re-mock here to allow per-test overrides
const mockGetLocales = jest.fn(() => [{ languageCode: 'en', regionCode: 'US', languageTag: 'en-US' }]);
jest.mock('expo-localization', () => ({
    getLocales: () => mockGetLocales(),
}));

// translation-service: mock only the SUPPORTED_LANGUAGES export
jest.mock('@/lib/translation-service', () => ({
    SUPPORTED_LANGUAGES: [
        { code: 'en', name: 'English', native: 'English' },
        { code: 'fr', name: 'French', native: 'Français' },
        { code: 'de', name: 'German', native: 'Deutsch' },
        { code: 'ar', name: 'Arabic', native: 'العربية' },
        { code: 'zh-Hans', name: 'Chinese (Simplified)', native: '简体中文' },
        { code: 'zh-Hant', name: 'Chinese (Traditional)', native: '繁體中文' },
        { code: 'pt', name: 'Portuguese', native: 'Português' },
    ],
}));

import { renderHook } from '@testing-library/react-native';
import { useAppLanguageStore, useAppLanguage, useShowOriginal } from '../app-language-store';

// ──────────────────────────────────────────────────────────────────────────────
// Reset helper
// ──────────────────────────────────────────────────────────────────────────────

const resetState = {
    appLanguage: 'en',
    showOriginal: false,
    cache: new Map<string, string>(),
    pending: new Set<string>(),
};

describe('useAppLanguageStore', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        // Use partial setState (no replace flag) to preserve action functions
        useAppLanguageStore.setState({ ...resetState, cache: new Map(), pending: new Set() });
    });

    // ── initial state ─────────────────────────────────────────────────────────

    it('starts with default English and empty cache/pending', () => {
        const state = useAppLanguageStore.getState();
        expect(state.appLanguage).toBe('en');
        expect(state.showOriginal).toBe(false);
        expect(state.cache.size).toBe(0);
        expect(state.pending.size).toBe(0);
    });

    // ── setAppLanguage ────────────────────────────────────────────────────────

    it('setAppLanguage updates language, clears cache/pending, calls applyLanguage, persists to DB', async () => {
        useAppLanguageStore.setState({
            cache: new Map([['hello', 'bonjour']]),
            pending: new Set(['world']),
        });

        await useAppLanguageStore.getState().setAppLanguage('fr');

        const state = useAppLanguageStore.getState();
        expect(state.appLanguage).toBe('fr');
        expect(state.cache.size).toBe(0);
        expect(state.pending.size).toBe(0);
        expect(mockApplyLanguage).toHaveBeenCalledWith('fr');
        expect(mockSetSetting).toHaveBeenCalledWith('app_language', 'fr');
    });

    it('setAppLanguage normalizes legacy code zh-CN → zh-Hans', async () => {
        await useAppLanguageStore.getState().setAppLanguage('zh-CN');
        expect(useAppLanguageStore.getState().appLanguage).toBe('zh-Hans');
        expect(mockApplyLanguage).toHaveBeenCalledWith('zh-Hans');
    });

    it('setAppLanguage normalizes legacy code zh-TW → zh-Hant', async () => {
        await useAppLanguageStore.getState().setAppLanguage('zh-TW');
        expect(useAppLanguageStore.getState().appLanguage).toBe('zh-Hant');
    });

    it('setAppLanguage normalizes legacy code pt-BR → pt', async () => {
        await useAppLanguageStore.getState().setAppLanguage('pt-BR');
        expect(useAppLanguageStore.getState().appLanguage).toBe('pt');
    });

    it('setAppLanguage falls back to "en" for unknown code', async () => {
        await useAppLanguageStore.getState().setAppLanguage('xx-UNKNOWN');
        expect(useAppLanguageStore.getState().appLanguage).toBe('en');
        expect(mockApplyLanguage).toHaveBeenCalledWith('en');
    });

    it('setAppLanguage uses prefix match when full tag not supported', async () => {
        // "fr-CA" should match "fr" which is supported
        await useAppLanguageStore.getState().setAppLanguage('fr-CA');
        expect(useAppLanguageStore.getState().appLanguage).toBe('fr');
    });

    it('setAppLanguage persists normalized value to DB', async () => {
        await useAppLanguageStore.getState().setAppLanguage('de');
        expect(mockSetSetting).toHaveBeenCalledWith('app_language', 'de');
    });

    // ── setShowOriginal ───────────────────────────────────────────────────────

    it('setShowOriginal true persists "true" to DB', async () => {
        await useAppLanguageStore.getState().setShowOriginal(true);

        expect(useAppLanguageStore.getState().showOriginal).toBe(true);
        expect(mockSetSetting).toHaveBeenCalledWith('show_original', 'true');
    });

    it('setShowOriginal false persists "false" to DB', async () => {
        await useAppLanguageStore.getState().setShowOriginal(false);

        expect(useAppLanguageStore.getState().showOriginal).toBe(false);
        expect(mockSetSetting).toHaveBeenCalledWith('show_original', 'false');
    });

    // ── cacheTranslation ──────────────────────────────────────────────────────

    it('cacheTranslation stores translation and removes from pending', () => {
        useAppLanguageStore.setState({ pending: new Set(['hello']) });
        useAppLanguageStore.getState().cacheTranslation('hello', 'bonjour');

        const state = useAppLanguageStore.getState();
        expect(state.cache.get('hello')).toBe('bonjour');
        expect(state.pending.has('hello')).toBe(false);
    });

    it('cacheTranslation accumulates multiple translations', () => {
        useAppLanguageStore.getState().cacheTranslation('a', '1');
        useAppLanguageStore.getState().cacheTranslation('b', '2');
        const state = useAppLanguageStore.getState();
        expect(state.cache.get('a')).toBe('1');
        expect(state.cache.get('b')).toBe('2');
    });

    it('cacheTranslation overwrites existing translation', () => {
        useAppLanguageStore.getState().cacheTranslation('hello', 'bonjour');
        useAppLanguageStore.getState().cacheTranslation('hello', 'salut');
        expect(useAppLanguageStore.getState().cache.get('hello')).toBe('salut');
    });

    it('cacheTranslation handles key not in pending gracefully', () => {
        useAppLanguageStore.setState({ pending: new Set<string>() });
        expect(() => {
            useAppLanguageStore.getState().cacheTranslation('not-pending', 'translated');
        }).not.toThrow();
        expect(useAppLanguageStore.getState().cache.get('not-pending')).toBe('translated');
    });

    // ── addPending / removePending ────────────────────────────────────────────

    it('addPending adds text to pending set', () => {
        useAppLanguageStore.getState().addPending('hello');
        useAppLanguageStore.getState().addPending('world');
        const state = useAppLanguageStore.getState();
        expect(state.pending.has('hello')).toBe(true);
        expect(state.pending.has('world')).toBe(true);
    });

    it('addPending is idempotent (no duplicates in Set)', () => {
        useAppLanguageStore.getState().addPending('hello');
        useAppLanguageStore.getState().addPending('hello');
        expect(useAppLanguageStore.getState().pending.size).toBe(1);
    });

    it('removePending removes text from pending set', () => {
        useAppLanguageStore.setState({ pending: new Set(['hello', 'world']) });
        useAppLanguageStore.getState().removePending('hello');
        const state = useAppLanguageStore.getState();
        expect(state.pending.has('hello')).toBe(false);
        expect(state.pending.has('world')).toBe(true);
    });

    it('removePending is a no-op for missing key', () => {
        useAppLanguageStore.setState({ pending: new Set(['hello']) });
        expect(() => useAppLanguageStore.getState().removePending('nonexistent')).not.toThrow();
        expect(useAppLanguageStore.getState().pending.size).toBe(1);
    });

    // ── clearCache ────────────────────────────────────────────────────────────

    it('clearCache resets cache and pending to empty', () => {
        useAppLanguageStore.setState({
            cache: new Map([['hello', 'bonjour']]),
            pending: new Set(['world']),
        });
        useAppLanguageStore.getState().clearCache();
        const state = useAppLanguageStore.getState();
        expect(state.cache.size).toBe(0);
        expect(state.pending.size).toBe(0);
    });

    // ── hydrateFromDb ─────────────────────────────────────────────────────────

    it('hydrateFromDb restores stored language and showOriginal', async () => {
        mockGetSetting
            .mockResolvedValueOnce('fr') // app_language
            .mockResolvedValueOnce('true'); // show_original

        await useAppLanguageStore.getState().hydrateFromDb();

        const state = useAppLanguageStore.getState();
        expect(state.appLanguage).toBe('fr');
        expect(state.showOriginal).toBe(true);
    });

    it('hydrateFromDb uses device locale when stored value is null', async () => {
        mockGetLocales.mockReturnValueOnce([{ languageCode: 'de', regionCode: 'DE', languageTag: 'de-DE' }]);
        mockGetSetting
            .mockResolvedValueOnce(null) // app_language not stored
            .mockResolvedValueOnce(null); // show_original not stored

        await useAppLanguageStore.getState().hydrateFromDb();

        expect(useAppLanguageStore.getState().appLanguage).toBe('de');
    });

    it('hydrateFromDb falls back to "en" when device locale is unsupported', async () => {
        mockGetLocales.mockReturnValueOnce([{ languageCode: 'xx', regionCode: 'XX', languageTag: 'xx-XX' }]);
        mockGetSetting
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(null);

        await useAppLanguageStore.getState().hydrateFromDb();

        expect(useAppLanguageStore.getState().appLanguage).toBe('en');
    });

    it('hydrateFromDb sets showOriginal=false when stored value is "false"', async () => {
        useAppLanguageStore.setState({ showOriginal: true });
        mockGetSetting
            .mockResolvedValueOnce('en')
            .mockResolvedValueOnce('false');

        await useAppLanguageStore.getState().hydrateFromDb();

        expect(useAppLanguageStore.getState().showOriginal).toBe(false);
    });

    it('hydrateFromDb normalizes legacy code and re-persists to DB', async () => {
        // stored 'zh-CN' is a legacy code → normalizes to 'zh-Hans' → different from stored → re-persist
        mockGetSetting
            .mockResolvedValueOnce('zh-CN') // legacy stored value
            .mockResolvedValueOnce(null);

        await useAppLanguageStore.getState().hydrateFromDb();

        expect(useAppLanguageStore.getState().appLanguage).toBe('zh-Hans');
        expect(mockSetSetting).toHaveBeenCalledWith('app_language', 'zh-Hans');
    });

    it('hydrateFromDb does NOT re-persist when normalized code equals stored code', async () => {
        mockGetSetting
            .mockResolvedValueOnce('fr') // already normalized
            .mockResolvedValueOnce(null);

        await useAppLanguageStore.getState().hydrateFromDb();

        expect(mockSetSetting).not.toHaveBeenCalled();
    });

    it('hydrateFromDb normalizes pt-BR stored value to pt and re-persists', async () => {
        mockGetSetting
            .mockResolvedValueOnce('pt-BR')
            .mockResolvedValueOnce(null);

        await useAppLanguageStore.getState().hydrateFromDb();

        expect(useAppLanguageStore.getState().appLanguage).toBe('pt');
        expect(mockSetSetting).toHaveBeenCalledWith('app_language', 'pt');
    });

    it('hydrateFromDb device locale falls back to "en" when locales array is empty', async () => {
        mockGetLocales.mockReturnValueOnce([]);
        mockGetSetting
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(null);

        await useAppLanguageStore.getState().hydrateFromDb();

        expect(useAppLanguageStore.getState().appLanguage).toBe('en');
    });

    // ── selector hooks ────────────────────────────────────────────────────────

    it('useAppLanguage returns current appLanguage value', () => {
        useAppLanguageStore.setState({ appLanguage: 'de' });
        const { result } = renderHook(() => useAppLanguage());
        expect(result.current).toBe('de');
    });

    it('useShowOriginal returns current showOriginal value', () => {
        useAppLanguageStore.setState({ showOriginal: true });
        const { result } = renderHook(() => useShowOriginal());
        expect(result.current).toBe(true);
    });

    it('useShowOriginal returns false by default', () => {
        useAppLanguageStore.setState({ showOriginal: false });
        const { result } = renderHook(() => useShowOriginal());
        expect(result.current).toBe(false);
    });
});
