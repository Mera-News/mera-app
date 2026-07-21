// swipe-deck-store — the SESSION-scoped (never persisted) layout state for the
// Feed-tab swipe deck. It turns the pure `SwipeDeckCandidate[]` from
// `buildSwipeStack` into a STATIC SEGMENTED DECK the user swipes through.
//
// Design (USER DECISIONS, Round-4 P2):
//  • The deck is laid out ONCE per session-entry (`snapshot`) into `order` — a
//    flat list of card ids terminated by a caught-up SENTINEL. While the user is
//    viewing it the layout is FROZEN: freshly-synced/rescored candidates never
//    reshuffle the cards already in front of the user. New candidate ids collect
//    in `pendingBuffer` instead.
//  • Each SENTINEL closes a SEGMENT. When the user advances PAST a sentinel the
//    buffered candidates are finalized — sorted with `deckCompare` at that
//    moment — and appended as the NEXT segment, followed by a fresh sentinel.
//    Crossing the final sentinel with an empty buffer drops into the end state.
//  • On the NEXT tab entry the deck RESUMES its position, unless it should be
//    re-snapshotted: the store is empty (app relaunch), the deck is exhausted
//    (cursor past the end), or it has been idle for > 15 minutes.
//  • Undealt-card removal: an `ingest` drops ids AFTER the cursor that are no
//    longer candidates (e.g. opened on another surface) — but never a dealt
//    (≤ cursor) entry and never a sentinel, so the card under the user's thumb
//    is never yanked and history stays intact for Back.

import { create } from 'zustand';
import { deckCompare, type SwipeDeckCandidate } from './swipe-stack-selector';

/** The end-of-segment marker inserted into `order`. Never collides with a real
 *  card id (article ids are Mongo ObjectIds / UUIDs). */
export const CAUGHT_UP_SENTINEL = '__caught_up__';

/** Re-snapshot the deck when it has been idle at least this long on re-entry. */
export const RESNAPSHOT_IDLE_MS = 15 * 60 * 1000;

export type Verdict = 'like' | 'dislike';

export interface VerdictRecord {
  verdict: Verdict;
  /** The inline-feedback-tree path taken (P4 populates; empty for quick swipes). */
  path: string[];
}

interface SwipeDeckState {
  /** Laid-out card ids + `CAUGHT_UP_SENTINEL` segment terminators. */
  order: string[];
  /** Index into `order` of the top (currently-viewed) entry. */
  cursor: number;
  /** True once a deck has been laid out — the layout is frozen against reshuffle. */
  frozen: boolean;
  /** New candidate ids not yet laid out; finalized into the next segment on
   *  crossing a sentinel. */
  pendingBuffer: string[];
  /** Session mirror of recorded verdicts, keyed by card id (drives Back-editing). */
  verdicts: Record<string, VerdictRecord>;
  /** Epoch ms of the last activity (snapshot / advance / goBack / focus). */
  lastActiveAt: number | null;
  /** Full candidate row for every id ever seen this session (deck + buffer). */
  cardsById: Record<string, SwipeDeckCandidate>;

  // Actions
  snapshot: (candidates: SwipeDeckCandidate[]) => void;
  ingest: (candidates: SwipeDeckCandidate[]) => void;
  onTabFocus: (candidates: SwipeDeckCandidate[], nowMs?: number) => void;
  advance: () => void;
  goBack: () => void;
  setVerdict: (id: string, verdict: Verdict) => void;
  setPath: (id: string, path: string[]) => void;
  clearVerdict: (id: string) => void;
  reset: () => void;
}

const initialState = {
  order: [] as string[],
  cursor: 0,
  frozen: false,
  pendingBuffer: [] as string[],
  verdicts: {} as Record<string, VerdictRecord>,
  lastActiveAt: null as number | null,
  cardsById: {} as Record<string, SwipeDeckCandidate>,
};

function indexById(candidates: SwipeDeckCandidate[]): Record<string, SwipeDeckCandidate> {
  const map: Record<string, SwipeDeckCandidate> = {};
  for (const c of candidates) map[c.id] = c;
  return map;
}

export const useSwipeDeckStore = create<SwipeDeckState>()((set, get) => ({
  ...initialState,

  snapshot: (candidates) => {
    const order = candidates.map((c) => c.id);
    // Only terminate a NON-empty deck with a sentinel — an empty snapshot leaves
    // `order` empty so the screen shows its empty-state chain (preparing /
    // no-interests / caught-up) rather than a lone caught-up card.
    if (candidates.length > 0) order.push(CAUGHT_UP_SENTINEL);
    set({
      order,
      cursor: 0,
      frozen: true,
      pendingBuffer: [],
      verdicts: {},
      cardsById: indexById(candidates),
      lastActiveAt: Date.now(),
    });
  },

  ingest: (candidates) => {
    const state = get();
    const cardsById = { ...state.cardsById };
    const candSet = new Set<string>();
    for (const c of candidates) {
      cardsById[c.id] = c;
      candSet.add(c.id);
    }

    // Deck never laid out (fresh snapshot produced nothing) — lay these out now
    // instead of stranding them in the buffer with no sentinel to cross.
    if (state.order.length === 0) {
      if (candidates.length === 0) {
        set({ cardsById });
        return;
      }
      set({
        order: [...candidates.map((c) => c.id), CAUGHT_UP_SENTINEL],
        cursor: 0,
        frozen: true,
        pendingBuffer: [],
        cardsById,
        lastActiveAt: Date.now(),
      });
      return;
    }

    // FROZEN deck. 1) Drop undealt (index > cursor) entries that are no longer
    // candidates — but never a dealt (≤ cursor) entry and never a sentinel.
    const newOrder = state.order.filter(
      (entry, i) => i <= state.cursor || entry === CAUGHT_UP_SENTINEL || candSet.has(entry),
    );

    // 2) New candidate ids not present anywhere (order or buffer) → buffer.
    //    Also drop already-buffered ids that are no longer candidates.
    const present = new Set(newOrder);
    const buffer = state.pendingBuffer.filter((id) => candSet.has(id));
    const bufferSet = new Set(buffer);
    for (const c of candidates) {
      if (!present.has(c.id) && !bufferSet.has(c.id)) {
        buffer.push(c.id);
        bufferSet.add(c.id);
      }
    }

    set({ order: newOrder, pendingBuffer: buffer, cardsById });
  },

  onTabFocus: (candidates, nowMs = Date.now()) => {
    const { order, cursor, lastActiveAt } = get();
    const isEmpty = order.length === 0;
    const exhausted = cursor >= order.length; // advanced past the final sentinel
    const idle = lastActiveAt != null && nowMs - lastActiveAt > RESNAPSHOT_IDLE_MS;
    if (isEmpty || exhausted || idle) {
      get().snapshot(candidates);
    } else {
      // Resume — keep position, but pick up new cards + drop undealt removals.
      get().ingest(candidates);
      set({ lastActiveAt: nowMs });
    }
  },

  advance: () => {
    const { order, cursor, pendingBuffer, cardsById } = get();
    const current = order[cursor];

    if (current === CAUGHT_UP_SENTINEL) {
      // Crossing a sentinel finalizes the buffered candidates into the next
      // segment (sorted with deckCompare at THIS moment) + a fresh sentinel.
      if (pendingBuffer.length > 0) {
        const segment = pendingBuffer
          .map((id) => cardsById[id])
          .filter((c): c is SwipeDeckCandidate => !!c)
          .sort(deckCompare);
        const segIds = segment.map((c) => c.id);
        set({
          order: [...order, ...segIds, CAUGHT_UP_SENTINEL],
          cursor: cursor + 1,
          pendingBuffer: [],
          lastActiveAt: Date.now(),
        });
      } else {
        // Empty buffer — advance past the final sentinel into the end state.
        set({ cursor: cursor + 1, lastActiveAt: Date.now() });
      }
      return;
    }

    set({ cursor: Math.min(cursor + 1, order.length), lastActiveAt: Date.now() });
  },

  goBack: () => {
    const { order, cursor } = get();
    let i = cursor - 1;
    // Skip back over any sentinels to land on the previous real card.
    while (i > 0 && order[i] === CAUGHT_UP_SENTINEL) i -= 1;
    if (i < 0) i = 0;
    set({ cursor: Math.max(0, i), lastActiveAt: Date.now() });
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
      if (!current) return {} as Partial<SwipeDeckState>;
      return { verdicts: { ...s.verdicts, [id]: { ...current, path } } };
    }),

  clearVerdict: (id) =>
    set((s) => {
      if (!(id in s.verdicts)) return {} as Partial<SwipeDeckState>;
      const next = { ...s.verdicts };
      delete next[id];
      return { verdicts: next };
    }),

  reset: () => set({ ...initialState, verdicts: {}, cardsById: {} }),
}));
