// Languages this DEVICE has translated into, in any launch.
//
// The friction it removes: the native-call gate keys off an in-memory set, so
// every launch starts with every language unverified, and a launch re-verify
// that fails (the bridge sick at boot, healthy a minute later) used to leave
// the language gated for the whole session with nothing to recover it. A
// language that has translated on this phone before had its pack installed,
// so the service may treat that launch failure as an ordinary breaker block
// and quietly re-verify it on a backoff.
//
// DEVICE-LEVEL, like the Lite mode override (lib/performance/performance-mode):
// AsyncStorage, not the per-account WatermelonDB settings, not backed up. The
// pack lives on the phone whoever is signed in. A sync read answers from the
// last load; the service loads it at import.

import AsyncStorage from '@react-native-async-storage/async-storage';

export const DEVICE_VERIFIED_LANGUAGES_KEY = 'translation_device_verified_languages';

let languages = new Set<string>();

export async function loadDeviceVerifiedLanguages(): Promise<void> {
    try {
        const raw = await AsyncStorage.getItem(DEVICE_VERIFIED_LANGUAGES_KEY);
        const parsed: unknown = raw ? JSON.parse(raw) : [];
        languages = new Set(Array.isArray(parsed) ? parsed.filter((c): c is string => typeof c === 'string') : []);
    } catch {
        languages = new Set();
    }
}

export function isDeviceVerifiedLanguage(code: string): boolean {
    return languages.has(code);
}

function persist(): void {
    void AsyncStorage.setItem(DEVICE_VERIFIED_LANGUAGES_KEY, JSON.stringify([...languages])).catch(() => {
        // a lost write costs one launch's recovery, never a translation
    });
}

export function markDeviceVerifiedLanguage(code: string): void {
    if (languages.has(code)) return;
    languages.add(code);
    persist();
}

export function clearDeviceVerifiedLanguage(code: string): void {
    if (!languages.delete(code)) return;
    persist();
}

/** Test seam: forget the in-memory copy (storage is the test harness's to clear). */
export function __resetDeviceVerifiedLanguagesForTests(): void {
    languages = new Set();
}
