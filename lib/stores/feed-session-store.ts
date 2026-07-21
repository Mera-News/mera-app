// feed-session-store — the SESSION-scoped (never persisted) order state for the
// Instagram-style vertical Feed tab. It turns the pure `FeedListItem[]` from
// `buildFeedList` into a STABLE scroll order the user reads top-to-bottom.
//
// Design (mirrors the retired swipe-deck-store's snapshot-vs-resume intent, but
// for an append-only scroll list instead of a segmented card deck):
//  • The list is laid out ONCE per session-entry (`rebuild`) into `order`. While
//    the user scrolls it, the layout is FROZEN: freshly-synced / rescored items
//    never reorder rows already in front of the user.
//  • `ingest` refreshes the row data for ids already laid out and APPENDS any
//    genuinely-new ids at the end (sorted among themselves by `feedCompare`). It
//    never removes or reorders an existing entry — a row under the user's eye is
//    never yanked.
//  • On the NEXT tab focus the list RESUMES, unless it should be rebuilt: the
//    order is empty (relaunch), every laid-out row has been verdicted or is no
//    longer a live candidate (fully consumed), or it has been idle > 15 minutes.

import { create } from 'zustand';
import { feedCompare, type FeedListItem } from './feed-list-selector';

export type Verdict = 'like' | 'dislike';

export interface VerdictRecord {
  verdict: Verdict;
  /** The inline-feedback-tree path taken (empty until the tree is used). */
  path: string[];
}

/** Rebuild the list when it has been idle at least this long on re-focus. */
export const FEED_RESNAPSHOT_IDLE_MS = 15 * 60 * 1000;

interface FeedSessionState {
  /** Laid-out list-item ids, top-to-bottom. Append-only within a session. */
  order: string[];
  /** Full row for every id ever laid out this session. */
  itemsById: Record<string, FeedListItem>;
  /** Epoch ms of the last activity (rebuild / ingest / focus). */
  lastActiveAt: number | null;
  /** Session mirror of recorded verdicts, keyed by list-item id. */
  verdicts: Record<string, VerdictRecord>;

  // Actions
  rebuild: (items: FeedListItem[]) => void;
  ingest: (items: FeedListItem[]) => void;
  onTabFocus: (items: FeedListItem[], nowMs?: number) => void;
  setVerdict: (id: string, verdict: Verdict) => void;
  setPath: (id: string, path: string[]) => void;
  reset: () => void;
}

const initialState = {
  order: [] as string[],
  itemsById: {} as Record<string, FeedListItem>,
  lastActiveAt: null as number | null,
  verdicts: {} as Record<string, VerdictRecord>,
};

export const useFeedSessionStore = create<FeedSessionState>()((set, get) => ({
  ...initialState,

  rebuild: (items) => {
    const itemsById: Record<string, FeedListItem> = {};
    for (const it of items) itemsById[it.id] = it;
    set({
      order: items.map((it) => it.id),
      itemsById,
      verdicts: {},
      lastActiveAt: Date.now(),
    });
  },

  ingest: (items) => {
    const state = get();
    const itemsById = { ...state.itemsById };
    const inOrder = new Set(state.order);

    // Refresh known rows in place; collect genuinely-new ids (deduped).
    const newOnes: FeedListItem[] = [];
    const seenNew = new Set<string>();
    for (const it of items) {
      if (inOrder.has(it.id)) {
        itemsById[it.id] = it;
      } else if (!seenNew.has(it.id)) {
        seenNew.add(it.id);
        newOnes.push(it);
      }
    }

    // New ids append at the end, sorted among THEMSELVES by feedCompare — the
    // existing order is left byte-for-byte untouched (never reordered/removed).
    newOnes.sort(feedCompare);
    for (const it of newOnes) itemsById[it.id] = it;
    const order =
      newOnes.length > 0 ? [...state.order, ...newOnes.map((it) => it.id)] : state.order;

    set({ order, itemsById, lastActiveAt: Date.now() });
  },

  onTabFocus: (items, nowMs = Date.now()) => {
    const { order, verdicts, lastActiveAt } = get();
    const isEmpty = order.length === 0;
    const idle = lastActiveAt != null && nowMs - lastActiveAt > FEED_RESNAPSHOT_IDLE_MS;
    // Fully consumed: every laid-out row is either verdicted or no longer a live
    // candidate (viewed / opened / aged out of the freshly-built list).
    const liveIds = new Set(items.map((it) => it.id));
    const allConsumed = order.every((id) => verdicts[id] != null || !liveIds.has(id));

    if (isEmpty || allConsumed || idle) {
      get().rebuild(items);
    } else {
      get().ingest(items);
      set({ lastActiveAt: nowMs });
    }
  },

  setVerdict: (id, verdict) =>
    set((s) => ({
      verdicts: {
        ...s.verdicts,
        [id]: { verdict, path: s.verdicts[id]?.path ?? [] },
      },
    })),

  setPath: (id, path) =>
    set((s) => {
      const current = s.verdicts[id];
      if (!current) return {} as Partial<FeedSessionState>;
      return { verdicts: { ...s.verdicts, [id]: { ...current, path } } };
    }),

  reset: () => set({ ...initialState, itemsById: {}, verdicts: {} }),
}));
