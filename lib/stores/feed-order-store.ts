// feed-order-store — the PERSISTED order state for the "For you" vertical Feed
// tab. It turns the pure `FeedListItem[]` from `buildFeedList` into a STABLE
// scroll order the user reads top-to-bottom, and it survives app restarts.
//
// Design (static insert-only — r6 P2):
//  • The list is built ONCE, the first time it is non-empty (first launch /
//    post-wipe), and is NEVER fully rebuilt afterwards — not on tab focus, not
//    on idle, not on pull-to-refresh. `order` (+ `builtAt`) is persisted as a
//    settings-KV JSON blob so the order is identical across restarts.
//  • As suggestions newly reach status Complete they are INSERTED, never
//    reordered: everything up through the freeze boundary (current max visible
//    index + 2) is frozen; each genuinely-new item is insertion-sorted into the
//    tail beyond that boundary by the composite `feedCompare` score. Cards in the
//    frozen prefix (and read/opened cards anywhere) never move.
//  • The ONLY removal point is `hydrate`, which evicts persisted ids that no
//    longer have a backing item in the live candidate pool (retention purge /
//    24h-window ageing between sessions). Viewed (opened) stories are NEVER
//    removed — the Feed screen relocates them below the "All Caught Up" divider
//    at render time (see components/custom/feed/feed-entries.ts).

import { create } from 'zustand';
import logger from '@/lib/logger';
import {
  getSetting,
  setSetting,
  deleteSetting,
} from '@/lib/database/services/setting-service';
import { feedCompare, type FeedListItem } from './feed-list-selector';
import { isSuggestionOpened } from './fact-rows-selector';

export type Verdict = 'like' | 'dislike';

export interface VerdictRecord {
  verdict: Verdict;
  /** The inline-feedback-tree path taken (empty until the tree is used). */
  path: string[];
}

/** Settings-KV key the persisted `{ order, builtAt }` blob lives under. */
export const FEED_ORDER_SETTING_KEY = 'feed_order_v1';

interface FeedOrderState {
  /** Laid-out list-item ids, top-to-bottom. PERSISTED. Insert-only within and
   *  across sessions; entries are removed only by `hydrate`'s eviction pass. */
  order: string[];
  /** Full row for every live id in `order` (session-only, rebuilt on hydrate). */
  itemsById: Record<string, FeedListItem>;
  /** Epoch ms of the first non-empty build (persisted alongside `order`). */
  builtAt: number | null;
  /** True once the initial KV read + eviction pass has resolved. */
  hydrated: boolean;
  /** Recorded verdicts, keyed by list-item id (session-only). */
  verdicts: Record<string, VerdictRecord>;

  // Actions
  hydrate: (items: FeedListItem[]) => Promise<void>;
  ingest: (
    items: FeedListItem[],
    openedIds: Set<string>,
    frozenThroughIndex: number,
  ) => void;
  setVerdict: (id: string, verdict: Verdict) => void;
  /** Drop a verdict (+ its tree path) — the un-vote path. No-op if absent. */
  clearVerdict: (id: string) => void;
  setPath: (id: string, path: string[]) => void;
  reset: () => void;
}

const initialState = {
  order: [] as string[],
  itemsById: {} as Record<string, FeedListItem>,
  builtAt: null as number | null,
  hydrated: false,
  verdicts: {} as Record<string, VerdictRecord>,
};

interface PersistedOrder {
  order: string[];
  builtAt: number | null;
}

function parsePersisted(raw: string | null): PersistedOrder {
  if (!raw) return { order: [], builtAt: null };
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && Array.isArray(parsed.order)) {
      return {
        order: parsed.order.filter((x: unknown): x is string => typeof x === 'string'),
        builtAt: typeof parsed.builtAt === 'number' ? parsed.builtAt : null,
      };
    }
    return { order: [], builtAt: null };
  } catch {
    return { order: [], builtAt: null };
  }
}

function persist(order: string[], builtAt: number | null): void {
  setSetting(FEED_ORDER_SETTING_KEY, JSON.stringify({ order, builtAt })).catch((err) =>
    logger.captureException(err, { tags: { store: 'feed-order-store' } }),
  );
}

/** The representative's top stable cluster id (the rep-switch dedupe key), or
 *  null when the story has no stable cluster. */
function stableClusterIdOf(item: FeedListItem): string | null {
  return item.suggestion.clusters?.find((c) => c.stableClusterId)?.stableClusterId ?? null;
}

/** Module-level in-flight hydrate guard — the two feed tabs stay mounted under
 *  NativeTabs, so both can fire the hydrate effect; only one read runs. */
let hydrating: Promise<void> | null = null;

export const useFeedOrderStore = create<FeedOrderState>()((set, get) => ({
  ...initialState,

  hydrate: async (items) => {
    if (get().hydrated) return;
    if (hydrating) return hydrating;
    hydrating = (async () => {
      try {
        const raw = await getSetting(FEED_ORDER_SETTING_KEY);
        const parsed = parsePersisted(raw);

        // The ONLY eviction point: keep a persisted id only if it still has a
        // backing item in the live candidate pool (a purged / aged-out story is
        // dropped here). Survivors keep their persisted order + fresh row data.
        const backing = new Map(items.map((it) => [it.id, it]));
        const survivors: string[] = [];
        const itemsById: Record<string, FeedListItem> = {};
        for (const id of parsed.order) {
          const item = backing.get(id);
          if (item) {
            survivors.push(id);
            itemsById[id] = item;
          }
        }

        set({
          order: survivors,
          itemsById,
          builtAt: parsed.builtAt,
          hydrated: true,
        });
      } catch (err) {
        logger.captureException(err, { tags: { store: 'feed-order-store' } });
        set({ hydrated: true });
      } finally {
        hydrating = null;
      }
    })();
    return hydrating;
  },

  ingest: (items, openedIds, frozenThroughIndex) => {
    const state = get();
    if (!state.hydrated) return; // no-op until the persisted order is loaded

    const order = [...state.order];
    const itemsById = { ...state.itemsById };
    const inOrder = new Set(order);

    // Map each already-laid-out story's stable cluster id → its order id, so a
    // grown cluster fronting a NEW representative article updates the existing
    // entry in place instead of appearing as a duplicate card.
    const clusterToOrderId = new Map<string, string>();
    for (const id of order) {
      const existing = itemsById[id];
      if (!existing) continue;
      const scid = stableClusterIdOf(existing);
      if (scid) clusterToOrderId.set(scid, id);
    }

    // First pass: refresh known rows in place; resolve rep-switches in place;
    // collect the genuinely-new, not-opened items.
    const newOnes: FeedListItem[] = [];
    const seenNew = new Set<string>();
    for (const it of items) {
      if (inOrder.has(it.id)) {
        // Known row — refresh its data, never reorder.
        itemsById[it.id] = it;
        continue;
      }
      const scid = stableClusterIdOf(it);
      if (scid && clusterToOrderId.has(scid)) {
        // Rep-switch: same story, new representative article. Keep the OLD order
        // id (position frozen) but store the fresh row under it, overriding the
        // item's id so the order array + verdict/dim keying stay stable.
        const oldId = clusterToOrderId.get(scid)!;
        itemsById[oldId] = { ...it, id: oldId };
        continue;
      }
      // Genuinely new. Opened stories are never inserted (read = tapped, and a
      // read story should not resurface as a fresh card).
      if (isSuggestionOpened(it.suggestion, openedIds)) continue;
      if (seenNew.has(it.id)) continue;
      seenNew.add(it.id);
      newOnes.push(it);
    }

    // Insertion-sort each new item (best-first) into the unfrozen tail. Existing
    // entries never move relative to each other; indices ≤ frozenThroughIndex
    // never shift. An order id with no backing item ranks lowest (insert before).
    newOnes.sort(feedCompare);
    for (const it of newOnes) {
      itemsById[it.id] = it;
      const start = Math.min(Math.max(frozenThroughIndex + 1, 0), order.length);
      let insertAt = order.length;
      for (let i = start; i < order.length; i++) {
        const existing = itemsById[order[i]];
        if (!existing || feedCompare(it, existing) < 0) {
          insertAt = i;
          break;
        }
      }
      order.splice(insertAt, 0, it.id);
    }

    const orderChanged =
      order.length !== state.order.length ||
      order.some((id, i) => id !== state.order[i]);
    let builtAt = state.builtAt;
    if (builtAt === null && order.length > 0) builtAt = Date.now();

    set({ order, itemsById, builtAt });
    if (orderChanged || builtAt !== state.builtAt) persist(order, builtAt);
  },

  setVerdict: (id, verdict) =>
    set((s) => ({
      verdicts: {
        ...s.verdicts,
        [id]: { verdict, path: s.verdicts[id]?.path ?? [] },
      },
    })),

  clearVerdict: (id) =>
    set((s) => {
      if (!s.verdicts[id]) return {} as Partial<FeedOrderState>;
      const next = { ...s.verdicts };
      delete next[id];
      return { verdicts: next };
    }),

  setPath: (id, path) =>
    set((s) => {
      const current = s.verdicts[id];
      if (!current) return {} as Partial<FeedOrderState>;
      return { verdicts: { ...s.verdicts, [id]: { ...current, path } } };
    }),

  reset: () => {
    set({ ...initialState, itemsById: {}, verdicts: {} });
    deleteSetting(FEED_ORDER_SETTING_KEY).catch((err) =>
      logger.captureException(err, { tags: { store: 'feed-order-store' } }),
    );
  },
}));
