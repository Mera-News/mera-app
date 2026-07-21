// viewed-stories-store — the in-memory ALL-impressions (opened OR merely
// viewed) seen set for the Feed tab's exclusion. Mirrors
// `story-impression-service.getSeenSet` (article_id ∪ non-null
// stable_cluster_id of EVERY impression row) but keeps a live copy so the feed
// can drop a story the instant it's viewed, without waiting for a DB
// round-trip. The DB row is still written by the impression handler; this
// store is the optimistic read-through mirror.
//
// This is a SIBLING of opened-stories-store, not an extension of it:
// opened-stories-store is consumed as opens-only by the Dashboard read-ticks
// and P_SEEN scoring — mixing mere views into that set would silently change
// those semantics (a scrolled-past story would start counting as "read"). Feed
// tab exclusion is scoped to its own store instead.

import { create } from 'zustand';
import { getSeenSet } from '@/lib/database/services/story-impression-service';
import logger from '@/lib/logger';

interface ViewedStoriesState {
  /** article_id ∪ stable_cluster_id of every viewed-or-opened story. */
  ids: Set<string>;
  /** True once the initial DB read has resolved. */
  hydrated: boolean;
  /** One-shot load from `getSeenSet`, merged with any ids optimistically
   *  added this session (a mark that raced ahead of hydrate is preserved). */
  hydrate: () => Promise<void>;
  /** Optimistic synchronous add of a viewed story's keys (article id + optional
   *  stable cluster id). Safe to call before hydrate — merged on hydrate. */
  markViewed: (articleId: string, stableClusterId?: string | null) => void;
}

export const useViewedStoriesStore = create<ViewedStoriesState>((set, get) => ({
  ids: new Set<string>(),
  hydrated: false,

  hydrate: async () => {
    try {
      const seen = await getSeenSet();
      // Merge, don't replace — an optimistic markViewed() may have landed while
      // the DB read was in flight; that add must not be lost.
      const merged = new Set(seen);
      for (const id of get().ids) merged.add(id);
      set({ ids: merged, hydrated: true });
    } catch (err) {
      logger.captureException(err, { tags: { store: 'viewed-stories-store' } });
      set({ hydrated: true });
    }
  },

  markViewed: (articleId, stableClusterId) => {
    const next = new Set(get().ids);
    if (articleId) next.add(articleId);
    if (stableClusterId) next.add(stableClusterId);
    set({ ids: next });
  },
}));
