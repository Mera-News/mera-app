import { create } from 'zustand';
import logger from '@/lib/logger';
import { getSetting, setSetting } from '@/lib/database/services/setting-service';
import {
  DEFAULT_DASHBOARD_IMPORTANCE_THRESHOLD,
  DEFAULT_FEED_IMPORTANCE_THRESHOLD,
  parseImportanceThreshold,
  type ImportanceThreshold,
} from '@/lib/feed-ordering/importance-filter';

const FEED_KEY = 'feed_importance_filter';
const DASHBOARD_KEY = 'dashboard_importance_filter';

interface ImportanceFilterState {
  /** Minimum story band the Feed list shows. Default 'medium'. */
  feedThreshold: ImportanceThreshold;
  /** Minimum story band the Dashboard sections show. Default 'low' — i.e.
   *  everything, the pre-filter behavior. Persisted separately from the Feed
   *  so tightening one screen never starves the other. */
  dashboardThreshold: ImportanceThreshold;
  hydrated: boolean;
  hydrate: () => Promise<void>;
  setFeedThreshold: (threshold: ImportanceThreshold) => void;
  setDashboardThreshold: (threshold: ImportanceThreshold) => void;
}

// Optimistic set + background persist: the screens re-filter on the set()
// alone, so the pills feel instant regardless of DB latency.
function persist(key: string, threshold: ImportanceThreshold) {
  setSetting(key, threshold).catch((err) =>
    logger.captureException(err, {
      tags: { store: 'importance-filter-store' },
    }),
  );
}

export const useImportanceFilterStore = create<ImportanceFilterState>()(
  (set) => ({
    feedThreshold: DEFAULT_FEED_IMPORTANCE_THRESHOLD,
    dashboardThreshold: DEFAULT_DASHBOARD_IMPORTANCE_THRESHOLD,
    hydrated: false,

    hydrate: async () => {
      try {
        const [feedRaw, dashboardRaw] = await Promise.all([
          getSetting(FEED_KEY),
          getSetting(DASHBOARD_KEY),
        ]);
        set({
          feedThreshold: parseImportanceThreshold(
            feedRaw,
            DEFAULT_FEED_IMPORTANCE_THRESHOLD,
          ),
          dashboardThreshold: parseImportanceThreshold(
            dashboardRaw,
            DEFAULT_DASHBOARD_IMPORTANCE_THRESHOLD,
          ),
          hydrated: true,
        });
      } catch (err) {
        logger.captureException(err, {
          tags: { store: 'importance-filter-store' },
        });
        set({ hydrated: true });
      }
    },

    setFeedThreshold: (threshold) => {
      set({ feedThreshold: threshold });
      persist(FEED_KEY, threshold);
    },

    setDashboardThreshold: (threshold) => {
      set({ dashboardThreshold: threshold });
      persist(DASHBOARD_KEY, threshold);
    },
  }),
);
