// swipe-feed-store — Zustand store backing the Browse swipe deck (Wave 8, N3).
//
// The deck is an ordered list of DeckCards (the PURE deck contract in
// lib/news-harness/feed-select/deck.ts). initDeck loads all currently-scored,
// not-yet-opened suggestions from the local DB, and a chunk-release listener
// (registered on the scoring pipeline) folds freshly-scored chunks into the
// deck IN ORDER as they land — without ever repositioning the seen/current
// cards (deck.ts invariant), so the visible card never jumps.
//
// Seen semantics are OPENS-ONLY (getOpenedSeenSet): scrolling past a card never
// drains the deck; only OPENING a story (recordOpen, wired at the card tap in
// the screen) marks it seen and excludes it on the next initDeck. Since opened
// rows are excluded at load, the deck is all-unread and resumes at index 0 on
// relaunch.

import { create } from 'zustand';
import logger from '@/lib/logger';
import {
  loadSuggestions,
  getSuggestionByServerId,
} from '@/lib/database/services/article-suggestion-service';
import { getOpenedSeenSet } from '@/lib/database/services/story-impression-service';
import { registerChunkReleaseListener } from '@/lib/services/scoring-pipeline';
import {
  insertChunkIntoDeck,
  type DeckCard,
} from '@/lib/news-harness/feed-select/deck';
import { bucketOf } from '@/lib/news-harness/feed-select/sections';
import type { ForYouSuggestion } from '@/lib/stores/for-you-store';

/** True when a suggestion belongs in the swipe deck: it is SCORED (its bucket
 *  is a real tier, not UNSCORED) AND it has not been OPENED — neither its
 *  articleId nor any of its clusters' stableClusterId is in the opens-only seen
 *  set. Impressions never enter that set, so scrolling can't exclude a card. */
function isDeckEligible(s: ForYouSuggestion, seen: Set<string>): boolean {
  if (bucketOf(s.relevance) === 'UNSCORED') return false;
  if (s.articleId && seen.has(s.articleId)) return false;
  for (const c of s.clusters) {
    if (c.stableClusterId && seen.has(c.stableClusterId)) return false;
  }
  return true;
}

/** Project a scored suggestion onto a DeckCard for the deck contract's ordering
 *  (bucket desc → rawScore desc → pubDate desc → id asc). Freshly-built cards
 *  are `unread` (frozen seen/current cards are only ever produced in-place). */
function toDeckCard(s: ForYouSuggestion): DeckCard {
  const pub = Date.parse(s.firstPubDate);
  return {
    id: s._id,
    bucket: bucketOf(s.relevance),
    rawScore: s.rawScore ?? 0,
    pubDateMs: Number.isFinite(pub) ? pub : 0,
    state: 'unread',
  };
}

interface SwipeFeedState {
  /** Ordered deck (deck.ts contract). */
  deck: DeckCard[];
  /** Full suggestion rows for rendering, keyed by server id (== DeckCard.id). */
  suggestionsById: Map<string, ForYouSuggestion>;
  /** Index of the currently snap-centered card. */
  currentIndex: number;
  /** Id of the currently snap-centered card — the screen re-reads its index
   *  after an insert to correct scroll position so the visible card never
   *  jumps. Null before the first card is centered / on an empty deck. */
  currentCardId: string | null;
  initialized: boolean;

  // Actions
  initDeck: () => Promise<void>;
  setCurrentIndex: (i: number) => void;
  setCurrentCard: (index: number, cardId: string | null) => void;
  teardown: () => void;
}

// Module-scoped release-listener unsubscribe. Kept out of store state so it's
// never serialized / re-rendered on; the store owns exactly one subscription.
let releaseUnsub: (() => void) | null = null;

export const useSwipeFeedStore = create<SwipeFeedState>()((set, get) => {
  /** Fold a freshly-released chunk into the deck. Loads the released rows, keeps
   *  only scored + not-seen + not-already-in-deck, and inserts them via the pure
   *  deck contract (which never repositions seen/current cards). */
  async function handleRelease(ids: string[]): Promise<void> {
    try {
      if (ids.length === 0) return;
      const seen = await getOpenedSeenSet();
      const existing = new Set(get().deck.map((c) => c.id));
      const rows = await Promise.all(
        ids.map((id) => getSuggestionByServerId(id)),
      );

      const newCards: DeckCard[] = [];
      const addedRows: ForYouSuggestion[] = [];
      for (const s of rows) {
        if (!s) continue;
        if (existing.has(s._id)) continue;
        if (!isDeckEligible(s, seen)) continue;
        newCards.push(toDeckCard(s));
        addedRows.push(s);
      }
      if (newCards.length === 0) return;

      set((prev) => {
        const nextById = new Map(prev.suggestionsById);
        for (const s of addedRows) nextById.set(s._id, s);
        return {
          deck: insertChunkIntoDeck(prev.deck, newCards),
          suggestionsById: nextById,
        };
      });
    } catch (err) {
      logger.captureException(err, {
        tags: { store: 'swipe-feed-store', method: 'handleRelease' },
      });
    }
  }

  return {
    deck: [],
    suggestionsById: new Map(),
    currentIndex: 0,
    currentCardId: null,
    initialized: false,

    initDeck: async () => {
      try {
        const [rows, seen] = await Promise.all([
          loadSuggestions(),
          getOpenedSeenSet(),
        ]);

        const cards: DeckCard[] = [];
        const byId = new Map<string, ForYouSuggestion>();
        for (const s of rows) {
          if (!isDeckEligible(s, seen)) continue;
          cards.push(toDeckCard(s));
          byId.set(s._id, s);
        }
        // Fold into an empty deck so the deck-contract ordering is applied.
        const deck = insertChunkIntoDeck([], cards);

        set({
          deck,
          suggestionsById: byId,
          currentIndex: 0,
          currentCardId: deck[0]?.id ?? null,
          initialized: true,
        });

        // Register the chunk-release listener exactly once — this is what turns
        // the pipeline's release queue ON (Browse is now active).
        if (!releaseUnsub) {
          releaseUnsub = registerChunkReleaseListener((releasedIds) => {
            void handleRelease(releasedIds);
          });
        }
      } catch (err) {
        logger.captureException(err, {
          tags: { store: 'swipe-feed-store', method: 'initDeck' },
        });
        set({ initialized: true });
      }
    },

    setCurrentIndex: (i) => set({ currentIndex: i }),

    setCurrentCard: (index, cardId) =>
      set({ currentIndex: index, currentCardId: cardId }),

    teardown: () => {
      if (releaseUnsub) {
        releaseUnsub();
        releaseUnsub = null;
      }
    },
  };
});

// --- Selector hooks (house zustand pattern, see for-you-store) ---
export const useSwipeDeck = () => useSwipeFeedStore((s) => s.deck);
export const useSwipeCurrentIndex = () => useSwipeFeedStore((s) => s.currentIndex);
export const useSwipeCurrentCardId = () =>
  useSwipeFeedStore((s) => s.currentCardId);
export const useSwipeInitialized = () => useSwipeFeedStore((s) => s.initialized);
