import { onTranslateTask } from 'expo-translate-text';
import languages from '@cospired/i18n-iso-languages';
import languagesEn from '@cospired/i18n-iso-languages/langs/en.json';
import { Platform } from 'react-native';
import logger from '@/lib/logger';

languages.registerLocale(languagesEn);

/**
 * Resolve a BCP-47 / ISO-639 language code to its English display name
 * via the @cospired/i18n-iso-languages library. Falls back to null if
 * the code is unknown — callers should handle that (e.g. show "another
 * language").
 */
export function getLanguageName(code: string | null | undefined): string | null {
    if (!code) return null;
    const primary = code.split('-')[0];
    const name = languages.getName(primary, 'en');
    return name && name !== primary ? name : null;
}

/**
 * Resolve a language code to its endonym (the language's name written in
 * that language itself), e.g. "fr" → "Français", "ja" → "日本語". Looks up
 * the curated SUPPORTED_LANGUAGES list first; falls back to the English
 * name from getLanguageName if no endonym is available; returns null if
 * the code is unknown.
 */
export function getNativeLanguageName(code: string | null | undefined): string | null {
    if (!code) return null;
    const normalized = code.split('-')[0];
    const match = SUPPORTED_LANGUAGES.find(
        (l) => l.code === code || l.code.split('-')[0] === normalized,
    );
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

// Apple Translation framework (iOS 17.4+).
const IOS_TRANSLATION_SOURCE_CODES = new Set<string>([
    'ar', 'zh-Hans', 'zh-Hant', 'nl', 'en', 'fr', 'de', 'hi', 'id', 'it',
    'ja', 'ko', 'pl', 'pt', 'ru', 'es', 'th', 'tr', 'uk', 'vi',
]);

// Google ML Kit on-device translation. Source list per
// https://developers.google.com/ml-kit/language/translation/translation-language-support
const ANDROID_TRANSLATION_SOURCE_CODES = new Set<string>([
    'af', 'ar', 'be', 'bg', 'bn', 'ca', 'cs', 'cy', 'da', 'de', 'el', 'en',
    'eo', 'es', 'et', 'fa', 'fi', 'fr', 'ga', 'gl', 'gu', 'he', 'hi', 'hr',
    'ht', 'hu', 'id', 'is', 'it', 'ja', 'ka', 'kn', 'ko', 'lt', 'lv', 'mk',
    'mr', 'ms', 'mt', 'nl', 'no', 'pl', 'pt', 'ro', 'ru', 'sk', 'sl', 'sq',
    'sv', 'sw', 'ta', 'te', 'th', 'tl', 'tr', 'uk', 'ur', 'vi', 'zh',
]);

// Web/other platforms have no on-device translator → empty set.
const ACTIVE_TRANSLATION_SOURCE_CODES: Set<string> =
    Platform.OS === 'ios' ? IOS_TRANSLATION_SOURCE_CODES
        : Platform.OS === 'android' ? ANDROID_TRANSLATION_SOURCE_CODES
            : new Set();

export type TranslatableStatus = 'translatable' | 'not-translatable' | 'same-language';

/**
 * Determines translation status for an article vs the user's app language.
 * - 'same-language': article is already in the user's language — hide notice
 * - 'translatable': different language AND the device's on-device translator can handle it
 * - 'not-translatable': different language and the source locale is outside the device's supported list
 */
export function getArticleTranslatableStatus(
    originalLang: string | null | undefined,
    appLanguage: string,
): TranslatableStatus {
    if (!originalLang) return 'same-language';
    const normalized = originalLang.split('-')[0];
    const appNormalized = appLanguage.split('-')[0];
    if (normalized === appNormalized) return 'same-language';
    const supported =
        ACTIVE_TRANSLATION_SOURCE_CODES.has(originalLang) ||
        ACTIVE_TRANSLATION_SOURCE_CODES.has(normalized);
    return supported ? 'translatable' : 'not-translatable';
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
