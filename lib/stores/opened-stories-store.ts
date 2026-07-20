// opened-stories-store — the in-memory OPENS-ONLY seen set for the two-zone
// feed's dimming affordance. Mirrors `story-impression-service.getOpenedSeenSet`
// (article_id ∪ non-null stable_cluster_id of OPENED rows) but keeps a live copy
// so the feed can dim an "Earlier" row the instant the user opens it, without
// waiting for a DB round-trip. The DB row is still written by the open handler;
// this store is the optimistic read-through mirror.

import { create } from 'zustand';
import { getOpenedSeenSet } from '@/lib/database/services/story-impression-service';
import logger from '@/lib/logger';

interface OpenedStoriesState {
  /** article_id ∪ stable_cluster_id of every opened story. */
  ids: Set<string>;
  /** True once the initial DB read has resolved. */
  hydrated: boolean;
  /** One-shot load from `getOpenedSeenSet`, merged with any ids optimistically
   *  added this session (a mark that raced ahead of hydrate is preserved). */
  hydrate: () => Promise<void>;
  /** Optimistic synchronous add of an opened story's keys (article id + optional
   *  stable cluster id). Safe to call before hydrate — merged on hydrate. */
  markOpened: (articleId: string, stableClusterId?: string | null) => void;
}

export const useOpenedStoriesStore = create<OpenedStoriesState>((set, get) => ({
  ids: new Set<string>(),
  hydrated: false,

  hydrate: async () => {
    try {
      const seen = await getOpenedSeenSet();
      // Merge, don't replace — an optimistic markOpened() may have landed while
      // the DB read was in flight; that add must not be lost.
      const merged = new Set(seen);
      for (const id of get().ids) merged.add(id);
      set({ ids: merged, hydrated: true });
    } catch (err) {
      logger.captureException(err, { tags: { store: 'opened-stories-store' } });
      set({ hydrated: true });
    }
  },

  markOpened: (articleId, stableClusterId) => {
    const next = new Set(get().ids);
    if (articleId) next.add(articleId);
    if (stableClusterId) next.add(stableClusterId);
    set({ ids: next });
  },
}));
