import { onTranslateTask } from 'expo-translate-text';
import * as Device from 'expo-device';
import { Platform } from 'react-native';
import logger from '@/lib/logger';
import { canonicalizeLanguageCode, primarySubtag } from '@/lib/language-codes';
import { getLanguageNameIn } from '@/lib/language-names';

/**
 * Resolve a BCP-47 / ISO-639 language code to its English display name.
 * Falls back to null if the code is unknown — callers should handle that
 * (e.g. show "another language").
 *
 * Prefer {@link getLocalizedLanguageName} for anything user-facing: this
 * one is English-only and reads as gibberish inside a translated sentence.
 */
export function getLanguageName(code: string | null | undefined): string | null {
    return getLanguageNameIn(code, 'en');
}

/**
 * Resolve a language code to its endonym (the language's name written in
 * that language itself), e.g. "fr" → "Français", "ja" → "日本語". Looks up
 * the curated SUPPORTED_LANGUAGES list first; falls back to the English
 * name from getLanguageName if no endonym is available; returns null if
 * the code is unknown.
 *
 * NOT used for article metadata — a reader who doesn't know the script
 * can't read the endonym. That surface uses getLocalizedLanguageName.
 * This stays for the UI-language pickers, which show a language to people
 * who by definition read it.
 */
export function getNativeLanguageName(code: string | null | undefined): string | null {
    if (!code) return null;
    // Canonicalize first, so 'zh-TW' resolves to the Traditional entry
    // rather than matching 'zh-Hans' on the bare primary subtag.
    const canonical = canonicalizeLanguageCode(code);
    if (!canonical) return null;
    const match = SUPPORTED_LANGUAGES.find((l) => l.code === canonical)
        ?? SUPPORTED_LANGUAGES.find((l) => l.code === canonical.split('-')[0]);
    if (match) return match.native;
    return getLanguageName(code);
}

// The app's UI-language list — drives the language picker, the endonym
// lookup in getNativeLanguageName, and the persona agent's language name
// resolution. NOT the set used to decide whether the OS can translate a
// given article (that's platform-specific — see
// {IOS,ANDROID}_TRANSLATION_SOURCE_CODES below).
export const SUPPORTED_LANGUAGES = [
    { code: 'ar', name: 'Arabic', native: 'العربية' },
    { code: 'zh-Hans', name: 'Chinese (Simplified)', native: '简体中文' },
    { code: 'zh-Hant', name: 'Chinese (Traditional)', native: '繁體中文' },
    { code: 'nl', name: 'Dutch', native: 'Nederlands' },
    { code: 'en', name: 'English', native: 'English' },
    { code: 'fr', name: 'French', native: 'Français' },
    { code: 'de', name: 'German', native: 'Deutsch' },
    { code: 'hi', name: 'Hindi', native: 'हिन्दी' },
    { code: 'id', name: 'Indonesian', native: 'Bahasa Indonesia' },
    { code: 'it', name: 'Italian', native: 'Italiano' },
    { code: 'ja', name: 'Japanese', native: '日本語' },
    { code: 'ko', name: 'Korean', native: '한국어' },
    { code: 'pl', name: 'Polish', native: 'Polski' },
    { code: 'pt', name: 'Portuguese', native: 'Português' },
    { code: 'ru', name: 'Russian', native: 'Русский' },
    { code: 'es', name: 'Spanish', native: 'Español' },
    { code: 'th', name: 'Thai', native: 'ไทย' },
    { code: 'tr', name: 'Turkish', native: 'Türkçe' },
    { code: 'uk', name: 'Ukrainian', native: 'Українська' },
    { code: 'vi', name: 'Vietnamese', native: 'Tiếng Việt' },
] as const;

export type SupportedLanguage = typeof SUPPORTED_LANGUAGES[number];

const UI_LOCALE_CODES = new Set<string>(SUPPORTED_LANGUAGES.map((l) => l.code));

/**
 * Resolve an arbitrary feed language code to the i18next resource key for it,
 * or null when the app ships no UI strings in that language. Mirrors the
 * `resources` keys in `lib/i18n/index.ts`, which are exactly the
 * SUPPORTED_LANGUAGES codes.
 *
 * The null matters: i18n is configured with `fallbackLng: 'en'`, so asking
 * `t(key, { lng })` for a language with no bundle silently returns English.
 * Only ~20 of the ~75 languages that actually appear in the feed have one, so
 * callers need to distinguish "no bundle" from "English" themselves.
 */
export function resolveUiLocale(code: string | null | undefined): string | null {
    const canonical = canonicalizeLanguageCode(code);
    return canonical && UI_LOCALE_CODES.has(canonical) ? canonical : null;
}

// Google Translate's `tl` (target-language) param doesn't accept the
// script-suffixed BCP-47 codes the app uses for Chinese — it wants the
// region-based `zh-CN` / `zh-TW`. Every other SUPPORTED_LANGUAGES code
// passes through unchanged.
const GOOGLE_TRANSLATE_CODE_MAP: Record<string, string> = {
    'zh-Hans': 'zh-CN',
    'zh-Hant': 'zh-TW',
};

/**
 * Build a Google Translate URL that opens the given article page translated
 * into the user's app language. `sl=auto` lets Google auto-detect the source
 * (avoids source-code mapping issues); `tl` is the app language mapped through
 * GOOGLE_TRANSLATE_CODE_MAP. Google redirects to the proxied `*.translate.goog`
 * page.
 */
export function buildGoogleTranslateUrl(articleUrl: string, appLanguage: string): string {
    const tl = GOOGLE_TRANSLATE_CODE_MAP[appLanguage] ?? appLanguage;
    return `https://translate.google.com/translate?sl=auto&tl=${tl}&u=${encodeURIComponent(articleUrl)}`;
}

// Apple's on-device translation (the Translate button in the in-app Safari
// view), keyed to the iOS major that first supported the language as a
// TRANSLATION SOURCE. The app's deployment target is iOS 15.1, so every
// bucket from 15 up is reachable in the field.
//
//   14  launch set
//   15  Chinese (Traditional)
//   16  Dutch, Indonesian, Polish, Thai, Turkish, Vietnamese
//   17  Ukrainian
//   18  Hindi
//   27  Cantonese, Danish, Hebrew, Malay, Norwegian Bokmål, Swedish
//
// iOS 27 also adds Portuguese (Portugal) and Spanish (Mexico/US), but those
// are regional variants of languages whose SOURCE support dates to 14 — a
// pt-PT article has been translatable all along, so they are not listed.
const IOS_TRANSLATION_MIN_VERSION: Record<string, number> = {
    ar: 14, 'zh-Hans': 14, en: 14, fr: 14, de: 14, it: 14, ja: 14,
    ko: 14, pt: 14, ru: 14, es: 14,
    'zh-Hant': 15,
    nl: 16, id: 16, pl: 16, th: 16, tr: 16, vi: 16,
    uk: 17,
    hi: 18,
    yue: 27, da: 27, he: 27, ms: 27, no: 27, sv: 27,
};

// Google ML Kit on-device translation. Source list per
// https://developers.google.com/ml-kit/language/translation/translation-language-support
// No version gate — ML Kit downloads models on demand rather than shipping
// them with the OS.
const ANDROID_TRANSLATION_SOURCE_CODES = new Set<string>([
    'af', 'ar', 'be', 'bg', 'bn', 'ca', 'cs', 'cy', 'da', 'de', 'el', 'en',
    'eo', 'es', 'et', 'fa', 'fi', 'fr', 'ga', 'gl', 'gu', 'he', 'hi', 'hr',
    'ht', 'hu', 'id', 'is', 'it', 'ja', 'ka', 'kn', 'ko', 'lt', 'lv', 'mk',
    'mr', 'ms', 'mt', 'nl', 'no', 'pl', 'pt', 'ro', 'ru', 'sk', 'sl', 'sq',
    'sv', 'sw', 'ta', 'te', 'th', 'tl', 'tr', 'uk', 'ur', 'vi', 'zh',
]);

/** Major version of the running OS, or null when it can't be determined. */
function readOSMajor(): number | null {
    const raw = Device.osVersion;
    if (!raw) return null;
    const major = parseInt(String(raw).split('.')[0], 10);
    return Number.isNaN(major) ? null : major;
}

// Read once — the OS can't change under a running app.
let cachedOSMajor: number | null | undefined;
function currentOSMajor(): number | null {
    if (cachedOSMajor === undefined) cachedOSMajor = readOSMajor();
    return cachedOSMajor;
}

/** Test seam — resets the memoized OS version. */
export function __resetOSMajorCacheForTests(): void {
    cachedOSMajor = undefined;
}

export type TranslatableStatus = 'translatable' | 'not-translatable' | 'same-language';

export type TranslationUnsupportedReason =
    /** The OS supports this language, but on a newer version than this device runs. */
    | 'os-outdated'
    /** No on-device translator handles this language on this platform at all. */
    | 'unsupported-language'
    /** Platform has no on-device translator (web). */
    | 'no-translator';

export interface ArticleTranslationSupport {
    status: TranslatableStatus;
    /** Only set when status is 'not-translatable'. */
    reason?: TranslationUnsupportedReason;
    /** iOS major that would make this article translatable ('os-outdated' only). */
    requiredOSMajor?: number;
    /** The device's iOS major ('os-outdated' only). */
    currentOSMajor?: number;
}

/**
 * Whether the device can translate an article for the user, and — when it
 * can't — why not, so the UI can tell the difference between "update iOS"
 * and "this language isn't supported at all".
 *
 * `osMajorOverride` exists for tests; production callers omit it.
 */
export function getArticleTranslationSupport(
    originalLang: string | null | undefined,
    appLanguage: string,
    osMajorOverride?: number,
): ArticleTranslationSupport {
    const canonical = canonicalizeLanguageCode(originalLang);
    if (!canonical) return { status: 'same-language' };

    const canonicalApp = canonicalizeLanguageCode(appLanguage);
    // Chinese is compared at script level: a Simplified reader can't read a
    // Traditional article, so those are genuinely different languages here.
    if (canonicalApp && canonical === canonicalApp) return { status: 'same-language' };

    if (Platform.OS === 'android') {
        const supported = ANDROID_TRANSLATION_SOURCE_CODES.has(primarySubtag(canonical));
        return supported
            ? { status: 'translatable' }
            : { status: 'not-translatable', reason: 'unsupported-language' };
    }

    if (Platform.OS !== 'ios') {
        return { status: 'not-translatable', reason: 'no-translator' };
    }

    const required = IOS_TRANSLATION_MIN_VERSION[canonical]
        ?? IOS_TRANSLATION_MIN_VERSION[primarySubtag(canonical)];
    if (required === undefined) {
        return { status: 'not-translatable', reason: 'unsupported-language' };
    }

    const osMajor = osMajorOverride ?? currentOSMajor();
    // Unknown OS version: assume the language works rather than nagging the
    // user to update to a version we can't prove they're missing.
    if (osMajor === null || osMajor === undefined) return { status: 'translatable' };
    if (osMajor >= required) return { status: 'translatable' };

    return {
        status: 'not-translatable',
        reason: 'os-outdated',
        requiredOSMajor: required,
        currentOSMajor: osMajor,
    };
}

/**
 * Determines translation status for an article vs the user's app language.
 * - 'same-language': article is already in the user's language — hide notice
 * - 'translatable': different language AND the device's on-device translator can handle it
 * - 'not-translatable': different language and the device can't translate it
 *
 * Thin wrapper over {@link getArticleTranslationSupport} for callers that
 * only need the three-way status.
 */
export function getArticleTranslatableStatus(
    originalLang: string | null | undefined,
    appLanguage: string,
): TranslatableStatus {
    return getArticleTranslationSupport(originalLang, appLanguage).status;
}

// Serializes native translation calls to prevent the OS from cancelling
// concurrent translation sessions.
let queue: Promise<void> = Promise.resolve();

// Delays (ms) between retry attempts. The OS translator throws transiently
// when the translation session is busy; a short pause is enough to recover.
const TRANSLATE_RETRY_DELAYS_MS = [200, 600, 1800] as const;

/** Translate a single text string. Returns null on failure. */
export function translateText(
    text: string,
    targetLangCode: string,
): Promise<string | null> {
    const promise = queue.then(async () => {
        // Android's Kotlin bridge treats the literal string 'auto' as a
        // signal to run its own silent language-ID step first — no user-
        // facing UI. iOS has no equivalent: passing 'auto' isn't a real
        // BCP-47 tag (Swift feeds it straight into `Locale.Language`) and
        // fails outright, while omitting sourceLangCode (nil source) lets
        // Apple's Translation framework auto-detect — but when it can't
        // confidently detect the source, it presents its own disruptive
        // native "select a language" bottom sheet. Since `text` is always
        // meant to be English by this app's design (title_en, description_en,
        // reason are all English-sourced fields), iOS always declares 'en'
        // and lets a wrong assumption fail quietly through the retry/catch/
        // log path below instead of surfacing OS UI.
        const sourceLangCode = Platform.OS === 'android' ? 'auto' : 'en';
        for (let attempt = 0; attempt <= TRANSLATE_RETRY_DELAYS_MS.length; attempt++) {
            try {
                const result = await onTranslateTask({
                    input: text,
                    targetLangCode,
                    sourceLangCode,
                    // Required on Android: the Kotlin bridge rejects undefined
                    // values for these keys. iOS ignores them.
                    requiresWifi: false,
                    requireCharging: false,
                });
                const translated = typeof result.translatedTexts === 'string'
                    ? result.translatedTexts
                    : null;
                if (translated == null) {
                    logger.warn('[TranslationService] Translation returned no text', {
                        textPreview: text.slice(0, 20),
                        sourceLangCode,
                        targetLangCode,
                        attempt,
                    });
                }
                return translated;
            } catch (err) {
                logger.warn('[TranslationService] Translation attempt failed', {
                    textPreview: text.slice(0, 20),
                    sourceLangCode,
                    targetLangCode,
                    attempt,
                    error: err instanceof Error ? err.message : String(err),
                });
                if (attempt < TRANSLATE_RETRY_DELAYS_MS.length) {
                    await new Promise<void>((resolve) =>
                        setTimeout(resolve, TRANSLATE_RETRY_DELAYS_MS[attempt]),
                    );
                } else {
                    logger.error('[TranslationService] Translation failed', err as Error, {
                        textPreview: text.slice(0, 20),
                        sourceLangCode,
                        targetLangCode,
                    });
                    return null;
                }
            }
        }
        return null;
    });

    // Keep the queue moving even if one translation fails
    queue = promise.then(() => {}, () => {});

    return promise;
}

/** Translate multiple texts sequentially. Returns array aligned with input. */
export async function translateTexts(
    texts: string[],
    targetLangCode: string,
): Promise<(string | null)[]> {
    const results: (string | null)[] = [];
    for (const text of texts) {
        results.push(await translateText(text, targetLangCode));
    }
    return results;
}
