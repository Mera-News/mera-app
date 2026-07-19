import { create } from 'zustand';
import { getLocales } from 'expo-localization';
import { getSetting, setSetting } from '@/lib/database/services/setting-service';
import { SUPPORTED_LANGUAGES } from '@/lib/translation-service';
import { applyLanguage } from '@/lib/i18n';

const APP_LANGUAGE_KEY = 'app_language';

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

    // Reactive translation cache — keyed by English source text.
    // Cache is flushed whenever appLanguage changes, so no need to key by target.
    //
    // WHY in-place mutation + cacheVersion: the cache is mutated in place (NOT
    // cloned) on every translation completion, and `cacheVersion` is bumped so
    // zustand notifies subscribers. Consumers MUST subscribe per-key
    // (`useAppLanguageStore((s) => s.cache.get(myText))`) — the per-key selector
    // + Object.is means only the node whose key just landed re-renders, instead
    // of every mounted TranslatableDynamic re-rendering on every translation
    // anywhere. CONTRACT: never snapshot the Map for diffing (e.g.
    // `const prev = s.cache; ...later... prev !== s.cache`) — the reference is
    // stable across cache writes, so a snapshot would never register a change.
    // Read via `.get(key)`; treat the Map as append-only until a full
    // invalidation (setAppLanguage / clearCache) replaces the reference.
    cache: Map<string, string>;
    pending: Set<string>;
    // Monotonic counter bumped on every in-place cache/pending mutation so
    // zustand re-runs selectors (the Map/Set references stay stable).
    cacheVersion: number;

    setAppLanguage: (lang: string) => Promise<void>;
    cacheTranslation: (original: string, translated: string) => void;
    addPending: (text: string) => void;
    removePending: (text: string) => void;
    clearCache: () => void;
    hydrateFromDb: () => Promise<void>;
}

export const useAppLanguageStore = create<AppLanguageState>((set, get) => ({
    appLanguage: 'en',
    cache: new Map(),
    pending: new Set(),
    cacheVersion: 0,

    setAppLanguage: async (lang) => {
        const normalized = normalizeCode(lang) ?? 'en';
        // Full invalidation: replace the Map/Set references (a language switch
        // means every cached translation is now stale).
        set({ appLanguage: normalized, cache: new Map(), pending: new Set() });
        applyLanguage(normalized);
        await setSetting(APP_LANGUAGE_KEY, normalized);
    },

    cacheTranslation: (original, translated) => {
        // Mutate the existing Map/Set in place — no new references — then bump
        // cacheVersion so zustand notifies. Exactly one bump per call.
        const { cache, pending } = get();
        cache.set(original, translated);
        pending.delete(original);
        set({ cacheVersion: get().cacheVersion + 1 });
    },

    addPending: (text) => {
        get().pending.add(text);
        set({ cacheVersion: get().cacheVersion + 1 });
    },

    removePending: (text) => {
        get().pending.delete(text);
        set({ cacheVersion: get().cacheVersion + 1 });
    },

    // Full invalidation: replace the Map/Set references.
    clearCache: () => set({ cache: new Map(), pending: new Set() }),

    hydrateFromDb: async () => {
        const stored = await getSetting(APP_LANGUAGE_KEY);
        const normalized = normalizeCode(stored) ?? resolveDeviceLocale();
        set({ appLanguage: normalized });
        // Persist normalized value back if we migrated a legacy code
        if (stored && stored !== normalized) {
            await setSetting(APP_LANGUAGE_KEY, normalized);
        }
    },
}));

export const useAppLanguage = () => useAppLanguageStore((s) => s.appLanguage);
