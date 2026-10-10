// The system check: the first-launch stage of AuthScreen (it replaced the bare
// language stage, so it shows once per install) and a Settings entry. It says
// how the app will run on this phone, and makes sure the chosen language is
// one the phone can actually serve.
//
// The friction it removes: a weak phone used to discover Lite-worthy costs by
// stuttering, and a reader whose language pack was missing found out on the
// first article that stayed untranslated. This screen settles both up front.
//
// Pure pieces only; the screen is components/custom/system-check/.

/**
 * The language row. Owner rule: the selected language must be one this phone
 * can translate into, otherwise the reader continues in English. There is no
 * "continue anyway".
 *
 *  - `passed`: English, or the pack was verified by a probe this session.
 *  - `checking`: the startup probe (TranslationUnavailablePrompt) has not
 *    reported yet. This screen never fires a second automatic probe beside it,
 *    since each one may present Apple's download sheet.
 *  - `needs-english`: the probe failed or timed out, or this is a simulator or
 *    emulator, which never translates. Retry or switch to English.
 */
export type LanguageCheck = 'passed' | 'checking' | 'needs-english';

export function languageCheckStatus(input: {
    appLanguage: string;
    verified: boolean;
    blocked: boolean;
    isPhysicalDevice: boolean;
}): LanguageCheck {
    if (input.appLanguage === 'en') return 'passed';
    if (!input.isPhysicalDevice) return 'needs-english';
    if (input.verified) return 'passed';
    if (input.blocked) return 'needs-english';
    return 'checking';
}

/** The phone line, e.g. "Redmi Note 10 Pro, Android 13, 5.7 GB memory". Parts
 *  the OS does not report are left out rather than guessed. */
export function describeDevice(input: {
    modelName: string | null;
    osName: string | null;
    osVersion: string | null;
    totalMemory: number | null;
    memoryLabel: (gb: string) => string;
}): string {
    const parts: string[] = [];
    if (input.modelName) parts.push(input.modelName);
    if (input.osName) parts.push(input.osVersion ? `${input.osName} ${input.osVersion}` : input.osName);
    if (typeof input.totalMemory === 'number' && input.totalMemory > 0) {
        const gb = input.totalMemory / (1024 * 1024 * 1024);
        parts.push(input.memoryLabel(gb >= 10 ? gb.toFixed(0) : gb.toFixed(1)));
    }
    return parts.join(', ');
}
