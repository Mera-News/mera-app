import { create } from 'zustand';
import { getSetting, setSetting } from '@/lib/database/services/setting-service';

const APP_THEME_KEY = 'app_theme';

export type ThemePreference = 'light' | 'dark' | 'system';

function normalizePreference(raw: string | null | undefined): ThemePreference {
    return raw === 'light' || raw === 'system' ? raw : 'dark';
}

interface ThemeState {
    // 'dark' default preserves the current look for existing users and the
    // first frame before hydration lands (no wrong-theme flash for them).
    preference: ThemePreference;
    hydrated: boolean;

    setPreference: (preference: ThemePreference) => Promise<void>;
    hydrateFromDb: () => Promise<void>;
}

export const useThemeStore = create<ThemeState>((set) => ({
    preference: 'dark',
    hydrated: false,

    setPreference: async (preference) => {
        set({ preference });
        await setSetting(APP_THEME_KEY, preference);
    },

    hydrateFromDb: async () => {
        const stored = await getSetting(APP_THEME_KEY);
        set({ preference: normalizePreference(stored), hydrated: true });
    },
}));

export const useThemePreference = () => useThemeStore((s) => s.preference);
