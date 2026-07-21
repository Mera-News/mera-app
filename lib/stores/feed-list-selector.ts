// feed-list-selector — a pure composite-score selector over the same
// render-gated 24h suggestion pool the swipe deck and fact-rows feed consume.
// Produces a single flat, ordered list (one card per collapsed story) ranked
// by a frozen "importance + recency decay" score rather than the deck's
// breaking-first / rawScore-desc ordering.
//
// PURE: RN-free. It consumes the store's `ForYouSuggestion` rows + an
// excluded-id set and returns plain data; no DB / expo / react-native
// imports, so it unit-tests without a device.
//
// Pipeline (deliberately clones `buildSwipeStack`'s body — filter → group →
// pick a representative → drop excluded reps → sort — so grouping/visibility
// stay a single source of truth via the shared fact-rows-selector /
// story-grouping primitives; only the final ranking differs, so per the repo's
// "three similar lines beat a premature abstraction" rule this is copied, not
// factored out of swipe-stack-selector.ts):
//   filter to visible (note-gated + render gate + 24h window) → story-group →
//   pick a representative per group → drop reps already excluded (opened ∪
//   viewed) → freeze each rep's composite `feedScore` → sort by
//   `feedCompare` (score desc → pubDate desc → id asc).

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

/** Exponential-decay half-life (hours) for the recency term of `feedScore`. */
export const FEED_HALF_LIFE_HOURS = 6;

/** Base weight of the recency term (before any breaking bonus). */
export const FEED_RECENCY_WEIGHT = 0.5;

/** Extra recency weight added on top of `FEED_RECENCY_WEIGHT` for breaking
 *  stories, so a fresh breaking story's decay term outweighs a fresh
 *  non-breaking one even at identical rawScore. */
export const FEED_BREAKING_RECENCY_BONUS = 0.6;

/** One card in the composite-score feed list (a collapsed multi-source
 *  story). */
export interface FeedListItem {
  /** Stable list id = the representative's article id (also the seen-set
   *  key + `keyExtractor`). */
  id: string;
  /** The fronting suggestion (newest/strongest member of the story). */
  suggestion: ForYouSuggestion;
  /** Total members in the collapsed story (rep included). `> 1` ⇒ "+N
   *  sources". */
  memberCount: number;
  /** Whether the representative is a breaking story. */
  breaking: boolean;
  /** Frozen composite score at build time (`feedScore` at the injected
   *  clock) — captured once so list ordering doesn't drift mid-session as
   *  real time advances under the list. */
  score: number;
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
 *  (Standard sort order: negative ⇒ `a` preferred.) Mirrors the swipe-stack /
 *  fact-rows selectors' representative pick so every feed surface fronts the
 *  same article for a given story. */
function repCompare(a: GroupItem, b: GroupItem): number {
  const pa = parseMs(a.s.firstPubDate);
  const pb = parseMs(b.s.firstPubDate);
  if (pa !== pb) return pb - pa;
  const ra = a.s.rawScore ?? Number.NEGATIVE_INFINITY;
  const rb = b.s.rawScore ?? Number.NEGATIVE_INFINITY;
  if (ra !== rb) return rb - ra;
  return a.s._id < b.s._id ? -1 : a.s._id > b.s._id ? 1 : 0;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** Age of a suggestion's `createdAt`, in hours, at `nowMs`. An unparseable
 *  `createdAt` (NaN from `Date.parse`) is treated as infinitely old — NOT as
 *  age 0 — so a corrupt/missing timestamp never wins on freshness; it falls
 *  back to being ranked on `rawScore` alone (the decay term below evaluates
 *  to `Math.pow(2, -Infinity)` = 0). */
function ageHoursOf(createdAt: string, nowMs: number): number {
  const t = Date.parse(createdAt);
  if (!Number.isFinite(t)) return Number.POSITIVE_INFINITY;
  return Math.max(0, nowMs - t) / 3_600_000;
}

/**
 * Composite ranking score: clamped importance (`rawScore`, capped at 1.2)
 * plus an exponentially-decaying recency term, boosted for breaking stories.
 *
 *   score = clamp(rawScore ?? 0, 0, 1.2)
 *         + (FEED_RECENCY_WEIGHT + (isBreaking ? FEED_BREAKING_RECENCY_BONUS : 0))
 *           * 2^(-ageHours / FEED_HALF_LIFE_HOURS)
 *
 * @param s     the suggestion to score.
 * @param nowMs injected clock (deterministic testing).
 */
export function feedScore(s: ForYouSuggestion, nowMs: number): number {
  const importance = clamp(s.rawScore ?? 0, 0, 1.2);
  const ageHours = ageHoursOf(s.createdAt, nowMs);
  const recencyWeight = FEED_RECENCY_WEIGHT + (isBreaking(s) ? FEED_BREAKING_RECENCY_BONUS : 0);
  const decay = Math.pow(2, -ageHours / FEED_HALF_LIFE_HOURS);
  return importance + recencyWeight * decay;
}

/**
 * List ordering: frozen composite score desc, then rep `firstPubDate` desc,
 * then id asc for a fully-deterministic tie-break.
 */
export function feedCompare(a: FeedListItem, b: FeedListItem): number {
  if (a.score !== b.score) return b.score - a.score;
  const pa = parseMs(a.suggestion.firstPubDate);
  const pb = parseMs(b.suggestion.firstPubDate);
  if (pa !== pb) return pb - pa;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Build the ordered composite-score feed list from the live suggestion pool
 * + the excluded-id set.
 *
 * @param suggestions the live `ForYouSuggestion` pool.
 * @param excludedIds article_id ∪ stable_cluster_id of every opened OR
 *                    viewed story.
 * @param nowMs       injected clock (deterministic testing), captured once
 *                    and used to freeze every item's `score`.
 */
export function buildFeedList(
  suggestions: ForYouSuggestion[],
  excludedIds: Set<string>,
  nowMs: number = Date.now(),
): FeedListItem[] {
  const cutoffMs = nowMs - FEED_WINDOW_MS;

  // 1. Visible pool (note-gated + render gate + 24h window). Same gate the
  //    swipe deck / fact-rows feeds use, so every surface agrees on what is
  //    showable.
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

  // 3. One representative per group; drop reps already excluded (opened ∪
  //    viewed) — the list never re-serves a read/seen story. Freeze the
  //    composite score at build time.
  const list: FeedListItem[] = [];
  for (const g of groups) {
    const rep = pickRepresentative(g, repCompare).s;
    if (isSuggestionOpened(rep, excludedIds)) continue;
    list.push({
      id: rep.articleId,
      suggestion: rep,
      memberCount: g.length,
      breaking: isBreaking(rep),
      score: feedScore(rep, nowMs),
    });
  }

  // 4. Deterministic list order.
  list.sort(feedCompare);
  return list;
}
