// The app's theme preference, modelled on `app-language-store` (zustand +
// getSetting/setSetting + hydrateFromDb).
//
// TWO FIELDS ON PURPOSE. `preference` is what the user picked; `resolved` is
// what every consumer reads. Through P5 `preference` can only ever be 'light'
// or 'dark', so `resolved === preference` and the indirection looks redundant.
// It earns its keep in P6, which adds 'system' plus the
// `Appearance.addChangeListener` subscription that recomputes `resolved` from
// the OS. Keeping the split from the start means P6 is a store-only change that
// touches no consumer.
//
// NOTHING READS THIS YET. P0 is inert by construction: no picker exists, so
// `preference` never leaves 'dark' and the app is byte-identical. The provider
// starts reading `resolved` in P1.

import { create } from 'zustand';

// REQUIRED LAZILY, NOT IMPORTED. setting-service pulls in lib/database, which
// constructs a real SQLiteAdapter at module load and throws under jest
// ('Cannot read properties of undefined (reading initializeJSI)'). Because
// lib/theme/index.ts imports this store, a top-level import here would drag
// WatermelonDB into every suite that renders a themed component, and P4 puts
// useThemeColors into ~119 files. Keeping the require inside the two async
// functions means importing the theme layer costs nothing.
function settingService() {
  // Deliberate: see the comment above. A static import breaks every themed suite.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('@/lib/database/services/setting-service') as {
    getSetting: (k: string) => Promise<string | null>;
    setSetting: (k: string, v: string) => Promise<void>;
  };
}

export const APP_THEME_KEY = 'app_theme';

export type ThemePreference = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';

/**
 * 'system' is accepted by the store from P0 so the persisted value never has to
 * be migrated, but it cannot be CHOSEN until P6: the iOS `UIUserInterfaceStyle`
 * plist pin blocks `Appearance` from ever reporting anything but dark, so a
 * 'system' option would silently mean 'dark'. The P5 picker offers only
 * light/dark while that pin stands.
 */
function isThemePreference(v: unknown): v is ThemePreference {
  return v === 'light' || v === 'dark' || v === 'system';
}

/**
 * Until P6 there is no OS signal to consult, so 'system' resolves to the
 * default rather than to a value we cannot observe.
 */
export function resolvePreference(preference: ThemePreference): ResolvedTheme {
  return preference === 'system' ? 'dark' : preference;
}

interface ThemeState {
  preference: ThemePreference;
  resolved: ResolvedTheme;
  /** False until hydrateFromDb settles. The P5 picker renders no selection
   *  while this is false, so it cannot briefly show 'dark' selected for a
   *  user whose stored preference is 'light'. */
  hydrated: boolean;
  setPreference: (preference: ThemePreference) => Promise<void>;
  hydrateFromDb: () => Promise<void>;
  reset: () => void;
}

export const useThemeStore = create<ThemeState>((set) => ({
  preference: 'dark',
  resolved: 'dark',
  hydrated: false,

  setPreference: async (preference) => {
    set({ preference, resolved: resolvePreference(preference) });
    try {
      await settingService().setSetting(APP_THEME_KEY, preference);
    } catch {
      // A failed write must not revert what the user just saw. The preference
      // is re-read at next launch; losing it is better than flipping the whole
      // app back under the user's finger.
    }
  },

  hydrateFromDb: async () => {
    try {
      const stored = await settingService().getSetting(APP_THEME_KEY);
      if (isThemePreference(stored)) {
        set({ preference: stored, resolved: resolvePreference(stored), hydrated: true });
        return;
      }
    } catch {
      // Fall through to the default. A theme is not worth failing a launch for.
    }
    set({ hydrated: true });
  },

  reset: () => set({ preference: 'dark', resolved: 'dark', hydrated: false }),
}));
