import { onTranslateTask } from 'expo-translate-text';
import * as Device from 'expo-device';
import { useSyncExternalStore } from 'react';
import { Platform } from 'react-native';
import logger from '@/lib/logger';
import { canonicalizeLanguageCode, primarySubtag } from '@/lib/language-codes';
import { getLanguageNameIn } from '@/lib/language-names';
import {
    __resetTranslationQueueForTests,
    enqueueTranslationTask,
    isDropped,
    PROBE_PRIORITY,
} from '@/lib/translation-queue';

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
 * The language code to hand the NATIVE translator, which is not always the
 * app's canonical code.
 *
 * Android's bridge resolves the tag through ML Kit's
 * `TranslateLanguage.fromLanguageTag`, which only knows bare ISO-639-1 tags —
 * it returns null for every script-suffixed code the app uses, and the module
 * then throws `Invalid target language: zh-Hans` (MERA-APP-6H). The support
 * check already reduced to the primary subtag
 * (`ANDROID_TRANSLATION_SOURCE_CODES.has(primarySubtag(...))`, see
 * canTranslateIntoLanguage) while the CALL passed the full tag, so Android
 * answered "yes, I can translate into zh-Hans" and then rejected it — the
 * asymmetry is the bug, and this makes both halves agree.
 *
 * ML Kit has one Chinese model (Simplified), so zh-Hant readers get Simplified
 * output on Android rather than nothing. That is the platform's own limit.
 *
 * iOS is passed through unchanged: Apple's Translation framework takes BCP-47
 * and needs the script subtag to tell the two Chinese scripts apart.
 */
function nativeTargetLangCode(targetLangCode: string): string {
    if (Platform.OS !== 'android') return targetLangCode;
    const canonical = canonicalizeLanguageCode(targetLangCode) ?? targetLangCode;
    return primarySubtag(canonical);
}

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

/**
 * Whether this device's OS can translate INTO the given language at all.
 *
 * Reuses the same per-language iOS-version ladder as
 * {@link getArticleTranslationSupport} rather than duplicating it. Apple ships
 * one asset per language and adds it in both directions in the same release,
 * so the "first iOS that supported X" year is the same whether X is the source
 * or the target.
 *
 * The point of asking is to never *attempt* a translation that cannot
 * possibly succeed: an attempt that is doomed still costs the user a system
 * sheet before it fails.
 */
export function canTranslateIntoLanguage(
    targetLangCode: string,
    osMajorOverride?: number,
): boolean {
    if (Platform.OS === 'android') {
        return ANDROID_TRANSLATION_SOURCE_CODES.has(
            primarySubtag(canonicalizeLanguageCode(targetLangCode) ?? targetLangCode),
        );
    }
    if (Platform.OS !== 'ios') return false;

    const canonical = canonicalizeLanguageCode(targetLangCode) ?? targetLangCode;
    const required = IOS_TRANSLATION_MIN_VERSION[canonical]
        ?? IOS_TRANSLATION_MIN_VERSION[primarySubtag(canonical)];
    if (required === undefined) return false;

    const osMajor = osMajorOverride ?? currentOSMajor();
    // Unknown OS version: assume it works rather than disabling a feature we
    // can't prove is missing (mirrors getArticleTranslationSupport).
    if (osMajor === null || osMajor === undefined) return true;
    return osMajor >= required;
}

// ─────────────────────────────────────────────────────────────────────────────
// Translation availability breaker
// ─────────────────────────────────────────────────────────────────────────────
//
// THE BUG THIS EXISTS FOR. Apple's `.translationTask` presents a system
// "Download language" sheet from INSIDE the native call whenever the target
// language's assets aren't installed (expo-translate-text's
// ios/TranslationViews.swift). Each sheet belongs to exactly one call — the
// native module tears its hosting controller down on both success and error
// (ios/ExpoTranslateTextModule.swift) — so a sheet that "keeps popping up"
// can only mean we keep calling. And we did: every visible
// <TranslatableDynamic> fires its own request, each request was retried up to
// four times, and nothing remembered that the previous one had failed.
//
// The break is deliberately CAUSE-INDEPENDENT. Any failure counts, whatever
// it was and whether or not we can name it. Nothing here parses the error
// message: Apple hands the bridge a localized string, not a code
// (ios/TranslationHelpers.swift), so "the pack is still downloading", "the
// download failed" and "unsupported language pair" are indistinguishable from
// JS. Classification must never be load-bearing for un-blocking the user.
//
// It is a counter, not a latch. Any success resets it, the state is in-memory
// only, and switching language clears it — being offline once cannot cost the
// user a language permanently.

/**
 * Consecutive failures for one target language before we stop calling out,
 * for a language we have NEVER successfully translated into.
 *
 * Two, because an unverified language is the only one whose native call can
 * present Apple's download sheet, so its failures must be cheap.
 */
export const TRANSLATION_FAILURE_THRESHOLD = 2;

/**
 * The same budget for a language that HAS translated successfully this session.
 *
 * Higher, and deliberately so: the assets are installed (that is what
 * "verified" means), so no further call can present a sheet, and the failures
 * that remain are the transient "translation session busy" kind. Two was tuned
 * for the sheet-storm case and is far too tight here — it let one bad moment
 * cost the user translation for the rest of the session.
 */
export const VERIFIED_TRANSLATION_FAILURE_THRESHOLD = 5;

export interface TranslationFailureState {
    readonly targetLangCode: string;
    /** Raw OS message. Diagnostic only — never user-facing, never branched on. */
    readonly lastError: string | null;
    /**
     * True when retrying is known to be pointless — the two cases we can
     * establish WITHOUT guessing at Apple's error strings: this OS version has
     * no translator for the language at all
     * ({@link canTranslateIntoLanguage}), or this device has no on-device
     * translator at all ({@link deviceCanTranslate}). The UI offers no retry
     * for these.
     *
     * False means "we don't know why". That covers both "the pack is still
     * downloading" and "the download failed", which the native bridge gives us
     * no way to tell apart, so the copy has to own the uncertainty.
     */
    readonly permanent: boolean;
    /**
     * True only for the whole-device case: on-device translation does not work
     * here at all, for any language. Distinct from `permanent` alone, which
     * also covers "this iOS is too old for THIS language" — different copy,
     * because telling someone to update iOS would be a lie.
     */
    readonly deviceUnsupported: boolean;
}

const failureCounts = new Map<string, number>();
const blockedLanguages = new Map<string, TranslationFailureState>();
/** Languages that have produced at least one successful translation this
 *  session — proof the assets are installed, so no sheet can appear for them. */
const verifiedLanguages = new Set<string>();
const availabilityListeners = new Set<() => void>();

function notifyAvailabilityChanged(): void {
    availabilityListeners.forEach((listener) => listener());
}

function recordTranslationSuccess(targetLangCode: string): void {
    const newlyVerified = !verifiedLanguages.has(targetLangCode);
    verifiedLanguages.add(targetLangCode);
    const wasBlocked = blockedLanguages.delete(targetLangCode);
    failureCounts.delete(targetLangCode);
    // Verification is a state change every surface cares about: it is what
    // opens the native-call gate below, so the nodes that were rendering
    // English need to hear about it, not just the ones that were blocked.
    if (wasBlocked || newlyVerified) notifyAvailabilityChanged();
}

function blockLanguage(
    targetLangCode: string,
    message: string | null,
    permanent: boolean,
    deviceUnsupported = false,
): void {
    if (blockedLanguages.has(targetLangCode)) return;
    blockedLanguages.set(targetLangCode, {
        targetLangCode,
        lastError: message,
        permanent,
        deviceUnsupported,
    });
    logger.warn('[TranslationService] Translation blocked for language', {
        targetLangCode,
        permanent,
        deviceUnsupported,
        lastError: message,
    });
    notifyAvailabilityChanged();
}

/** Failures tolerated before the language is blocked, given what we know. */
function failureThresholdFor(targetLangCode: string): number {
    return verifiedLanguages.has(targetLangCode)
        ? VERIFIED_TRANSLATION_FAILURE_THRESHOLD
        : TRANSLATION_FAILURE_THRESHOLD;
}

function recordTranslationFailure(targetLangCode: string, message: string | null): void {
    const next = (failureCounts.get(targetLangCode) ?? 0) + 1;
    failureCounts.set(targetLangCode, next);
    if (next < failureThresholdFor(targetLangCode)) return;
    blockLanguage(targetLangCode, message, false);
}

/** True when we have stopped calling the OS translator for this language. */
export function isTranslationBlocked(targetLangCode: string): boolean {
    return blockedLanguages.has(targetLangCode);
}

export function getTranslationFailure(targetLangCode: string): TranslationFailureState | null {
    return blockedLanguages.get(targetLangCode) ?? null;
}

/**
 * Arm exactly ONE further attempt for a language, in response to a deliberate
 * user action. The counter is left one short of the threshold rather than
 * reset to zero, so a failed retry re-blocks immediately instead of re-arming
 * the loop: one tap, one attempt, one sheet at most.
 *
 * NOTE: on iOS this only helps a language that is already VERIFIED. Clearing
 * the block on an unverified one changes nothing on its own, because the gate
 * still refuses every caller but the probe — so the user-facing retry path is
 * {@link probeTranslationLanguage}, not this. Kept for the verified case and
 * for Android, where there is no gate.
 */
export function armTranslationRetry(targetLangCode: string): void {
    const blocked = blockedLanguages.get(targetLangCode);
    if (!blocked || blocked.permanent) return;
    blockedLanguages.delete(targetLangCode);
    failureCounts.set(targetLangCode, failureThresholdFor(targetLangCode) - 1);
    notifyAvailabilityChanged();
}

/** Full reset — kept for tests and for a hard "start over" only. */
export function clearTranslationFailures(): void {
    const hadBlocked = blockedLanguages.size > 0;
    blockedLanguages.clear();
    failureCounts.clear();
    if (hadBlocked) notifyAvailabilityChanged();
}

/**
 * Clear the breaker for ONE language.
 *
 * This is what a language switch uses, not {@link clearTranslationFailures}.
 * The difference matters on the reverting path: an attempt that fails must
 * leave the language the user is going BACK to exactly as it was, and the
 * whole-map clear wiped that too — so a revert could silently un-block a
 * language that had genuinely failed, and the feed would start calling out
 * again for something already known to be broken.
 */
export function clearTranslationFailuresFor(targetLangCode: string): void {
    const hadBlocked = blockedLanguages.delete(targetLangCode);
    failureCounts.delete(targetLangCode);
    if (hadBlocked) notifyAvailabilityChanged();
}

export function subscribeTranslationAvailability(listener: () => void): () => void {
    availabilityListeners.add(listener);
    return () => {
        availabilityListeners.delete(listener);
    };
}

/**
 * Reactive read of the breaker for one language. `useSyncExternalStore` (not
 * zustand) because the breaker lives in this module and `app-language-store`
 * already imports from here — putting it in the store would make the
 * dependency circular.
 */
export function useTranslationBlocked(targetLangCode: string): TranslationFailureState | null {
    return useSyncExternalStore(
        subscribeTranslationAvailability,
        () => blockedLanguages.get(targetLangCode) ?? null,
        () => null,
    );
}

/**
 * True once this language has produced at least one successful translation
 * this session — i.e. the assets are installed and the native-call gate below
 * is open for it.
 */
export function isTranslationVerified(targetLangCode: string): boolean {
    return verifiedLanguages.has(targetLangCode);
}

/**
 * Reactive read of "nothing will be translated into this language right now",
 * for whichever reason. The render surfaces want exactly this one boolean:
 * blocked and gated look identical on screen (English text, no call), and
 * treating them separately in every component invited them to drift.
 */
export function useTranslationSuppressed(targetLangCode: string): boolean {
    return useSyncExternalStore(
        subscribeTranslationAvailability,
        () => blockedLanguages.has(targetLangCode) || isNativeCallGated(targetLangCode),
        () => true,
    );
}

/** Test seam — clears every module-level translation state. */
export function __resetTranslationStateForTests(): void {
    failureCounts.clear();
    blockedLanguages.clear();
    verifiedLanguages.clear();
    availabilityListeners.clear();
    probeTimedOut.clear();
    probeErrors.clear();
    __resetTranslationQueueForTests();
}

// ─────────────────────────────────────────────────────────────────────────────
// The native-call gate
// ─────────────────────────────────────────────────────────────────────────────
//
// On iOS, EVERY native call for a language whose assets are not installed
// presents Apple's system download sheet from inside the call. The breaker
// above caps how many of those can happen; this gate stops all but ONE of them
// happening at all.
//
// Rule: for an unverified iOS target language, the ONLY caller allowed to
// reach the native module is {@link probeTranslationLanguage} — one deliberate
// gesture, one call, one sheet, at a moment the UI is explaining. Every other
// caller (i.e. every <TranslatableDynamic> on screen) returns null without
// calling out, and renders the server-side English it already holds.
//
// This is what makes a language switch structurally safe. Before it, switching
// language invalidated the translation cache and every mounted node re-fired in
// one effect flush: N queued native calls, back to back, racing the picker
// modal's dismissal animation. Capping that at two failures made it survivable;
// capping it at one deliberate call makes it correct — and it holds whatever
// the underlying native fault turns out to be, because there is no longer a
// second call to collide with the first.
//
// Android is not gated: ML Kit downloads models silently with no system UI, so
// there is no sheet to storm and nothing to protect.

function isNativeCallGated(targetLangCode: string): boolean {
    if (Platform.OS !== 'ios') return false;
    if (targetLangCode === 'en') return false;
    return !verifiedLanguages.has(targetLangCode);
}

/**
 * Whether this device has an on-device translator at all.
 *
 * The iOS Simulator does not: Apple's Translation framework resolves the
 * language pair, then fails the whole request with "Translation isn't
 * supported on the current device" (TranslationErrorDomain Code=11), for every
 * language, however many assets the runtime reports as installed. `isDevice`
 * is the honest test for that, and it is a CAPABILITY check, not a build-type
 * check: a release build on a simulator behaves exactly the same, and on real
 * hardware the branch never fires.
 */
export function deviceCanTranslate(): boolean {
    if (Platform.OS !== 'ios') return true;
    return Device.isDevice !== false;
}

// Native translation calls are serialized and PRIORITISED by the scheduler in
// `lib/translation-queue` — one in flight at a time (the OS cancels concurrent
// translation sessions), dispatched nearest-the-viewport first, and dropped
// before dispatch when the route they were queued for is no longer on screen.

// Delays (ms) between retry attempts. The OS translator throws transiently
// when the translation session is busy; a short pause is enough to recover.
const TRANSLATE_RETRY_DELAYS_MS = [200, 600, 1800] as const;

// No in-call retries. Used on iOS for a language we have never successfully
// translated into, because there every attempt against missing assets
// re-presents Apple's download sheet. The transient "session busy" case the
// ladder exists for still recovers: a single failure is below
// TRANSLATION_FAILURE_THRESHOLD, so the next request gets a clean second try.
const NO_RETRY_DELAYS_MS = [] as const;

function retryDelaysFor(targetLangCode: string): readonly number[] {
    if (Platform.OS === 'ios' && !verifiedLanguages.has(targetLangCode)) {
        return NO_RETRY_DELAYS_MS;
    }
    return TRANSLATE_RETRY_DELAYS_MS;
}

/**
 * Ceiling on a single native call for ordinary (non-probe) translation.
 *
 * `onTranslateTask` has no cancellation and no timeout of its own, and the
 * vendored Swift can leak its continuation — it installs the SwiftUI view
 * (which starts translating on `onAppear`) BEFORE it assigns the `onError`
 * handler inside `withCheckedThrowingContinuation`, so an error that lands in
 * that window resumes nothing and the promise never settles. Every caller
 * shares one serial `queue`, so one such call would wedge translation
 * app-wide, permanently, with no error anywhere. This is the guard.
 */
const TRANSLATE_CALL_TIMEOUT_MS = 20_000;

/**
 * Ceiling on a probe. Much longer, because a probe legitimately holds the
 * native call open for as long as Apple's sheet is up AND the pack is
 * downloading — that whole wait happens inside the one call.
 *
 * Holding the shared queue for this long is safe precisely because of the gate
 * above: while a language is unverified nothing else may issue a native call
 * anyway, so there is nothing queued behind the probe to starve.
 */
export const TRANSLATION_PROBE_TIMEOUT_MS = 90_000;

class TranslationTimeoutError extends Error {
    constructor(ms: number) {
        super(`Translation call exceeded ${ms}ms`);
        this.name = 'TranslationTimeoutError';
    }
}

/**
 * Race one native call against a timeout.
 *
 * A timed-out call is ABANDONED, not cancelled — nothing can cancel it. So the
 * original promise keeps a handler attached: if the pack finishes downloading
 * a minute after we gave up, that late success still marks the language
 * verified, and the user's next attempt succeeds instantly instead of paying
 * for the same download again.
 */
function callNativeWithTimeout(
    text: string,
    sourceLangCode: string,
    targetLangCode: string,
    timeoutMs: number,
): Promise<string | null> {
    const call = onTranslateTask({
        input: text,
        // The app's canonical code is NOT always what the native translator
        // accepts — see nativeTargetLangCode. Every other use of
        // `targetLangCode` in this module (the block map, the verified set,
        // the failure counters) deliberately keeps the canonical code, so the
        // conversion happens here and nowhere else.
        targetLangCode: nativeTargetLangCode(targetLangCode),
        sourceLangCode,
        // Required on Android: the Kotlin bridge rejects undefined
        // values for these keys. iOS ignores them.
        requiresWifi: false,
        requireCharging: false,
    });

    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    call.then(
        (result) => {
            if (settled) return;
            // Landed after we gave up. Record the verification, drop the text.
            if (typeof result?.translatedTexts === 'string') {
                logger.info('[TranslationService] Late translation success after timeout', {
                    targetLangCode,
                });
                recordTranslationSuccess(targetLangCode);
            }
        },
        () => {
            // Late failure: already counted by the timeout path.
        },
    );

    const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new TranslationTimeoutError(timeoutMs)), timeoutMs);
    });

    return Promise.race([call, timeout]).then(
        (result) => {
            settled = true;
            if (timer) clearTimeout(timer);
            return typeof (result as { translatedTexts?: unknown }).translatedTexts === 'string'
                ? ((result as { translatedTexts: string }).translatedTexts)
                : null;
        },
        (err) => {
            settled = true;
            if (timer) clearTimeout(timer);
            throw err;
        },
    );
}

export type TranslationProbeOutcome =
    /** The OS translated the sample. Assets are installed; the gate is open. */
    | 'success'
    /** The OS refused or errored. Could be a failed download, could be transient. */
    | 'failed'
    /** We gave up waiting. The download may yet finish in the background. */
    | 'timeout'
    /** This device has no on-device translator at all (see deviceCanTranslate). */
    | 'device-unsupported'
    /** This OS version has no translator for this language. */
    | 'language-unsupported';

/**
 * Ask the OS, once, whether it can translate into this language — and let it
 * present its download sheet while it finds out.
 *
 * THIS IS THE ONLY CALL THAT MAY PRESENT APPLE'S SHEET. It exists so that the
 * sheet appears at exactly one moment: right after a deliberate gesture, with
 * a screen on the other side explaining what is happening and offering a way
 * out. Everything else in this module exists to protect that moment.
 *
 * Callers must ensure no other view controller is being presented or dismissed
 * when this runs — see the picker screens, which wait for their modal's
 * `onDismiss` before probing.
 *
 * The outcome is REPORTED, not just recorded: the caller is showing the user a
 * spinner and owes them an answer. A successful probe still goes through the
 * normal success path, so the language enters `verifiedLanguages` and the gate
 * opens for the rest of the session.
 */
export async function probeTranslationLanguage(
    targetLangCode: string,
    timeoutMs: number = TRANSLATION_PROBE_TIMEOUT_MS,
): Promise<TranslationProbeOutcome> {
    if (targetLangCode === 'en') return 'success';

    // A stale block from an earlier attempt this session would short-circuit
    // the probe at the head of the queue and no sheet would ever appear —
    // which is the exact bug this whole path exists to fix. Clear THIS
    // language only; the one we may have to revert to must survive intact.
    clearTranslationFailuresFor(targetLangCode);

    if (!canTranslateIntoLanguage(targetLangCode)) {
        blockLanguage(targetLangCode, 'unsupported-target-language', true);
        return 'language-unsupported';
    }

    if (!deviceCanTranslate()) {
        blockLanguage(targetLangCode, 'device-cannot-translate', true, true);
        return 'device-unsupported';
    }

    const translated = await translateText('Hello', targetLangCode, {
        isProbe: true,
        timeoutMs,
    });
    if (translated != null) return 'success';

    // ONE failed probe blocks the language, rather than counting toward the
    // threshold. The probe is the deliberate, isolated attempt — its verdict
    // is conclusive enough to act on, and being blocked is what gives the UI
    // something to SAY (the red translate icon, the unavailable prompt).
    // Leaving it merely counted would put the app back in the state the user
    // reported: no sheet, no translation, and no explanation.
    //
    // It is not a latch: the next probe clears it before it runs, and
    // armTranslationRetry still offers a single in-place retry.
    blockLanguage(targetLangCode, probeErrors.get(targetLangCode) ?? null, false);
    return probeTimedOut.get(targetLangCode) ? 'timeout' : 'failed';
}

// Per-language, NOT single globals: a startup probe and a picker probe can be
// in flight against different languages, and a shared slot would let one of
// them report the other's failure reason to the user.
const probeTimedOut = new Map<string, boolean>();
const probeErrors = new Map<string, string | null>();

export interface TranslateOptions {
    /** Marks the one caller allowed through the gate. Defaults to false. */
    readonly isProbe?: boolean;
    readonly timeoutMs?: number;
    /**
     * Queue priority — LOWER dispatches sooner. Callers that know where their
     * text sits on screen should pass `visibilityPriority(measuredY)`; the
     * default 0 means "as soon as the queue reaches you".
     */
    readonly priority?: number;
    /**
     * Set false to exempt this call from route-epoch dropping. Defaults to true
     * for ordinary calls; the probe is exempt automatically.
     */
    readonly epochScoped?: boolean;
}

/**
 * Why a translation call ended.
 *
 * `dropped` is NOT a failure and must never be treated as one: the route moved
 * on before the call was ever made, so the text is exactly as translatable as
 * it was a moment ago. A caller that latches on `dropped` (as a naive "we tried
 * and got nothing" would) leaves the node showing English for the rest of the
 * session — see TranslatableDynamic, which clears its fired-latch on it.
 */
export type TranslationOutcome = 'ok' | 'failed' | 'dropped';

export interface TranslationResult {
    readonly status: TranslationOutcome;
    /** Non-null only when `status === 'ok'`. */
    readonly text: string | null;
}

/**
 * Translate a single text string, reporting WHY it ended. Never rejects.
 *
 * Prefer this over {@link translateText} anywhere the caller keeps per-node
 * "already tried" state.
 */
export function translateTextDetailed(
    text: string,
    targetLangCode: string,
    options: TranslateOptions = {},
): Promise<TranslationResult> {
    const isProbe = options.isProbe === true;
    const timeoutMs = options.timeoutMs
        ?? (isProbe ? TRANSLATION_PROBE_TIMEOUT_MS : TRANSLATE_CALL_TIMEOUT_MS);
    if (isProbe) {
        probeTimedOut.set(targetLangCode, false);
        probeErrors.set(targetLangCode, null);
    }

    const task = async (): Promise<string | null> => {
        // Checked HERE, at the head of the queue — NOT when translateText was
        // called. A language switch fires every mounted <TranslatableDynamic>
        // in one effect flush, so all N calls are already queued before the
        // first failure lands; a call-time check would let every one of them
        // reach the native module and present its own sheet.
        if (blockedLanguages.has(targetLangCode)) return null;

        // The two "this can never work" checks come BEFORE the gate, not
        // after. Both are pure and free, and both need to RECORD their verdict
        // — the permanent block is what the article notices and the
        // unavailable prompt read to explain themselves. Gating first would
        // silently swallow the verdict and leave the UI with nothing to say.
        //
        // A language the OS cannot translate into will never succeed, and a
        // doomed attempt still costs the user a sheet before it fails.
        if (!canTranslateIntoLanguage(targetLangCode)) {
            blockLanguage(targetLangCode, 'unsupported-target-language', true);
            return null;
        }

        // Same reasoning, one level up: no translator on this device at all.
        if (!deviceCanTranslate()) {
            blockLanguage(targetLangCode, 'device-cannot-translate', true, true);
            return null;
        }

        // THE GATE. An unverified iOS language may only be reached by the
        // probe. Everything else falls back to the English it already has,
        // silently and without a native call — see the block comment above
        // isNativeCallGated.
        if (!isProbe && isNativeCallGated(targetLangCode)) return null;

        const retryDelays = retryDelaysFor(targetLangCode);
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
        for (let attempt = 0; attempt <= retryDelays.length; attempt++) {
            try {
                const translated = await callNativeWithTimeout(
                    text,
                    sourceLangCode,
                    targetLangCode,
                    timeoutMs,
                );
                if (translated == null) {
                    logger.warn('[TranslationService] Translation returned no text', {
                        textPreview: text.slice(0, 20),
                        sourceLangCode,
                        targetLangCode,
                        attempt,
                    });
                    // Counts as a failure: the caller gets nothing back, so
                    // repeating it for the next 40 strings helps no one.
                    if (isProbe) probeErrors.set(targetLangCode, 'translator returned no text');
                    recordTranslationFailure(targetLangCode, 'translator returned no text');
                } else {
                    recordTranslationSuccess(targetLangCode);
                }
                return translated;
            } catch (err) {
                if (isProbe) {
                    probeErrors.set(
                        targetLangCode,
                        err instanceof Error ? err.message : String(err),
                    );
                    if (err instanceof TranslationTimeoutError) {
                        probeTimedOut.set(targetLangCode, true);
                    }
                }
                logger.warn('[TranslationService] Translation attempt failed', {
                    textPreview: text.slice(0, 20),
                    sourceLangCode,
                    targetLangCode,
                    attempt,
                    error: err instanceof Error ? err.message : String(err),
                });
                if (attempt < retryDelays.length) {
                    await new Promise<void>((resolve) =>
                        setTimeout(resolve, retryDelays[attempt]),
                    );
                } else {
                    logger.error('[TranslationService] Translation failed', err as Error, {
                        textPreview: text.slice(0, 20),
                        sourceLangCode,
                        targetLangCode,
                    });
                    recordTranslationFailure(
                        targetLangCode,
                        err instanceof Error ? err.message : String(err),
                    );
                    return null;
                }
            }
        }
        return null;
    };

    return enqueueTranslationTask(task, {
        // The probe is epoch-EXEMPT. It holds the queue for up to 90s while
        // Apple's download sheet is up, and a route change is entirely
        // plausible in that window (the picker modal dismissing is one). Drop
        // it and the language never verifies, the gate never opens, and
        // switching language silently stops working — a far worse outcome than
        // one call the user no longer needs.
        epoch: isProbe || options.epochScoped === false ? null : undefined,
        priority: isProbe ? PROBE_PRIORITY : (options.priority ?? 0),
        label: `${targetLangCode}:${text.slice(0, 16)}`,
    }).then(
        (value): TranslationResult => {
            if (isDropped(value)) return { status: 'dropped', text: null };
            return value == null
                ? { status: 'failed', text: null }
                : { status: 'ok', text: value };
        },
        // The task body catches everything already; this is the last net so a
        // caller can never be handed a rejected promise.
        (err): TranslationResult => {
            logger.warn('[TranslationService] Translation task rejected', {
                targetLangCode,
                error: err instanceof Error ? err.message : String(err),
            });
            return { status: 'failed', text: null };
        },
    );
}

/**
 * Translate a single text string. Returns null on failure — AND on a
 * route-change drop, which callers that keep "already tried" state must tell
 * apart (use {@link translateTextDetailed}).
 */
export function translateText(
    text: string,
    targetLangCode: string,
    options: TranslateOptions = {},
): Promise<string | null> {
    return translateTextDetailed(text, targetLangCode, options).then((r) => r.text);
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
