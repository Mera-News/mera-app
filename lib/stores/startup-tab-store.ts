import { create } from 'zustand';
import logger from '@/lib/logger';
import { getSetting, setSetting } from '@/lib/database/services/setting-service';
import {
  STARTUP_TAB_DEFAULT,
  STARTUP_TAB_SETTING_KEY,
  parseStartupTab,
  type StartupTab,
} from '@/lib/navigation/startup-tab';

// Drives the Display screen's "startup tab" picker only. The cold-start
// router does NOT read this store — it reads the setting directly via
// lib/navigation/startup-tab.ts's readStartupTab() to sidestep the
// hydrateAllStores() race (see that module's header comment).

interface StartupTabState {
  startupTab: StartupTab;
  hydrated: boolean;
  hydrate: () => Promise<void>;
  setStartupTab: (tab: StartupTab) => void;
  /** Back to the default, unhydrated. Called from clearAllStores() — the
   *  settings row behind this is dropped with the database, so the in-memory
   *  copy must go too or the next user inherits the previous one's choice. */
  reset: () => void;
}

// Optimistic set + background persist: the screen re-renders on the set()
// alone, so the picker feels instant regardless of DB latency.
function persist(tab: StartupTab) {
  setSetting(STARTUP_TAB_SETTING_KEY, tab).catch((err) =>
    logger.captureException(err, {
      tags: { store: 'startup-tab-store' },
    }),
  );
}

export const useStartupTabStore = create<StartupTabState>()((set) => ({
  startupTab: STARTUP_TAB_DEFAULT,
  hydrated: false,

  reset: () =>
    set({
      startupTab: STARTUP_TAB_DEFAULT,
      hydrated: false,
    }),

  hydrate: async () => {
    try {
      const raw = await getSetting(STARTUP_TAB_SETTING_KEY);
      set({ startupTab: parseStartupTab(raw), hydrated: true });
    } catch (err) {
      logger.captureException(err, {
        tags: { store: 'startup-tab-store' },
      });
      set({ hydrated: true });
    }
  },

  setStartupTab: (tab) => {
    set({ startupTab: tab });
    persist(tab);
  },
}));
