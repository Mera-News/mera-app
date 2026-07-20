// triage-store — Zustand store backing the For-You "triage" one-card review.
//
// Triage replaces the old Browse swipe deck (swipe-feed-store, now DEPRECATED):
// the same ordered DeckCard model + chunk-release folding, but presented ONE
// card at a time with five explicit verdicts (Read / Good / Bad / Save / Skip)
// instead of a vertical snapping deck. Each verdict fires the feedback/persona
// side effects and advances to the next card.
//
// Ordering is the PURE deck contract (lib/news-harness/feed-select/deck.ts):
// initDeck loads all currently-scored, not-yet-opened suggestions and folds them
// into an empty deck; a chunk-release listener folds freshly-scored chunks in
// BEHIND the current card (the deck contract's frozen seen/current invariant),
// so the card the user is looking at never jumps and never gets preempted.
//
// Seen semantics are OPENS-ONLY (getOpenedSeenSet), identical to the swipe deck:
// Read/Good/Bad/Save each recordOpen(), so those cards are excluded on the next
// initDeck. SKIP is session-only — it advances past the card without recording
// an open, so a skipped card reappears the next time triage is opened.

import { create } from 'zustand';
import { useShallow } from 'zustand/react/shallow';
import { router } from 'expo-router';
import logger from '@/lib/logger';
import {
  loadSuggestions,
  getSuggestionByServerId,
} from '@/lib/database/services/article-suggestion-service';
import {
  getOpenedSeenSet,
  recordOpen,
} from '@/lib/database/services/story-impression-service';
import { recordArticleFeedback } from '@/lib/database/services/article-feedback-service';
import { saveSuggestion } from '@/lib/database/services/saved-article-suggestion-service';
import { applyPersonaAction } from '@/lib/database/services/persona-action-executor';
import { ACTION_NAMES } from '@/lib/news-harness/persona-management/action-names';
import { registerChunkReleaseListener } from '@/lib/services/scoring-pipeline';
import {
  insertChunkIntoDeck,
  type DeckCard,
} from '@/lib/news-harness/feed-select/deck';
import { bucketOf } from '@/lib/news-harness/feed-select/sections';
import type { ForYouSuggestion } from '@/lib/stores/for-you-store';
import {
  TRIAGE_GOOD_DELTA,
  TRIAGE_BAD_DELTA,
  TRIAGE_MAX_NUDGED_TOPICS,
} from '@/components/custom/triage/constants';

/** The five verdicts a card can be resolved with. Read/Good/Bad/Save mark the
 *  card opened (excluded next launch); Skip is session-only. */
export type TriageVerdict = 'read' | 'good' | 'bad' | 'save' | 'skip';

/** Lifecycle: `uninitialized` before initDeck, `loading` while it runs, then
 *  `active` (a current card exists) or `empty` (nothing left to review). */
export type TriageStatus = 'uninitialized' | 'loading' | 'active' | 'empty';

/** Options for {@link TriageState.resolve}. */
export interface ResolveOptions {
  /** Skip the topic-weight nudge for this verdict — used by the Bad → "tell us
   *  why" path, where the feedback-tree overlay has ALREADY applied the user's
   *  chosen persona mutation, so an automatic nudge on top would double-count. */
  skipPersonaNudge?: boolean;
}

/** Eligible = SCORED (a real tier, not UNSCORED) AND not OPENED (neither the
 *  articleId nor any cluster's stableClusterId is in the opens-only seen set). */
function isDeckEligible(s: ForYouSuggestion, seen: Set<string>): boolean {
  if (bucketOf(s.relevance) === 'UNSCORED') return false;
  if (s.articleId && seen.has(s.articleId)) return false;
  for (const c of s.clusters) {
    if (c.stableClusterId && seen.has(c.stableClusterId)) return false;
  }
  return true;
}

/** Project a scored suggestion onto a fresh `unread` DeckCard (deck contract
 *  ordering: bucket desc → rawScore desc → pubDate desc → id asc). */
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

function titleNormOf(title: string | null | undefined): string | null {
  return (title ?? '').toLowerCase().trim().replace(/\s+/g, ' ') || null;
}

function stableClusterIdOf(s: ForYouSuggestion): string | null {
  return s.clusters.find((c) => c.stableClusterId)?.stableClusterId ?? null;
}

/** JSON snapshot of the feedback provenance for the persisted feedback row —
 *  mirrors ArticleActionsRow.buildContextJson so triage feedback carries the
 *  same shape as the card-surface feedback. */
function buildContextJson(s: ForYouSuggestion): string | null {
  const snapshot: Record<string, unknown> = {};
  const cluster = stableClusterIdOf(s);
  if (cluster) snapshot.stableClusterId = cluster;
  if (s.eventType) snapshot.eventType = s.eventType;
  if (typeof s.relevance === 'number') snapshot.relevance = s.relevance;
  if (s.matchedTopics && s.matchedTopics.length > 0) {
    snapshot.matchedTopics = s.matchedTopics;
  }
  return Object.keys(snapshot).length > 0 ? JSON.stringify(snapshot) : null;
}

/** Fire the feedback/persona side effects for a verdict. Fire-and-forget: every
 *  branch is guarded and logged, never awaited by the caller, never throws. A
 *  null matched-topic id skips only that nudge — the feedback row is still
 *  recorded (guard null topicId). */
function fireVerdictSideEffects(
  s: ForYouSuggestion,
  verdict: TriageVerdict,
  opts: ResolveOptions,
): void {
  const recordOpenForSuggestion = () => {
    void recordOpen({
      articleId: s.articleId,
      suggestionId: s._id,
      stableClusterId: stableClusterIdOf(s),
      titleNorm: titleNormOf(s.title_en),
      surface: 'triage',
    });
  };

  const nudgeTopics = (delta: number) => {
    if (opts.skipPersonaNudge) return;
    const topicIds = (s.matchedTopics ?? [])
      .map((m) => m.topicId)
      .filter((id): id is string => !!id)
      .slice(0, TRIAGE_MAX_NUDGED_TOPICS);
    for (const topicId of topicIds) {
      void applyPersonaAction(
        { action_type: ACTION_NAMES.SET_TOPIC_WEIGHT, topicId, delta },
        'feedback',
      );
    }
  };

  switch (verdict) {
    case 'read':
      recordOpenForSuggestion();
      router.push({
        pathname: '/logged-in/suggestion-detail',
        params: { articleSuggestionId: s._id },
      });
      break;
    case 'good':
      void recordArticleFeedback({
        articleId: s.articleId,
        suggestionId: s._id,
        sentiment: 'like',
        title: s.title_en ?? '',
        origin: 'suggestion',
        surface: 'triage',
        contextJson: buildContextJson(s),
      });
      nudgeTopics(TRIAGE_GOOD_DELTA);
      recordOpenForSuggestion();
      break;
    case 'bad':
      void recordArticleFeedback({
        articleId: s.articleId,
        suggestionId: s._id,
        sentiment: 'dislike',
        title: s.title_en ?? '',
        origin: 'suggestion',
        surface: 'triage',
        contextJson: buildContextJson(s),
      });
      nudgeTopics(-TRIAGE_BAD_DELTA);
      recordOpenForSuggestion();
      break;
    case 'save':
      void saveSuggestion(s);
      recordOpenForSuggestion();
      break;
    case 'skip':
      // Session-only: no recordOpen, no feedback — the card reappears next init.
      break;
  }
}

interface TriageState {
  /** Ordered deck (deck.ts contract). Handled/passed cards are `seen`, the card
   *  under review is `current`, the rest are `unread`. */
  deck: DeckCard[];
  /** Full suggestion rows for rendering, keyed by server id (== DeckCard.id). */
  suggestionsById: Map<string, ForYouSuggestion>;
  /** Index of the card currently under review. */
  currentIndex: number;
  /** Server ids resolved this session with a non-skip verdict (advance guard;
   *  the durable exclusion is the opens-only seen set, not this). */
  handledIds: Set<string>;
  initialized: boolean;
  status: TriageStatus;

  // Actions
  initDeck: () => Promise<void>;
  resolve: (cardId: string, verdict: TriageVerdict, opts?: ResolveOptions) => void;
  teardown: () => void;
}

// Module-scoped release-listener unsubscribe (see swipe-feed-store). Kept out of
// store state so it's never serialized / re-rendered on. The scoring-pipeline
// registry is a Set, so triage and the (still-mounted) Browse deck can each hold
// a listener without conflict.
let releaseUnsub: (() => void) | null = null;

export const useTriageStore = create<TriageState>()((set, get) => {
  /** Fold a freshly-released chunk into the deck BEHIND the current card. Loads
   *  the released rows, keeps only scored + not-seen + not-already-in-deck, and
   *  inserts them via the pure deck contract (frozen seen/current never move). */
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

        let deck = insertChunkIntoDeck(prev.deck, newCards);
        let status = prev.status;
        // Revive from `empty`: if the current pointer now lands on a fresh card,
        // promote it to `current` and re-activate. When not empty, the frozen
        // prefix stayed at the front so currentIndex still points at `current`.
        if (prev.currentIndex < deck.length) {
          if (deck[prev.currentIndex].state !== 'current') {
            deck = deck.slice();
            deck[prev.currentIndex] = {
              ...deck[prev.currentIndex],
              state: 'current',
            };
          }
          status = 'active';
        }
        return { deck, suggestionsById: nextById, status };
      });
    } catch (err) {
      logger.captureException(err, {
        tags: { store: 'triage-store', method: 'handleRelease' },
      });
    }
  }

  return {
    deck: [],
    suggestionsById: new Map(),
    currentIndex: 0,
    handledIds: new Set<string>(),
    initialized: false,
    status: 'uninitialized',

    initDeck: async () => {
      set({ status: 'loading' });
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
        // Fold into an empty deck so the deck-contract ordering is applied, then
        // mark the front card `current` (frozen — newcomers fold in behind it).
        let deck = insertChunkIntoDeck([], cards);
        if (deck.length > 0) {
          deck = deck.slice();
          deck[0] = { ...deck[0], state: 'current' };
        }

        set({
          deck,
          suggestionsById: byId,
          currentIndex: 0,
          handledIds: new Set<string>(),
          initialized: true,
          status: deck.length > 0 ? 'active' : 'empty',
        });

        // Register the chunk-release listener exactly once — this turns the
        // pipeline's release queue ON while triage is active.
        if (!releaseUnsub) {
          releaseUnsub = registerChunkReleaseListener((releasedIds) => {
            void handleRelease(releasedIds);
          });
        }
      } catch (err) {
        logger.captureException(err, {
          tags: { store: 'triage-store', method: 'initDeck' },
        });
        set({ initialized: true, status: 'empty' });
      }
    },

    resolve: (cardId, verdict, opts = {}) => {
      const s = get().suggestionsById.get(cardId);
      // Fire the feedback/persona side effects first (fire-and-forget). Guard a
      // missing row (should not happen) so the deck still advances.
      if (s) fireVerdictSideEffects(s, verdict, opts);

      set((prev) => {
        const deck = prev.deck.slice();
        // Freeze the resolved card (`seen`) so a later chunk release can't
        // reorder it above the next card. Skip freezes it too (session-local
        // only; it's still excluded from handledIds so it re-enters next init).
        if (prev.currentIndex < deck.length) {
          deck[prev.currentIndex] = {
            ...deck[prev.currentIndex],
            state: 'seen',
          };
        }
        const handledIds =
          verdict === 'skip'
            ? prev.handledIds
            : new Set(prev.handledIds).add(cardId);

        const nextIndex = prev.currentIndex + 1;
        if (nextIndex >= deck.length) {
          return { deck, currentIndex: nextIndex, handledIds, status: 'empty' as const };
        }
        deck[nextIndex] = { ...deck[nextIndex], state: 'current' };
        return { deck, currentIndex: nextIndex, handledIds, status: 'active' as const };
      });
    },

    teardown: () => {
      if (releaseUnsub) {
        releaseUnsub();
        releaseUnsub = null;
      }
    },
  };
});

// --- Selector hooks (house zustand pattern, see for-you-store) ---

export const useTriageInitialized = () => useTriageStore((s) => s.initialized);
export const useTriageStatus = () => useTriageStore((s) => s.status);

/** The current card + the one queued behind it (for the "up next" peek), plus
 *  the 1-based position and total for the header progress. `remaining` is the
 *  count of cards after the current one. */
export const useTriageCurrent = () =>
  useTriageStore(
    useShallow((s) => {
      const current = s.deck[s.currentIndex] ?? null;
      const next = s.deck[s.currentIndex + 1] ?? null;
      return {
        suggestion: current ? s.suggestionsById.get(current.id) ?? null : null,
        next: next ? s.suggestionsById.get(next.id) ?? null : null,
        position: Math.min(s.currentIndex + 1, s.deck.length),
        total: s.deck.length,
        remaining: Math.max(0, s.deck.length - s.currentIndex - 1),
      };
    }),
  );
