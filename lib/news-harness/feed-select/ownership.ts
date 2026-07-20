// feed-select/ownership — PURE, RN-free fact-ownership + display-bucket cores.
//
// No imports of lib/database, lib/stores, expo, react-native, or watermelondb.
// These small pure functions (moved here from the deleted `sections.ts` in
// Round-3 C3) are the shared authority for:
//   - `bucketOf` / `bucketRank` — persisted relevance → display tier.
//   - `resolveOwnership` / `resolveOwningFact` — which fact owns a story group
//     (used by both the fact-rows feed selector and the per-fact scoring
//     batcher, `lib/services/fact-batching.ts`).
//
// The input projection types are declared here (redeclared, never importing
// lib/stores) so this module stays at the RN-free harness layer.

import {
  DEFAULT_HARNESS_CONFIG,
  type HarnessConfig,
} from '../core/config';

// --- Bucket (display tier) ------------------------------------------------

/** The four persisted relevance tiers + an UNSCORED sentinel for rows that
 *  never cleared scoring (progressive-render placeholders / discarded). */
export type FeedBucket = 'EMERGENCY' | 'HIGH' | 'MEDIUM' | 'LOW' | 'UNSCORED';

/** Total-order rank for a bucket (higher = more prominent). */
export function bucketRank(b: FeedBucket): number {
  switch (b) {
    case 'EMERGENCY':
      return 4;
    case 'HIGH':
      return 3;
    case 'MEDIUM':
      return 2;
    case 'LOW':
      return 1;
    default:
      return 0;
  }
}

/**
 * Derive the display bucket from a persisted `relevance` value using the same
 * cutoffs `bucketScores` uses. `relevance` is the bucketed display score (0.4 /
 * 0.6 / 0.8 / 1.1 representative values, or a sub-floor raw for discards, or a
 * negative sentinel for unscored). Anything below the discard floor → UNSCORED.
 */
export function bucketOf(
  relevance: number | null | undefined,
  config: HarnessConfig = DEFAULT_HARNESS_CONFIG,
): FeedBucket {
  const a = config.articlePipeline;
  if (relevance == null || relevance < a.discardFloor) return 'UNSCORED';
  if (relevance > a.emergencyPriorityCutoff) return 'EMERGENCY';
  if (relevance >= a.highPriorityCutoff) return 'HIGH';
  if (relevance >= a.mediumPriorityCutoff) return 'MEDIUM';
  return 'LOW';
}

// --- Input projections (plain; no DB/RN) ----------------------------------

/** A cluster membership as story-grouping consumes it. Structurally identical
 *  to `lib/stores/for-you-store`'s ClusterMembership but redeclared here so this
 *  module never imports lib/stores (RN-free constraint). */
export interface StoryClusterMembership {
  clusterId: string;
  confidence: number;
  stableClusterId?: string | null;
}

/** One matched topic on a suggestion (from `matched_topics_json`). `topicId`
 *  is null for synthetic headline matches. */
export interface MatchedTopicProjection {
  topicId: string | null;
  text: string;
}

/** The plain per-suggestion projection the ownership resolver reads. Only
 *  `matchedTopics` is required by `resolveOwnership`; the other fields exist so
 *  the fact-rows selector can share one projection shape. */
export interface ScoredSuggestionProjection {
  id: string;
  /** Final post-judge raw score (`article_suggestions.raw_score`). Null when the
   *  row is unscored (progressive render). */
  rawScore: number | null;
  /** Bucketed display value (`article_suggestions.relevance`). */
  relevance: number | null;
  /** WMDB status string; unused for ordering beyond the scored/unscored split. */
  status?: string;
  /** first_pub_date in epoch ms. */
  pubDateMs: number;
  /** Title (for the story-grouping title edges). Optional — null contributes no
   *  title edge, cluster edges still apply. */
  title?: string | null;
  clusterMemberships: StoryClusterMembership[];
  /** Top-level stable story id (seen-dedup); grouping uses the per-membership id. */
  stableClusterId?: string | null;
  /** Controlled event-type value (breaking extraction). */
  eventType?: string | null;
  /** null = topic-retrieved; else the top-headline injection scope. */
  headlineScope?: 'CITY' | 'COUNTRY' | 'GLOBAL' | null;
  /** For CITY/COUNTRY headline rows: the location instance that produced the
   *  scope. */
  headlineLocationId?: string | null;
  matchedTopics: MatchedTopicProjection[];
}

/** Topics snapshot entry (id → this). */
export interface TopicSnapshot {
  factId: string | null;
  weight: number;
  highPriority: boolean;
  status: string; // 'active' | 'suppressed' | 'retired'
}

/** Facts snapshot entry (id → this). */
export interface FactSnapshot {
  /** null ⇒ treated as 1.0 by the engine. */
  weight: number | null;
  createdAtMs: number;
  /** Human fact statement — the fact row title. */
  statement?: string | null;
}

/** Location snapshot entry (id → this), for headline-section titles/weights. */
export interface LocationSnapshot {
  city?: string | null;
  region?: string | null;
  countryCode?: string | null;
  /** Display country name (fallback to countryCode when absent). */
  country?: string | null;
  /** [0,1] — ordering + headline-section weight strength. */
  weight: number;
}

// --- Ownership resolution -------------------------------------------------

/**
 * Why a group's representative has no positive-weight owning fact:
 *  - `owned`    — an active, positive-weight fact wins → gets a fact row.
 *  - `orphan`   — no active fact resolved (retired/suppressed topic, deleted
 *                 fact, null factId, missing topic), OR the strongest active
 *                 effective weight is exactly 0 (active fact, no signal either
 *                 way). Degradable: falls through to "Also for you" if relevant.
 *  - `negative` — the strongest active effective weight is < 0 (the user
 *                 explicitly down-weighted the only matched topics). Stays
 *                 dropped: suppression working as intended.
 */
export type OwnershipResolution =
  | { kind: 'owned'; factId: string }
  | { kind: 'orphan' }
  | { kind: 'negative' };

/**
 * Resolve the owning fact of a group from its representative's matched topics,
 * classifying the no-owner case as `orphan` (degradable) vs `negative`
 * (suppressed) — see {@link OwnershipResolution}.
 *
 * factScore(fact) = max over that fact's matched topics of
 *   w_eff = clamp(topic.weight × (fact.weight ?? 1) × (highPriority?HP_MULT:1), -1, 1).
 * Winner = highest factScore; tie-break chain (documented + tested):
 *   1. higher fact.weight (null ⇒ 1.0)
 *   2. more matched topics owned by that fact (breadth)
 *   3. older fact.created_at (smaller createdAtMs)
 *   4. lexicographic fact id
 * Only facts with factScore > 0 are eligible to OWN a row (negative-only matches
 * own no row — already score-gutted by P_NEG). When no fact owns, the strongest
 * active effective weight decides orphan (≥ 0 / none) vs negative (< 0).
 */
export function resolveOwnership(
  rep: ScoredSuggestionProjection,
  topics: Map<string, TopicSnapshot>,
  facts: Map<string, FactSnapshot>,
  hpMult: number = DEFAULT_HARNESS_CONFIG.scoringEngine.HP_MULT,
): OwnershipResolution {
  // factId → { score, count } (score = max w_eff over that fact's matched topics)
  const candidates = new Map<string, { score: number; count: number }>();
  for (const mt of rep.matchedTopics) {
    if (!mt.topicId) continue;
    const topic = topics.get(mt.topicId);
    if (!topic || topic.status !== 'active' || !topic.factId) continue;
    const fact = facts.get(topic.factId);
    if (!fact) continue;
    const factWeight = fact.weight ?? 1;
    const wEff = clamp(
      topic.weight * factWeight * (topic.highPriority ? hpMult : 1),
      -1,
      1,
    );
    const prev = candidates.get(topic.factId);
    if (prev) {
      prev.score = Math.max(prev.score, wEff);
      prev.count += 1;
    } else {
      candidates.set(topic.factId, { score: wEff, count: 1 });
    }
  }

  let winner: string | null = null;
  let winStats: { score: number; count: number } | null = null;
  for (const [factId, stats] of candidates) {
    if (stats.score <= 0) continue; // ≤ 0 → owns no row
    if (winner == null) {
      winner = factId;
      winStats = stats;
      continue;
    }
    if (factBeats(factId, stats, winner, winStats!, facts)) {
      winner = factId;
      winStats = stats;
    }
  }
  if (winner != null) return { kind: 'owned', factId: winner };

  // No positive-weight owner. Distinguish an ORPHAN (no active fact resolved,
  // or the strongest active signal is exactly 0 — no signal either way) from a
  // NEGATIVE signal (strongest active effective weight < 0). Empty candidates ⇒
  // nothing active resolved ⇒ orphan.
  if (candidates.size === 0) return { kind: 'orphan' };
  let maxActive = Number.NEGATIVE_INFINITY;
  for (const stats of candidates.values()) {
    if (stats.score > maxActive) maxActive = stats.score;
  }
  return maxActive < 0 ? { kind: 'negative' } : { kind: 'orphan' };
}

/**
 * Convenience wrapper preserving the original `string | null` contract: the
 * winning fact id, or null when no active positive fact owns the group
 * (orphan OR negative — callers that need the distinction use
 * {@link resolveOwnership}).
 */
export function resolveOwningFact(
  rep: ScoredSuggestionProjection,
  topics: Map<string, TopicSnapshot>,
  facts: Map<string, FactSnapshot>,
  hpMult: number = DEFAULT_HARNESS_CONFIG.scoringEngine.HP_MULT,
): string | null {
  const res = resolveOwnership(rep, topics, facts, hpMult);
  return res.kind === 'owned' ? res.factId : null;
}

/** True when candidate fact (id `ca`) should beat the current winner (`cw`). */
function factBeats(
  ca: string,
  sa: { score: number; count: number },
  cw: string,
  sw: { score: number; count: number },
  facts: Map<string, FactSnapshot>,
): boolean {
  if (sa.score !== sw.score) return sa.score > sw.score;
  const wa = facts.get(ca)?.weight ?? 1;
  const ww = facts.get(cw)?.weight ?? 1;
  if (wa !== ww) return wa > ww; // 1. higher fact.weight
  if (sa.count !== sw.count) return sa.count > sw.count; // 2. more matched topics
  const cra = facts.get(ca)?.createdAtMs ?? 0;
  const crw = facts.get(cw)?.createdAtMs ?? 0;
  if (cra !== crw) return cra < crw; // 3. older fact wins
  return ca < cw; // 4. lexicographic fact id
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
