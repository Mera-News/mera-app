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

/** Translate a single text string. Returns null on failure. */
export function translateText(
    text: string,
    targetLangCode: string,
): Promise<string | null> {
    const promise = queue.then(async () => {
        try {
            const result = await onTranslateTask({
                input: text,
                targetLangCode,
                // On Android, expo-translate-text's "fixed source" code path
                // has a pendingCount race that closes the translator before
                // translate() finishes, causing a native crash with no JS
                // log. Routing through auto-detect avoids that path. iOS
                // doesn't use this code, so we keep the explicit 'en'
                // source there for the small perf win.
                sourceLangCode: Platform.OS === 'android' ? 'auto' : 'en',
                // Required on Android: the Kotlin bridge rejects undefined
                // values for these keys. iOS ignores them.
                requiresWifi: false,
                requireCharging: false,
            });
            return typeof result.translatedTexts === 'string'
                ? result.translatedTexts
                : null;
        } catch (err) {
            logger.error('[TranslationService] Translation failed', err as Error);
            return null;
        }
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
