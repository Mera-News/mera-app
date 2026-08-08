import { create } from 'zustand';
import { getLocales } from 'expo-localization';
import { getSetting, setSetting } from '@/lib/database/services/setting-service';
import {
    loadTranslationCache,
    rememberTranslation,
    sweepTranslationCache,
} from '@/lib/database/services/translation-cache-service';
import { clearTranslationFailuresFor, SUPPORTED_LANGUAGES } from '@/lib/translation-service';
import { bumpTranslationEpoch } from '@/lib/translation-queue';
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
    // Cache is flushed whenever appLanguage changes, so no need to key by target
    // IN MEMORY. The persisted mirror (`translation_cache`, schema v49) IS keyed
    // by (source hash, target lang), and a language switch reloads this Map from
    // it rather than leaving it empty — see hydrateTranslationCache.
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
    /**
     * Load the persisted translations for `lang` (default: the current app
     * language) off disk and into the in-memory cache. No-op for English.
     */
    hydrateTranslationCache: (lang?: string) => Promise<void>;
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
        // Retire every native call queued for the language being left. They
        // cannot be cancelled once dispatched (the completion handler in
        // TranslatableDynamic discards those), but the queued ones are pure
        // waste and they sit in front of the re-translation of the screen the
        // user is looking at. The availability probe is epoch-exempt, so the
        // one call that verifies the NEW language is untouched.
        bumpTranslationEpoch(`language:${normalized}`);
        // …then refill from disk for the language being ADOPTED. This is what
        // makes switching back to a language you have used before instant
        // instead of a full re-translation of every headline on screen, one
        // serial native call at a time. Fire-and-forget: the UI language change
        // must not wait on SQLite, and an empty cache is merely slow.
        void get()
            .hydrateTranslationCache(normalized)
            .catch(() => {
                // never block a language change on the cache
            });
        // Picking a language is a deliberate user action — give the new one a
        // clean slate. Scoped to the language being ADOPTED, not the whole
        // map: the language being left keeps its breaker state, so a failed
        // switch that reverts here lands the user back exactly where they
        // were, rather than silently re-arming a language already known to be
        // broken.
        clearTranslationFailuresFor(normalized);
        applyLanguage(normalized);
        await setSetting(APP_LANGUAGE_KEY, normalized);

        // One-way sync: push the picked UI language into the persona's
        // language_codes as the primary code (preserving any others). Dynamic
        // require avoids a static store→services import cycle; fire-and-forget
        // + internal error-swallowing so the sync never blocks the UI change.
        try {
            const { syncAppLanguageToPersona } = require('@/lib/language-sync');
            void syncAppLanguageToPersona(normalized);
        } catch {
            // never block the local UI language change on the sync path
        }
    },

    cacheTranslation: (original, translated) => {
        // Mutate the existing Map/Set in place — no new references — then bump
        // cacheVersion so zustand notifies. Exactly one bump per call.
        const { cache, pending, appLanguage } = get();
        cache.set(original, translated);
        pending.delete(original);
        set({ cacheVersion: get().cacheVersion + 1 });
        // Persist. Buffered + debounced inside the service, so a fast scroll
        // that completes dozens of translations still costs ONE SQLite
        // transaction. This is the single funnel every completed translation
        // passes through, which is why it is the only place that writes.
        try {
            rememberTranslation(original, appLanguage, translated);
        } catch {
            // a cache write must never break the render path that produced it
        }
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

    hydrateTranslationCache: async (lang) => {
        const target = lang ?? get().appLanguage;
        if (!target || target === 'en') return;
        const loaded = await loadTranslationCache(target);
        if (loaded.size === 0) return;
        // Only apply if the user has not switched languages underneath us —
        // otherwise a slow load for the language they just left would repopulate
        // the cache with translations into the wrong language, and every keyed
        // read would silently hit them.
        if (get().appLanguage !== target) return;
        // Replace the reference (a bulk load is a full invalidation, not an
        // append), and carry over anything translated while the load was in
        // flight — those are newer than what came off disk.
        const merged = new Map(loaded);
        for (const [key, value] of get().cache) merged.set(key, value);
        set({ cache: merged, cacheVersion: get().cacheVersion + 1 });
    },

    hydrateFromDb: async () => {
        const stored = await getSetting(APP_LANGUAGE_KEY);
        const normalized = normalizeCode(stored) ?? resolveDeviceLocale();
        set({ appLanguage: normalized });
        // Persist normalized value back if we migrated a legacy code
        if (stored && stored !== normalized) {
            await setSetting(APP_LANGUAGE_KEY, normalized);
        }

        // Load the persisted translations for this language BEFORE returning.
        // TranslatableDynamic reads the cache synchronously during render, so a
        // node that renders ahead of the hydrate still fires a native call —
        // awaiting here is what turns the second launch into zero native calls.
        // It is one indexed query and it does not gate first paint (the feed
        // hydrate runs ahead of every other store).
        await get().hydrateTranslationCache(normalized);

        // Bounded, once per launch, after the useful work: every headline ×
        // every language ever seen is a leak, not a cache. Fire-and-forget.
        void sweepTranslationCache().catch(() => {
            // sweeping is best-effort housekeeping
        });

        // NO native call here. Re-verifying the saved language is deliberately
        // NOT done during boot hydration — see the once-per-launch probe in
        // components/custom/TranslationUnavailablePrompt.tsx, which waits for
        // the app to be mounted and idle first, because that call can present
        // Apple's system sheet.
    },
}));

export const useAppLanguage = () => useAppLanguageStore((s) => s.appLanguage);
