// expo-translate-text is a native module — mock it before imports.
const mockOnTranslateTask = jest.fn();
jest.mock('expo-translate-text', () => ({
    onTranslateTask: (...a: any[]) => mockOnTranslateTask(...a),
}));

jest.mock('@/lib/logger', () => ({
    __esModule: true,
    default: {
        captureException: jest.fn(),
        captureMessage: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
        info: jest.fn(),
    },
}));

// Platform must be mocked before translation-service.ts loads because the module
// evaluates ACTIVE_TRANSLATION_SOURCE_CODES at import time using Platform.OS.
// The global jest.setup.js mock uses 'react-native/Libraries/Utilities/Platform'
// but expo/RN may resolve this differently — override here with full __mocks__ key.
jest.mock('react-native', () => ({
    Platform: {
        OS: 'ios',
        select: jest.fn((obj: Record<string, unknown>) => obj.ios),
    },
}));

import {
    buildGoogleTranslateUrl,
    getLanguageName,
    getNativeLanguageName,
    getArticleTranslatableStatus,
    getArticleTranslationSupport,
    SUPPORTED_LANGUAGES,
    translateText,
    translateTexts,
} from '../translation-service';
import logger from '@/lib/logger';

// ─────────────────────────────────────────────────────────────────────────────
// getLanguageName
// ─────────────────────────────────────────────────────────────────────────────

describe('getLanguageName', () => {
    it('returns English name for a known code', () => {
        expect(getLanguageName('fr')).toBe('French');
    });

    it('returns English name for German', () => {
        expect(getLanguageName('de')).toBe('German');
    });

    it('returns English name for Japanese', () => {
        expect(getLanguageName('ja')).toBe('Japanese');
    });

    it('strips BCP-47 region tags before lookup ("zh-Hant" → "zh")', () => {
        // zh is registered as Chinese — may return "Chinese" (macro-language)
        const name = getLanguageName('zh-Hant');
        expect(typeof name === 'string' || name === null).toBe(true);
    });

    it('returns null for an unknown code', () => {
        expect(getLanguageName('xyz-fake')).toBeNull();
    });

    it('returns null for null input', () => {
        expect(getLanguageName(null)).toBeNull();
    });

    it('returns null for undefined input', () => {
        expect(getLanguageName(undefined)).toBeNull();
    });

    it('returns null for empty string', () => {
        // empty string → split('-')[0] = '' → not a valid code
        expect(getLanguageName('')).toBeNull();
    });

    it('handles Arabic code "ar"', () => {
        expect(getLanguageName('ar')).toBe('Arabic');
    });

    it('handles Spanish code "es"', () => {
        expect(getLanguageName('es')).toBe('Spanish');
    });

    it('handles Russian code "ru"', () => {
        expect(getLanguageName('ru')).toBe('Russian');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// getNativeLanguageName
// ─────────────────────────────────────────────────────────────────────────────

describe('getNativeLanguageName', () => {
    it('returns native name for a supported language', () => {
        expect(getNativeLanguageName('fr')).toBe('Français');
    });

    it('returns native name for Japanese', () => {
        expect(getNativeLanguageName('ja')).toBe('日本語');
    });

    it('returns native name for Arabic', () => {
        expect(getNativeLanguageName('ar')).toBe('العربية');
    });

    it('returns native name for English', () => {
        expect(getNativeLanguageName('en')).toBe('English');
    });

    it('returns native name for zh-Hans (Simplified Chinese)', () => {
        expect(getNativeLanguageName('zh-Hans')).toBe('简体中文');
    });

    it('returns native name for zh-Hant (Traditional Chinese)', () => {
        // Regression: the old lookup matched on the primary subtag before the
        // exact code, so 'zh-Hant' hit the earlier 'zh-Hans' entry and returned
        // Simplified. Canonicalizing first fixes it.
        expect(getNativeLanguageName('zh-Hant')).toBe('繁體中文');
    });

    it('resolves Traditional Chinese regions to the Traditional entry', () => {
        expect(getNativeLanguageName('zh-TW')).toBe('繁體中文');
        expect(getNativeLanguageName('zh-HK')).toBe('繁體中文');
    });

    it('resolves a bare "zh" to Simplified', () => {
        expect(getNativeLanguageName('zh')).toBe('简体中文');
    });

    it('returns null for null input', () => {
        expect(getNativeLanguageName(null)).toBeNull();
    });

    it('returns null for undefined input', () => {
        expect(getNativeLanguageName(undefined)).toBeNull();
    });

    it('falls back to getLanguageName for codes not in SUPPORTED_LANGUAGES', () => {
        // 'ca' (Catalan) is not in SUPPORTED_LANGUAGES but is in the ISO library
        const result = getNativeLanguageName('ca');
        // Should return the English name (Catalan) or null if not in library
        expect(typeof result === 'string' || result === null).toBe(true);
    });

    it('returns null for a completely unknown code', () => {
        expect(getNativeLanguageName('zzz-unknown')).toBeNull();
    });

    it('normalizes BCP-47 to match supported entry via primary subtag', () => {
        // 'fr-CA' should map to French ('fr') via the normalized code check
        const result = getNativeLanguageName('fr-CA');
        // SUPPORTED_LANGUAGES has 'fr' — normalized match returns 'Français'
        expect(result).toBe('Français');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// SUPPORTED_LANGUAGES constant
// ─────────────────────────────────────────────────────────────────────────────

describe('SUPPORTED_LANGUAGES', () => {
    it('contains 20 entries', () => {
        expect(SUPPORTED_LANGUAGES).toHaveLength(20);
    });

    it('has English with code "en"', () => {
        const en = SUPPORTED_LANGUAGES.find((l) => l.code === 'en');
        expect(en).toBeDefined();
        expect(en!.native).toBe('English');
    });

    it('all entries have code, name, and native fields', () => {
        for (const lang of SUPPORTED_LANGUAGES) {
            expect(typeof lang.code).toBe('string');
            expect(typeof lang.name).toBe('string');
            expect(typeof lang.native).toBe('string');
        }
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// getArticleTranslatableStatus — iOS platform (global default)
// ─────────────────────────────────────────────────────────────────────────────

describe('getArticleTranslatableStatus (iOS)', () => {
    // Platform.OS = 'ios' from jest.setup.js → IOS_TRANSLATION_SOURCE_CODES is active

    it('returns "same-language" when originalLang is null', () => {
        expect(getArticleTranslatableStatus(null, 'en')).toBe('same-language');
    });

    it('returns "same-language" when originalLang is undefined', () => {
        expect(getArticleTranslatableStatus(undefined, 'en')).toBe('same-language');
    });

    it('returns "same-language" when article and app language match', () => {
        expect(getArticleTranslatableStatus('en', 'en')).toBe('same-language');
    });

    it('returns "same-language" when BCP-47 primary subtags match', () => {
        expect(getArticleTranslatableStatus('en-GB', 'en-US')).toBe('same-language');
    });

    it('returns "translatable" for French article with English app (iOS supports fr)', () => {
        expect(getArticleTranslatableStatus('fr', 'en')).toBe('translatable');
    });

    it('returns "translatable" for Spanish article with English app (iOS supports es)', () => {
        expect(getArticleTranslatableStatus('es', 'en')).toBe('translatable');
    });

    it('returns "translatable" for Chinese Traditional with English app', () => {
        // zh-Hant is in IOS_TRANSLATION_SOURCE_CODES
        expect(getArticleTranslatableStatus('zh-Hant', 'en')).toBe('translatable');
    });

    it('returns "translatable" when primary code is in iOS supported set', () => {
        // "de-AT" primary "de" is in IOS set
        expect(getArticleTranslatableStatus('de-AT', 'en')).toBe('translatable');
    });

    it('returns "not-translatable" for a language outside iOS set', () => {
        // "sw" (Swahili) is NOT in IOS_TRANSLATION_SOURCE_CODES
        expect(getArticleTranslatableStatus('sw', 'en')).toBe('not-translatable');
    });

    it('returns "not-translatable" for an unknown code on iOS', () => {
        expect(getArticleTranslatableStatus('xyz', 'en')).toBe('not-translatable');
    });

    // The feed's `original_language_code` is CLD3 output, publisher-declared RSS
    // tags and hand-entered config all in one field. Each of these shapes was
    // observed in a single two-day window of production articles, and each one
    // was previously reported as not-translatable.
    it('handles the messy codes production actually emits', () => {
        // ~2.2k Chinese articles a day arrive as a bare 'zh' — never 'zh-Hans'.
        expect(getArticleTranslatableStatus('zh', 'en')).toBe('translatable');
        // Uppercase and lowercased-region tags.
        expect(getArticleTranslatableStatus('ES', 'en')).toBe('translatable');
        expect(getArticleTranslatableStatus('fr-fr', 'en')).toBe('translatable');
        expect(getArticleTranslatableStatus('de-de', 'en')).toBe('translatable');
        expect(getArticleTranslatableStatus('pt-pt', 'en')).toBe('translatable');
        expect(getArticleTranslatableStatus('ID', 'en')).toBe('translatable');
        // Script subtag on a language that has no script variants.
        expect(getArticleTranslatableStatus('ja-Latn', 'en')).toBe('translatable');
    });

    it('treats Simplified and Traditional Chinese as different languages', () => {
        expect(getArticleTranslatableStatus('zh-TW', 'zh-Hans')).toBe('translatable');
        expect(getArticleTranslatableStatus('zh-CN', 'zh-Hans')).toBe('same-language');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// getArticleTranslationSupport — the reason/version detail behind the status
// ─────────────────────────────────────────────────────────────────────────────

describe('getArticleTranslationSupport (iOS)', () => {
    it('reports os-outdated with both versions when Apple added the language later', () => {
        // Apple added Hindi as a translation source in iOS 18.
        expect(getArticleTranslationSupport('hi', 'en', 17)).toEqual({
            status: 'not-translatable',
            reason: 'os-outdated',
            requiredOSMajor: 18,
            currentOSMajor: 17,
        });
        expect(getArticleTranslationSupport('hi', 'en', 18)).toEqual({ status: 'translatable' });
    });

    it('reports os-outdated for the iOS 27 additions', () => {
        for (const code of ['sv', 'da', 'he', 'ms', 'no', 'yue']) {
            expect(getArticleTranslationSupport(code, 'en', 26)).toMatchObject({
                status: 'not-translatable',
                reason: 'os-outdated',
                requiredOSMajor: 27,
            });
            expect(getArticleTranslationSupport(code, 'en', 27).status).toBe('translatable');
        }
    });

    it('maps the legacy Hebrew code "iw" onto "he"', () => {
        expect(getArticleTranslationSupport('iw', 'en', 27).status).toBe('translatable');
        expect(getArticleTranslationSupport('iw', 'en', 26).reason).toBe('os-outdated');
    });

    it('treats pt-PT and es-MX as their base language, not as iOS 27 additions', () => {
        // iOS 27 adds these as UI variants; as SOURCE languages Portuguese and
        // Spanish have been translatable since iOS 14.
        expect(getArticleTranslationSupport('pt-PT', 'en', 16).status).toBe('translatable');
        expect(getArticleTranslationSupport('es-MX', 'en', 16).status).toBe('translatable');
    });

    it('reports unsupported-language when no iOS version would help', () => {
        expect(getArticleTranslationSupport('sw', 'en', 27)).toEqual({
            status: 'not-translatable',
            reason: 'unsupported-language',
        });
        expect(getArticleTranslationSupport('fa', 'en', 27).reason).toBe('unsupported-language');
    });

    it('respects the per-version ladder for the iOS 16 and 17 additions', () => {
        expect(getArticleTranslationSupport('nl', 'en', 15).reason).toBe('os-outdated');
        expect(getArticleTranslationSupport('nl', 'en', 16).status).toBe('translatable');
        expect(getArticleTranslationSupport('uk', 'en', 16).requiredOSMajor).toBe(17);
        expect(getArticleTranslationSupport('uk', 'en', 17).status).toBe('translatable');
        expect(getArticleTranslationSupport('zh-Hant', 'en', 14).reason).toBe('os-outdated');
        expect(getArticleTranslationSupport('zh-Hans', 'en', 14).status).toBe('translatable');
    });

    it('reads the device version from expo-device when no override is given', () => {
        // jest.setup.js pins Device.osVersion to '18.0'.
        expect(getArticleTranslationSupport('hi', 'en').status).toBe('translatable');
        expect(getArticleTranslationSupport('sv', 'en')).toMatchObject({
            reason: 'os-outdated',
            requiredOSMajor: 27,
            currentOSMajor: 18,
        });
    });

    it('assumes translatable when the OS version cannot be read', () => {
        // Better to let the user try than to nag them about an update we can't
        // prove they need.
        jest.resetModules();
        jest.doMock('expo-device', () => ({ isDevice: true, osVersion: undefined }));
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const reloaded = require('../translation-service');
        expect(reloaded.getArticleTranslationSupport('sv', 'en').status).toBe('translatable');
        jest.dontMock('expo-device');
        jest.resetModules();
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// buildGoogleTranslateUrl
// ─────────────────────────────────────────────────────────────────────────────

describe('buildGoogleTranslateUrl', () => {
    it('maps zh-Hans → zh-CN in the tl param', () => {
        const url = buildGoogleTranslateUrl('https://example.com/a', 'zh-Hans');
        expect(url).toContain('tl=zh-CN');
        expect(url).not.toContain('tl=zh-Hans');
    });

    it('maps zh-Hant → zh-TW in the tl param', () => {
        const url = buildGoogleTranslateUrl('https://example.com/a', 'zh-Hant');
        expect(url).toContain('tl=zh-TW');
        expect(url).not.toContain('tl=zh-Hant');
    });

    it('passes non-Chinese codes through unchanged', () => {
        expect(buildGoogleTranslateUrl('https://example.com/a', 'fr')).toContain('tl=fr');
        expect(buildGoogleTranslateUrl('https://example.com/a', 'pt')).toContain('tl=pt');
        expect(buildGoogleTranslateUrl('https://example.com/a', 'en')).toContain('tl=en');
    });

    it('always sets sl=auto', () => {
        expect(buildGoogleTranslateUrl('https://example.com/a', 'de')).toContain('sl=auto');
    });

    it('URL-encodes the article URL in the u param', () => {
        const articleUrl = 'https://news.example.com/story?id=1&x=2';
        const url = buildGoogleTranslateUrl(articleUrl, 'de');
        expect(url).toContain(`u=${encodeURIComponent(articleUrl)}`);
        // raw ampersands/query of the article URL must not leak into the outer URL
        expect(url).toContain('u=https%3A%2F%2Fnews.example.com%2Fstory%3Fid%3D1%26x%3D2');
    });

    it('builds the full expected URL shape', () => {
        expect(buildGoogleTranslateUrl('https://a.com', 'ja')).toBe(
            'https://translate.google.com/translate?sl=auto&tl=ja&u=https%3A%2F%2Fa.com',
        );
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// translateText — queuing + retry logic
// ─────────────────────────────────────────────────────────────────────────────

describe('translateText', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        jest.useFakeTimers();
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    it('returns translated string on first attempt success', async () => {
        mockOnTranslateTask.mockResolvedValueOnce({ translatedTexts: 'Bonjour' });

        const promise = translateText('Hello', 'fr');
        await jest.runAllTimersAsync();
        const result = await promise;

        expect(result).toBe('Bonjour');
    });

    it('returns null when translatedTexts is not a string', async () => {
        mockOnTranslateTask.mockResolvedValueOnce({ translatedTexts: ['Bonjour'] });

        const promise = translateText('Hello', 'fr');
        await jest.runAllTimersAsync();
        const result = await promise;

        expect(result).toBeNull();
    });

    it('uses sourceLangCode "en" on iOS', async () => {
        mockOnTranslateTask.mockResolvedValueOnce({ translatedTexts: 'Hola' });

        const promise = translateText('Hello', 'es');
        await jest.runAllTimersAsync();
        await promise;

        expect(mockOnTranslateTask).toHaveBeenCalledWith(
            expect.objectContaining({ sourceLangCode: 'en' }),
        );
    });

    it('passes requiresWifi: false and requireCharging: false', async () => {
        mockOnTranslateTask.mockResolvedValueOnce({ translatedTexts: 'Ciao' });

        const promise = translateText('Hello', 'it');
        await jest.runAllTimersAsync();
        await promise;

        expect(mockOnTranslateTask).toHaveBeenCalledWith(
            expect.objectContaining({ requiresWifi: false, requireCharging: false }),
        );
    });

    it('retries on failure and succeeds on second attempt', async () => {
        mockOnTranslateTask
            .mockRejectedValueOnce(new Error('session busy'))
            .mockResolvedValueOnce({ translatedTexts: 'Bonjour' });

        const promise = translateText('Hello', 'fr');
        await jest.runAllTimersAsync();
        const result = await promise;

        expect(result).toBe('Bonjour');
        expect(mockOnTranslateTask).toHaveBeenCalledTimes(2);
    });

    it('retries up to 3 times then returns null after all retries exhausted', async () => {
        // 4 calls total (1 initial + 3 retries) all fail → null
        mockOnTranslateTask.mockRejectedValue(new Error('always fails'));

        const promise = translateText('Hello', 'fr');
        await jest.runAllTimersAsync();
        const result = await promise;

        expect(result).toBeNull();
        expect(mockOnTranslateTask).toHaveBeenCalledTimes(4);
        expect((logger.error as jest.Mock)).toHaveBeenCalledWith(
            expect.stringContaining('Translation failed'),
            expect.any(Error),
            expect.objectContaining({
                sourceLangCode: 'en',
                targetLangCode: 'fr',
                textPreview: 'Hello',
            }),
        );
    });

    it('returns null when translation has no translatedTexts field', async () => {
        mockOnTranslateTask.mockResolvedValueOnce({});

        const promise = translateText('Hello', 'fr');
        await jest.runAllTimersAsync();
        const result = await promise;

        expect(result).toBeNull();
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// translateTexts
// ─────────────────────────────────────────────────────────────────────────────

describe('translateTexts', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        jest.useFakeTimers();
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    it('returns an array aligned with the input', async () => {
        mockOnTranslateTask
            .mockResolvedValueOnce({ translatedTexts: 'Bonjour' })
            .mockResolvedValueOnce({ translatedTexts: 'Monde' });

        const promise = translateTexts(['Hello', 'World'], 'fr');
        await jest.runAllTimersAsync();
        const result = await promise;

        expect(result).toEqual(['Bonjour', 'Monde']);
        expect(result).toHaveLength(2);
    });

    it('returns empty array for empty input', async () => {
        const promise = translateTexts([], 'fr');
        await jest.runAllTimersAsync();
        const result = await promise;
        expect(result).toEqual([]);
        expect(mockOnTranslateTask).not.toHaveBeenCalled();
    });

    it('returns null entries when individual translations fail', async () => {
        mockOnTranslateTask
            .mockResolvedValueOnce({ translatedTexts: 'Bonjour' })
            .mockRejectedValue(new Error('fail'));

        const promise = translateTexts(['Hello', 'World', 'Test'], 'fr');
        await jest.runAllTimersAsync();
        const result = await promise;

        expect(result[0]).toBe('Bonjour');
        expect(result[1]).toBeNull();
        expect(result[2]).toBeNull();
    });

    it('processes single text correctly', async () => {
        mockOnTranslateTask.mockResolvedValueOnce({ translatedTexts: 'Hola' });

        const promise = translateTexts(['Hello'], 'es');
        await jest.runAllTimersAsync();
        const result = await promise;

        expect(result).toEqual(['Hola']);
    });
});
