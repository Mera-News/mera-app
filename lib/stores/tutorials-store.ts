// Tutorial completion state, over the settings KV.
//
// One row per completed chapter (`tutorial_chapter_<slug>_completed`) plus one
// flag for "has opened the menu at least once". Absence is the default — an
// unwritten row means not-completed — so there is nothing to migrate and
// nothing to backfill, and `lib/database/schema.ts` is untouched.
//
// Hydration is ONE `getSettingsByPrefix('tutorial_')` query rather than N
// `getSetting` calls: the caller cannot enumerate which chapters were completed
// up front, so the rows that exist ARE the answer.

import { create } from 'zustand';
import {
  deleteSetting,
  getSettingsByPrefix,
  setSetting,
} from '@/lib/database/services/setting-service';
import logger from '@/lib/logger';

/** Shared prefix for every row this store owns — the hydrate query's argument. */
export const TUTORIAL_SETTING_PREFIX = 'tutorial_';

const MENU_SEEN_KEY = `${TUTORIAL_SETTING_PREFIX}menu_seen`;

/** `tutorial_chapter_<slug>_completed`. Exported for the test and for sweeps. */
export function chapterCompletedKey(chapterId: string): string {
  return `${TUTORIAL_SETTING_PREFIX}chapter_${chapterId}_completed`;
}

/** Inverse of {@link chapterCompletedKey}; `null` for any other row. */
export function chapterIdFromKey(key: string): string | null {
  const prefix = `${TUTORIAL_SETTING_PREFIX}chapter_`;
  const suffix = '_completed';
  if (!key.startsWith(prefix) || !key.endsWith(suffix)) return null;
  const id = key.slice(prefix.length, key.length - suffix.length);
  return id.length > 0 ? id : null;
}

interface TutorialsState {
  /** Chapter ids the user has finished. Membership is the whole truth. */
  completed: ReadonlySet<string>;
  /** Has the menu been opened once? Drives the "new" dot on the Settings row. */
  menuSeen: boolean;
  hydrated: boolean;

  hydrate: () => Promise<void>;
  markCompleted: (chapterId: string) => void;
  markMenuSeen: () => void;
  /** Back to zero, unhydrated. Called from `clearAllStores()` on logout. */
  reset: () => void;
}

const initialState = {
  completed: new Set<string>() as ReadonlySet<string>,
  menuSeen: false,
  hydrated: false,
};

// Optimistic set + background persist, same shape as the other settings-KV
// stores: the menu re-renders off the set() alone, so a tick appears the instant
// a chapter ends regardless of DB latency.
function persist(key: string, value: string): void {
  setSetting(key, value).catch((err) =>
    logger.captureException(err, { tags: { store: 'tutorials-store' } }),
  );
}

export const useTutorialsStore = create<TutorialsState>()((set, get) => ({
  ...initialState,

  reset: () => set({ ...initialState, completed: new Set<string>() }),

  hydrate: async () => {
    try {
      const rows = await getSettingsByPrefix(TUTORIAL_SETTING_PREFIX);
      const completed = new Set<string>();
      for (const [key, value] of Object.entries(rows)) {
        if (value !== 'true') continue;
        const chapterId = chapterIdFromKey(key);
        if (chapterId) completed.add(chapterId);
      }
      set({
        completed,
        menuSeen: rows[MENU_SEEN_KEY] === 'true',
        hydrated: true,
      });
    } catch (err) {
      logger.captureException(err, { tags: { store: 'tutorials-store' } });
      // Still flip `hydrated`: a failed read must not leave the menu spinning
      // forever. Worst case the user sees zero ticks and re-watches a chapter.
      set({ hydrated: true });
    }
  },

  markCompleted: (chapterId) => {
    if (get().completed.has(chapterId)) return;
    const next = new Set(get().completed);
    next.add(chapterId);
    set({ completed: next });
    persist(chapterCompletedKey(chapterId), 'true');
  },

  markMenuSeen: () => {
    if (get().menuSeen) return;
    set({ menuSeen: true });
    persist(MENU_SEEN_KEY, 'true');
  },
}));

/**
 * Drop every tutorial row. NOT wired into logout — `clearAllStores()` already
 * resets the whole database — it exists for the "reset my progress" affordance
 * and so a future sweep has one place to call.
 */
export async function clearTutorialProgress(): Promise<void> {
  const rows = await getSettingsByPrefix(TUTORIAL_SETTING_PREFIX);
  await Promise.all(Object.keys(rows).map((key) => deleteSetting(key)));
  useTutorialsStore.getState().reset();
}
