import { create } from 'zustand';
import { getLocales } from 'expo-localization';
import { getSetting, setSetting } from '@/lib/database/services/setting-service';
import { SUPPORTED_LANGUAGES } from '@/lib/translation-service';
import { applyLanguage } from '@/lib/i18n';

const APP_LANGUAGE_KEY = 'app_language';
const SHOW_ORIGINAL_KEY = 'show_original';

const SUPPORTED_CODES = new Set<string>(SUPPORTED_LANGUAGES.map((l) => l.code));

// Legacy app_language values → iOS translation codes
const LEGACY_CODE_MAP: Record<string, string> = {
    'zh-CN': 'zh-Hans',
    'zh-TW': 'zh-Hant',
    'pt-BR': 'pt',
};

function normalizeCode(raw: string | null | undefined): string | null {
    if (!raw) return null;
    const mapped = LEGACY_CODE_MAP[raw] ?? raw;
    if (SUPPORTED_CODES.has(mapped)) return mapped;
    const prefix = mapped.split('-')[0];
    if (SUPPORTED_CODES.has(prefix)) return prefix;
    return null;
}

function resolveDeviceLocale(): string {
    const locales = getLocales();
    const tag = locales[0]?.languageTag ?? 'en';
    return normalizeCode(tag) ?? 'en';
}

interface AppLanguageState {
    appLanguage: string;
    showOriginal: boolean;

    // Reactive translation cache — keyed by English source text.
    // Cache is flushed whenever appLanguage changes, so no need to key by target.
    cache: Map<string, string>;
    pending: Set<string>;

    setAppLanguage: (lang: string) => Promise<void>;
    setShowOriginal: (value: boolean) => Promise<void>;
    cacheTranslation: (original: string, translated: string) => void;
    addPending: (text: string) => void;
    removePending: (text: string) => void;
    clearCache: () => void;
    hydrateFromDb: () => Promise<void>;
}

export const useAppLanguageStore = create<AppLanguageState>((set, get) => ({
    appLanguage: 'en',
    showOriginal: false,
    cache: new Map(),
    pending: new Set(),

    setAppLanguage: async (lang) => {
        const normalized = normalizeCode(lang) ?? 'en';
        set({ appLanguage: normalized, cache: new Map(), pending: new Set() });
        applyLanguage(normalized);
        await setSetting(APP_LANGUAGE_KEY, normalized);
    },

    setShowOriginal: async (value) => {
        set({ showOriginal: value });
        await setSetting(SHOW_ORIGINAL_KEY, value ? 'true' : 'false');
    },

    cacheTranslation: (original, translated) => {
        const cache = new Map(get().cache);
        cache.set(original, translated);
        const pending = new Set(get().pending);
        pending.delete(original);
        set({ cache, pending });
    },

    addPending: (text) => {
        const pending = new Set(get().pending);
        pending.add(text);
        set({ pending });
    },

    removePending: (text) => {
        const pending = new Set(get().pending);
        pending.delete(text);
        set({ pending });
    },

    clearCache: () => set({ cache: new Map(), pending: new Set() }),

    hydrateFromDb: async () => {
        const [stored, showOriginal] = await Promise.all([
            getSetting(APP_LANGUAGE_KEY),
            getSetting(SHOW_ORIGINAL_KEY),
        ]);
        const normalized = normalizeCode(stored) ?? resolveDeviceLocale();
        set({
            appLanguage: normalized,
            showOriginal: showOriginal === 'true',
        });
        // Persist normalized value back if we migrated a legacy code
        if (stored && stored !== normalized) {
            await setSetting(APP_LANGUAGE_KEY, normalized);
        }
    },
}));

export const useAppLanguage = () => useAppLanguageStore((s) => s.appLanguage);
export const useShowOriginal = () => useAppLanguageStore((s) => s.showOriginal);
