// swipe-stack-selector — the pure selector behind the Round-4 Feed-tab swipe
// deck. Turns the render-gated 24h suggestion pool into a flat, ordered list of
// deck candidates (one card per collapsed story), newest/most-relevant first,
// with breaking stories pinned to the front.
//
// PURE: RN-free. It consumes the store's `ForYouSuggestion` rows + the opened
// set and returns plain data the deck store lays out; no DB / expo /
// react-native imports, so it unit-tests without a device.
//
// Pipeline (deliberately reuses the fact-rows-selector + story-grouping
// primitives so there is ONE grouping/visibility source of truth):
//   filter to visible (note-gated + render gate + 24h window) → story-group →
//   pick a representative per group → drop reps already opened elsewhere → sort
//   by `deckCompare` (breaking → rawScore desc → pubDate desc → id asc).

import {
  buildStoryGroups,
  pickRepresentative,
  TITLE_JACCARD_DISPLAY_THRESHOLD,
  CLUSTER_CORE_CONFIDENCE_THRESHOLD,
  WEIGHTED_JACCARD_DISPLAY_THRESHOLD,
  type GroupableItem,
} from '@/lib/feed-grouping/story-grouping';
import {
  FEED_WINDOW_MS,
  isVisible,
  isBreaking,
  isSuggestionOpened,
} from './fact-rows-selector';
import type { ForYouSuggestion } from './for-you-store';

/** One card in the swipe deck (a collapsed multi-source story). */
export interface SwipeDeckCandidate {
  /** Stable deck id = the representative's article id (also the seen-set key). */
  id: string;
  /** The fronting suggestion (newest/strongest member of the story). */
  suggestion: ForYouSuggestion;
  /** Total members in the collapsed story (rep included). `> 1` ⇒ "+N sources". */
  memberCount: number;
  /** Whether the representative is a breaking story (pins it to the deck front). */
  breaking: boolean;
}

interface GroupItem extends GroupableItem {
  s: ForYouSuggestion;
}

function parseMs(iso: string | null | undefined): number {
  if (!iso) return 0;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : 0;
}

/** Representative comparator: newest pubDate → higher rawScore → smaller id.
 *  (Standard sort order: negative ⇒ `a` preferred.) Mirrors the fact-rows
 *  selector's representative pick so the two feeds front the same article. */
function repCompare(a: GroupItem, b: GroupItem): number {
  const pa = parseMs(a.s.firstPubDate);
  const pb = parseMs(b.s.firstPubDate);
  if (pa !== pb) return pb - pa;
  const ra = a.s.rawScore ?? Number.NEGATIVE_INFINITY;
  const rb = b.s.rawScore ?? Number.NEGATIVE_INFINITY;
  if (ra !== rb) return rb - ra;
  return a.s._id < b.s._id ? -1 : a.s._id > b.s._id ? 1 : 0;
}

/**
 * Deck ordering: breaking stories first, then highest rawScore, then newest
 * pubDate, then id asc for a fully-deterministic tie-break. Exported so the
 * deck store re-sorts a finalized `pendingBuffer` segment with the identical
 * rule at the moment the user crosses a sentinel.
 */
export function deckCompare(a: SwipeDeckCandidate, b: SwipeDeckCandidate): number {
  if (a.breaking !== b.breaking) return a.breaking ? -1 : 1;
  const ra = a.suggestion.rawScore ?? Number.NEGATIVE_INFINITY;
  const rb = b.suggestion.rawScore ?? Number.NEGATIVE_INFINITY;
  if (ra !== rb) return rb - ra;
  const pa = parseMs(a.suggestion.firstPubDate);
  const pb = parseMs(b.suggestion.firstPubDate);
  if (pa !== pb) return pb - pa;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Build the ordered swipe-deck candidate list from the live suggestion pool +
 * the opened set.
 *
 * @param suggestions the live `ForYouSuggestion` pool.
 * @param openedIds   article_id ∪ stable_cluster_id of every opened story.
 * @param nowMs       injected clock (deterministic testing).
 */
export function buildSwipeStack(
  suggestions: ForYouSuggestion[],
  openedIds: Set<string>,
  nowMs: number = Date.now(),
): SwipeDeckCandidate[] {
  const cutoffMs = nowMs - FEED_WINDOW_MS;

  // 1. Visible pool (note-gated + render gate + 24h window). Same gate the
  //    fact-rows feed uses, so the two surfaces agree on what is showable.
  const visible = suggestions.filter((s) => isVisible(s, cutoffMs));
  if (visible.length === 0) return [];

  // 2. Story-group the visible pool (display thresholds incl. the weighted edge).
  const items: GroupItem[] = visible.map((s) => ({
    id: s._id,
    title: s.title_en ?? s.title_original ?? null,
    clusters: s.clusters,
    s,
  }));
  const groups = buildStoryGroups(items, {
    titleJaccardThreshold: TITLE_JACCARD_DISPLAY_THRESHOLD,
    clusterConfidenceThreshold: CLUSTER_CORE_CONFIDENCE_THRESHOLD,
    weightedJaccardThreshold: WEIGHTED_JACCARD_DISPLAY_THRESHOLD,
  });

  // 3. One representative per group; drop reps already opened elsewhere (the
  //    deck never re-serves a read story).
  const candidates: SwipeDeckCandidate[] = [];
  for (const g of groups) {
    const rep = pickRepresentative(g, repCompare).s;
    if (isSuggestionOpened(rep, openedIds)) continue;
    candidates.push({
      id: rep.articleId,
      suggestion: rep,
      memberCount: g.length,
      breaking: isBreaking(rep),
    });
  }

  // 4. Deterministic deck order.
  candidates.sort(deckCompare);
  return candidates;
}
