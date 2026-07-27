// opened-stories-store — the in-memory OPENS-ONLY seen set for the two-zone
// feed's dimming affordance. Mirrors `story-impression-service.getOpenedSeenSet`
// (article_id ∪ non-null stable_cluster_id of OPENED rows) but keeps a live copy
// so the feed can dim an "Earlier" row the instant the user opens it, without
// waiting for a DB round-trip. The DB row is still written by the open handler;
// this store is the optimistic read-through mirror.

import { create } from 'zustand';
import { getOpenedSeenBreakdown } from '@/lib/database/services/story-impression-service';
import logger from '@/lib/logger';

interface OpenedStoriesState {
  /** article_id ∪ stable_cluster_id of every opened story. Feeds the Dashboard
   *  read-ticks and the P_SEEN scoring demotion. */
  ids: Set<string>;
  /** article_id ONLY. The Feed uses this rather than `ids` for both its read
   *  indicator and its ingest gate: a `stableClusterId` identifies an ONGOING
   *  story, so matching on it meant reading one article suppressed every future
   *  article in that story for the 30-day impression TTL. */
  articleIds: Set<string>;
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
  articleIds: new Set<string>(),
  hydrated: false,

  hydrate: async () => {
    try {
      const { articleIds, clusterIds } = await getOpenedSeenBreakdown();
      // Merge, don't replace — an optimistic markOpened() may have landed while
      // the DB read was in flight; that add must not be lost.
      const mergedIds = new Set([...articleIds, ...clusterIds]);
      for (const id of get().ids) mergedIds.add(id);
      const mergedArticleIds = new Set(articleIds);
      for (const id of get().articleIds) mergedArticleIds.add(id);
      set({ ids: mergedIds, articleIds: mergedArticleIds, hydrated: true });
    } catch (err) {
      logger.captureException(err, { tags: { store: 'opened-stories-store' } });
      set({ hydrated: true });
    }
  },

  markOpened: (articleId, stableClusterId) => {
    const next = new Set(get().ids);
    if (articleId) next.add(articleId);
    if (stableClusterId) next.add(stableClusterId);
    const nextArticleIds = articleId ? new Set(get().articleIds).add(articleId) : get().articleIds;
    set({ ids: next, articleIds: nextArticleIds });
  },
}));
