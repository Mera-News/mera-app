// ──────────────────────────────────────────────────────────────────────────────
// Mock all seams BEFORE any imports
// ──────────────────────────────────────────────────────────────────────────────

const mockGetSetting = jest.fn((_k: string) => Promise.resolve(null as string | null));
const mockSetSetting = jest.fn((..._args: any[]) => Promise.resolve());

jest.mock('@/lib/database/services/setting-service', () => ({
    getSetting: (k: string) => mockGetSetting(k),
    setSetting: (k: string, v: string) => mockSetSetting(k, v),
}));

// The persisted translation cache (schema v49). Mocked at the service seam so
// this stays a unit test — the real module imports the native DB singleton.
const mockLoadTranslationCache = jest.fn(
    (..._args: unknown[]) => Promise.resolve(new Map<string, string>()),
);
const mockRememberTranslation = jest.fn((..._args: unknown[]) => {});
const mockSweepTranslationCache = jest.fn((..._args: unknown[]) => Promise.resolve(0));
jest.mock('@/lib/database/services/translation-cache-service', () => ({
    loadTranslationCache: (...args: unknown[]) => mockLoadTranslationCache(...args),
    rememberTranslation: (...args: unknown[]) => mockRememberTranslation(...args),
    sweepTranslationCache: (...args: unknown[]) => mockSweepTranslationCache(...args),
}));

const mockBumpTranslationEpoch = jest.fn();
jest.mock('@/lib/translation-queue', () => ({
    bumpTranslationEpoch: (...args: unknown[]) => mockBumpTranslationEpoch(...args),
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

// language-sync: mock the seam so the store stays decoupled from the
// account-service / user-store chain in this unit test.
const mockSyncAppLanguageToPersona = jest.fn((..._args: any[]) => Promise.resolve());
jest.mock('@/lib/language-sync', () => ({
    syncAppLanguageToPersona: (...args: any[]) => mockSyncAppLanguageToPersona(...args),
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
    clearTranslationFailures: jest.fn(),
    clearTranslationFailuresFor: jest.fn(),
}));

import { act, renderHook } from '@testing-library/react-native';
import { useAppLanguageStore, useAppLanguage } from '../app-language-store';

// ──────────────────────────────────────────────────────────────────────────────
// Reset helper
// ──────────────────────────────────────────────────────────────────────────────

const resetState = {
    appLanguage: 'en',
    cache: new Map<string, string>(),
    pending: new Set<string>(),
    cacheVersion: 0,
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

    // ── persona sync (one-way picker → DB) ─────────────────────────────────────

    it('setAppLanguage syncs the normalized language to the persona', async () => {
        await useAppLanguageStore.getState().setAppLanguage('fr');
        expect(mockSyncAppLanguageToPersona).toHaveBeenCalledWith('fr');
    });

    it('setAppLanguage syncs the normalized (not raw) code for legacy inputs', async () => {
        await useAppLanguageStore.getState().setAppLanguage('zh-CN');
        expect(mockSyncAppLanguageToPersona).toHaveBeenCalledWith('zh-Hans');
    });

    it('setAppLanguage still changes the local language when the sync throws', async () => {
        mockSyncAppLanguageToPersona.mockImplementationOnce(() => {
            throw new Error('sync boom');
        });
        await expect(
            useAppLanguageStore.getState().setAppLanguage('de'),
        ).resolves.toBeUndefined();
        expect(useAppLanguageStore.getState().appLanguage).toBe('de');
        expect(mockApplyLanguage).toHaveBeenCalledWith('de');
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

    // ── in-place mutation + cacheVersion (A4 perf contract) ────────────────────

    it('cacheTranslation mutates the cache in place (stable Map reference)', () => {
        const before = useAppLanguageStore.getState().cache;
        useAppLanguageStore.getState().cacheTranslation('hello', 'bonjour');
        const after = useAppLanguageStore.getState().cache;
        // Reference must be stable — consumers subscribe per-key, not by Map identity.
        expect(after).toBe(before);
        expect(after.get('hello')).toBe('bonjour');
    });

    it('cacheTranslation bumps cacheVersion exactly once per call', () => {
        const v0 = useAppLanguageStore.getState().cacheVersion;
        useAppLanguageStore.getState().cacheTranslation('a', '1');
        expect(useAppLanguageStore.getState().cacheVersion).toBe(v0 + 1);
        useAppLanguageStore.getState().cacheTranslation('b', '2');
        expect(useAppLanguageStore.getState().cacheVersion).toBe(v0 + 2);
    });

    it('addPending and removePending mutate pending in place and bump cacheVersion', () => {
        const pendingRef = useAppLanguageStore.getState().pending;
        const v0 = useAppLanguageStore.getState().cacheVersion;

        useAppLanguageStore.getState().addPending('hello');
        expect(useAppLanguageStore.getState().pending).toBe(pendingRef); // in place
        expect(useAppLanguageStore.getState().pending.has('hello')).toBe(true);
        expect(useAppLanguageStore.getState().cacheVersion).toBe(v0 + 1);

        useAppLanguageStore.getState().removePending('hello');
        expect(useAppLanguageStore.getState().pending).toBe(pendingRef); // in place
        expect(useAppLanguageStore.getState().pending.has('hello')).toBe(false);
        expect(useAppLanguageStore.getState().cacheVersion).toBe(v0 + 2);
    });

    it('per-key selector updates only for the key that landed', () => {
        // Two subscribers, each keyed to a different text.
        const hookA = renderHook(() => useAppLanguageStore((s) => s.cache.get('a')));
        const hookB = renderHook(() => useAppLanguageStore((s) => s.cache.get('b')));

        expect(hookA.result.current).toBeUndefined();
        expect(hookB.result.current).toBeUndefined();

        act(() => {
            useAppLanguageStore.getState().cacheTranslation('a', 'translated-a');
        });

        // Only 'a' resolves; 'b' stays undefined (Object.is → no value change).
        expect(hookA.result.current).toBe('translated-a');
        expect(hookB.result.current).toBeUndefined();

        act(() => {
            useAppLanguageStore.getState().cacheTranslation('b', 'translated-b');
        });

        expect(hookA.result.current).toBe('translated-a');
        expect(hookB.result.current).toBe('translated-b');
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

    it('hydrateFromDb restores stored language', async () => {
        mockGetSetting.mockResolvedValueOnce('fr'); // app_language

        await useAppLanguageStore.getState().hydrateFromDb();

        expect(useAppLanguageStore.getState().appLanguage).toBe('fr');
    });

    it('hydrateFromDb uses device locale when stored value is null', async () => {
        mockGetLocales.mockReturnValueOnce([{ languageCode: 'de', regionCode: 'DE', languageTag: 'de-DE' }]);
        mockGetSetting.mockResolvedValueOnce(null); // app_language not stored

        await useAppLanguageStore.getState().hydrateFromDb();

        expect(useAppLanguageStore.getState().appLanguage).toBe('de');
    });

    it('hydrateFromDb falls back to "en" when device locale is unsupported', async () => {
        mockGetLocales.mockReturnValueOnce([{ languageCode: 'xx', regionCode: 'XX', languageTag: 'xx-XX' }]);
        mockGetSetting.mockResolvedValueOnce(null);

        await useAppLanguageStore.getState().hydrateFromDb();

        expect(useAppLanguageStore.getState().appLanguage).toBe('en');
    });

    it('hydrateFromDb normalizes legacy code and re-persists to DB', async () => {
        // stored 'zh-CN' is a legacy code → normalizes to 'zh-Hans' → different from stored → re-persist
        mockGetSetting.mockResolvedValueOnce('zh-CN'); // legacy stored value

        await useAppLanguageStore.getState().hydrateFromDb();

        expect(useAppLanguageStore.getState().appLanguage).toBe('zh-Hans');
        expect(mockSetSetting).toHaveBeenCalledWith('app_language', 'zh-Hans');
    });

    it('hydrateFromDb does NOT re-persist when normalized code equals stored code', async () => {
        mockGetSetting.mockResolvedValueOnce('fr'); // already normalized

        await useAppLanguageStore.getState().hydrateFromDb();

        expect(mockSetSetting).not.toHaveBeenCalled();
    });

    it('hydrateFromDb normalizes pt-BR stored value to pt and re-persists', async () => {
        mockGetSetting.mockResolvedValueOnce('pt-BR');

        await useAppLanguageStore.getState().hydrateFromDb();

        expect(useAppLanguageStore.getState().appLanguage).toBe('pt');
        expect(mockSetSetting).toHaveBeenCalledWith('app_language', 'pt');
    });

    it('hydrateFromDb device locale falls back to "en" when locales array is empty', async () => {
        mockGetLocales.mockReturnValueOnce([]);
        mockGetSetting.mockResolvedValueOnce(null);

        await useAppLanguageStore.getState().hydrateFromDb();

        expect(useAppLanguageStore.getState().appLanguage).toBe('en');
    });

    // ── persisted translation cache (schema v49) ──────────────────────────────
    //
    // The cache used to be in-memory only: every translation was lost on
    // restart AND wiped wholesale on a language switch, so a non-English reader
    // paid the full serial native-call cost on every cold start.

    it('cacheTranslation persists the pair under the CURRENT app language', () => {
        useAppLanguageStore.setState({ appLanguage: 'de' });

        act(() => {
            useAppLanguageStore.getState().cacheTranslation('Breaking news', 'Eilmeldung');
        });

        expect(mockRememberTranslation).toHaveBeenCalledWith(
            'Breaking news',
            'de',
            'Eilmeldung',
        );
    });

    it('cacheTranslation still updates the in-memory cache when persistence throws', () => {
        mockRememberTranslation.mockImplementationOnce(() => {
            throw new Error('disk full');
        });
        useAppLanguageStore.setState({ appLanguage: 'de' });

        act(() => {
            useAppLanguageStore.getState().cacheTranslation('Breaking news', 'Eilmeldung');
        });

        expect(useAppLanguageStore.getState().cache.get('Breaking news')).toBe('Eilmeldung');
    });

    it('hydrateTranslationCache loads the persisted rows into the cache', async () => {
        useAppLanguageStore.setState({ appLanguage: 'de' });
        mockLoadTranslationCache.mockResolvedValueOnce(
            new Map([['Breaking news', 'Eilmeldung']]),
        );

        await act(async () => {
            await useAppLanguageStore.getState().hydrateTranslationCache('de');
        });

        expect(useAppLanguageStore.getState().cache.get('Breaking news')).toBe('Eilmeldung');
    });

    it('hydrateTranslationCache never queries for English', async () => {
        await useAppLanguageStore.getState().hydrateTranslationCache('en');
        expect(mockLoadTranslationCache).not.toHaveBeenCalled();
    });

    it('hydrateTranslationCache discards a load whose language the user already left', async () => {
        useAppLanguageStore.setState({ appLanguage: 'fr' });
        mockLoadTranslationCache.mockResolvedValueOnce(
            new Map([['Breaking news', 'Eilmeldung']]),
        );

        // Load was started for 'de' but the store is now on 'fr' — applying it
        // would fill the cache with German for a French reader, and every keyed
        // read would silently hit it.
        await act(async () => {
            await useAppLanguageStore.getState().hydrateTranslationCache('de');
        });

        expect(useAppLanguageStore.getState().cache.has('Breaking news')).toBe(false);
    });

    it('hydrateTranslationCache keeps translations that landed while the load was in flight', async () => {
        useAppLanguageStore.setState({ appLanguage: 'de' });
        useAppLanguageStore.getState().cache.set('Fresh headline', 'Frische Schlagzeile');
        mockLoadTranslationCache.mockResolvedValueOnce(
            new Map([['Breaking news', 'Eilmeldung']]),
        );

        await act(async () => {
            await useAppLanguageStore.getState().hydrateTranslationCache('de');
        });

        const cache = useAppLanguageStore.getState().cache;
        expect(cache.get('Breaking news')).toBe('Eilmeldung');
        expect(cache.get('Fresh headline')).toBe('Frische Schlagzeile');
    });

    it('setAppLanguage retires the native calls queued for the language being left', async () => {
        await act(async () => {
            await useAppLanguageStore.getState().setAppLanguage('fr');
        });
        expect(mockBumpTranslationEpoch).toHaveBeenCalledWith('language:fr');
    });

    it('setAppLanguage refills the cache from disk for the language being adopted', async () => {
        mockLoadTranslationCache.mockResolvedValueOnce(
            new Map([['Breaking news', 'Dernières nouvelles']]),
        );

        await act(async () => {
            await useAppLanguageStore.getState().setAppLanguage('fr');
        });
        // The refill is fire-and-forget; let its microtasks settle.
        await act(async () => {
            await Promise.resolve();
        });

        expect(mockLoadTranslationCache).toHaveBeenCalledWith('fr');
        expect(useAppLanguageStore.getState().cache.get('Breaking news')).toBe(
            'Dernières nouvelles',
        );
    });

    it('hydrateFromDb loads the cache and kicks off the TTL sweep', async () => {
        mockGetSetting.mockResolvedValueOnce('de');
        mockLoadTranslationCache.mockResolvedValueOnce(
            new Map([['Breaking news', 'Eilmeldung']]),
        );

        await useAppLanguageStore.getState().hydrateFromDb();

        expect(useAppLanguageStore.getState().cache.get('Breaking news')).toBe('Eilmeldung');
        expect(mockSweepTranslationCache).toHaveBeenCalled();
    });

    it('hydrateFromDb still resolves when the cache load fails', async () => {
        mockGetSetting.mockResolvedValueOnce('de');
        mockLoadTranslationCache.mockResolvedValueOnce(new Map());

        await expect(useAppLanguageStore.getState().hydrateFromDb()).resolves.toBeUndefined();
        expect(useAppLanguageStore.getState().appLanguage).toBe('de');
    });

    // ── selector hooks ────────────────────────────────────────────────────────

    it('useAppLanguage returns current appLanguage value', () => {
        useAppLanguageStore.setState({ appLanguage: 'de' });
        const { result } = renderHook(() => useAppLanguage());
        expect(result.current).toBe('de');
    });
});
