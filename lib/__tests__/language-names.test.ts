import { canonicalizeLanguageCode, primarySubtag } from '../language-codes';
import { FEED_SOURCE_LANGUAGE_CODES, getLocalizedLanguageName } from '../language-names';

describe('canonicalizeLanguageCode', () => {
    it('returns null for empty input', () => {
        expect(canonicalizeLanguageCode(null)).toBeNull();
        expect(canonicalizeLanguageCode(undefined)).toBeNull();
        expect(canonicalizeLanguageCode('')).toBeNull();
        expect(canonicalizeLanguageCode('  ')).toBeNull();
    });

    it('lowercases the primary subtag', () => {
        expect(canonicalizeLanguageCode('ES')).toBe('es');
        expect(canonicalizeLanguageCode('ID')).toBe('id');
        expect(canonicalizeLanguageCode('fr-FR')).toBe('fr');
        expect(canonicalizeLanguageCode('fr-fr')).toBe('fr');
    });

    it('drops region and script for non-Chinese languages', () => {
        expect(canonicalizeLanguageCode('pt-BR')).toBe('pt');
        expect(canonicalizeLanguageCode('pt-PT')).toBe('pt');
        expect(canonicalizeLanguageCode('ja-Latn')).toBe('ja');
        expect(canonicalizeLanguageCode('sr-me')).toBe('sr');
    });

    it('accepts underscore-separated tags', () => {
        expect(canonicalizeLanguageCode('pt_BR')).toBe('pt');
    });

    it('resolves Chinese to a script, never a bare zh', () => {
        expect(canonicalizeLanguageCode('zh')).toBe('zh-Hans');
        expect(canonicalizeLanguageCode('zh-CN')).toBe('zh-Hans');
        expect(canonicalizeLanguageCode('zh-SG')).toBe('zh-Hans');
        expect(canonicalizeLanguageCode('zh-Hans')).toBe('zh-Hans');
        expect(canonicalizeLanguageCode('zh-TW')).toBe('zh-Hant');
        expect(canonicalizeLanguageCode('zh-HK')).toBe('zh-Hant');
        expect(canonicalizeLanguageCode('zh-MO')).toBe('zh-Hant');
        expect(canonicalizeLanguageCode('zh-Hant')).toBe('zh-Hant');
        // Script wins over a contradicting region.
        expect(canonicalizeLanguageCode('zh-Hant-CN')).toBe('zh-Hant');
    });

    it('keeps Cantonese distinct from Chinese', () => {
        expect(canonicalizeLanguageCode('yue')).toBe('yue');
    });

    it('maps legacy codes onto their modern equivalents', () => {
        expect(canonicalizeLanguageCode('iw')).toBe('he');
        expect(canonicalizeLanguageCode('in')).toBe('id');
        expect(canonicalizeLanguageCode('ji')).toBe('yi');
        expect(canonicalizeLanguageCode('mo')).toBe('ro');
        expect(canonicalizeLanguageCode('fil')).toBe('tl');
        expect(canonicalizeLanguageCode('nb')).toBe('no');
        expect(canonicalizeLanguageCode('nn')).toBe('no');
    });
});

describe('primarySubtag', () => {
    it('strips the script off a canonical code', () => {
        expect(primarySubtag('zh-Hant')).toBe('zh');
        expect(primarySubtag('fr')).toBe('fr');
    });
});

describe('getLocalizedLanguageName', () => {
    it('names a language in the reader\'s own language', () => {
        expect(getLocalizedLanguageName('de', 'en')).toBe('German');
        expect(getLocalizedLanguageName('de', 'fr')).toBe('Allemand');
        expect(getLocalizedLanguageName('de', 'ru')).toBe('немецкий');
        expect(getLocalizedLanguageName('ja', 'zh-Hans')).toBe('日语');
    });

    it('names Chinese generically, whichever script the article uses', () => {
        expect(getLocalizedLanguageName('zh', 'en')).toBe('Chinese');
        expect(getLocalizedLanguageName('zh-TW', 'en')).toBe('Chinese');
    });

    it('normalizes the messy codes the feed emits', () => {
        expect(getLocalizedLanguageName('ES', 'en')).toBe('Spanish');
        expect(getLocalizedLanguageName('fr-fr', 'en')).toBe('French');
        expect(getLocalizedLanguageName('iw', 'en')).toBe('Hebrew');
    });

    it('drops the ISO disambiguator from catalogue names', () => {
        // The packs say "Greek (modern)" / "Hebrew (modern)", which reads
        // badly inside "This article is in ___".
        expect(getLocalizedLanguageName('el', 'en')).toBe('Greek');
        expect(getLocalizedLanguageName('el', 'es')).toBe('Griego');
        expect(getLocalizedLanguageName('he', 'ru')).toBe('иврит');
    });

    it('covers a language @cospired ships no entry for', () => {
        expect(getLocalizedLanguageName('yue', 'en')).toBe('Cantonese');
    });

    it('covers the UI locales @cospired ships no pack for', () => {
        // Hindi, Turkish and Traditional Chinese come from EXTRA_LANGUAGE_NAMES.
        expect(getLocalizedLanguageName('de', 'hi')).toBe('जर्मन');
        expect(getLocalizedLanguageName('de', 'tr')).toBe('Almanca');
        // Traditional, not the Simplified pack's 德语.
        expect(getLocalizedLanguageName('de', 'zh-Hant')).toBe('德語');
    });

    it('falls back to the base pack for a locale variant with no override', () => {
        expect(getLocalizedLanguageName('de', 'pt-BR')).toBe(
            getLocalizedLanguageName('de', 'pt'),
        );
    });

    it('names every feed language in every override locale', () => {
        for (const locale of ['hi', 'tr', 'zh-Hant']) {
            const unnamed = FEED_SOURCE_LANGUAGE_CODES.filter(
                (code) => !getLocalizedLanguageName(code, locale),
            );
            expect({ locale, unnamed }).toEqual({ locale, unnamed: [] });
        }
    });

    it('returns null for unusable input', () => {
        expect(getLocalizedLanguageName(null, 'en')).toBeNull();
        expect(getLocalizedLanguageName('zzz', 'en')).toBeNull();
    });

    it('names every language the feed actually carries', () => {
        const unnamed = FEED_SOURCE_LANGUAGE_CODES.filter(
            (code) => !getLocalizedLanguageName(code, 'en'),
        );
        expect(unnamed).toEqual([]);
    });
});
