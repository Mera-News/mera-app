// feed-select/ownership — PURE, RN-free fact-ownership + display-bucket cores.
//
// No imports of lib/database, lib/stores, expo, react-native, or watermelondb.
// These small pure functions (moved here from the deleted `sections.ts` in
// Round-3 C3) are the shared authority for:
//   - `bucketOf` / `bucketRank` — persisted relevance → display tier.
//   - `resolveOwnership` / `resolveOwningFact` — which fact owns a story group
//     (used by the fact-rows feed selector).
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

// --- Section membership: the fact link must be RELEVANCE-BACKED -----------
//
// Matching a fact and being ABOUT that fact are different claims, and the
// Dashboard makes the stronger one: its section header reads "News about: X".
// Ownership (below) answers only "which fact did this story match?", from topic
// weights — it never consults what the scorer concluded about THIS article. So a
// story retrieved by coarse vector similarity and then scored down to near-zero
// still landed under the fact, and the card rendered Mera's own rationale
// denying the link ("no direct tie to your Dutch learning") INSIDE the section
// that claimed it. The two rules below add the missing relevance backing.
//
// Both are expressed with EXISTING cutoffs — no new tunable was invented, since
// there is no on-device corpus here to tune one against.

/**
 * RULE 1 — a story may only occupy a fact section if the scoring pipeline did
 * not already discard it: its bucket must not be `UNSCORED`, i.e. its relevance
 * cleared `articlePipeline.discardFloor`.
 *
 * This closes a genuine gap rather than adding a preference: the render gate
 * that admits rows to the feed (`RENDER_GATE`, 0.3) is LOOSER than the
 * pipeline's own `discardFloor` (0.4), so rows the engine had already classified
 * as discards were still reaching the Dashboard and claiming a section.
 */
export function isSectionMemberEligible(bucket: FeedBucket): boolean {
  return bucket !== 'UNSCORED';
}

/**
 * The weakest bucket that can, on its own, justify a fact section existing.
 * `MEDIUM` — an existing display tier, not a new threshold.
 *
 * THIS IS THE DIAL for Rule 2, and the one number here that could not be
 * validated against real data: the article corpus lives on-device, so there is
 * no way from here to measure what fraction of a real Dashboard's section
 * membership is LOW. If sections turn out to be LOW-heavy in practice, this rule
 * will visibly empty them.
 *
 * Setting this to `'LOW'` disables Rule 2 entirely (every bucket then clears the
 * floor) while leaving Rule 1 — the sub-discardFloor exclusion — in force. That
 * is the intended one-line retreat if MEDIUM proves too aggressive.
 */
export const SECTION_MIN_VIABLE_BUCKET: FeedBucket = 'MEDIUM';

/**
 * RULE 2 — a fact section must be backed by at least ONE member at
 * {@link SECTION_MIN_VIABLE_BUCKET} or above. A fact whose every match is LOW
 * has no news genuinely about it: those matches are the tail of a similarity
 * search, not coverage. Dropping the whole section says "nothing about this
 * right now", which is true, instead of filling it with articles that disclaim
 * themselves.
 *
 * Deliberately a per-SECTION test, not a per-card one: once a fact has real
 * coverage, its LOW-bucket stories are kept, so genuinely active sections stay
 * as full as they are today. Only all-LOW sections disappear.
 */
export function isFactSectionViable(buckets: readonly FeedBucket[]): boolean {
  const floor = bucketRank(SECTION_MIN_VIABLE_BUCKET);
  for (const b of buckets) {
    if (bucketRank(b) >= floor) return true;
  }
  return false;
}

// --- Headline sections ----------------------------------------------------
//
// Top-headline rows carry a persisted `headline_scope` and SYNTHETIC matched
// topics (`topicId: null`), so `resolveOwningFactLenient` can never resolve an
// owner for them — every one of them used to be dropped from the Dashboard even
// though the Feed tab rendered them. They now get their own sections, keyed by
// scope, sitting alongside the fact sections.
//
// The ids below are SYNTHETIC section ids that occupy the same string slot as a
// fact id (`FactRow.factId`), so the gradient key, the section testID, the
// section-visit key, and the fact-feed route all keep working unchanged. They
// are namespaced with a `headline-` prefix that no WatermelonDB-generated fact
// id can collide with (WMDB ids are alphanumeric — no `-`).

/** The headline scopes that get their own Dashboard section. `CITY` exists in
 *  the persisted enum but is never requested as its own retrieval scope today
 *  (`buildRetrievalProfile` emits COUNTRY + GLOBAL only), so CITY rows have no
 *  section and stay dropped, exactly as before. */
export type HeadlineSectionScope = 'COUNTRY' | 'GLOBAL';

const HEADLINE_SECTION_PREFIX = 'headline-';

/** The one GLOBAL headline section's id. */
export const GLOBAL_HEADLINE_SECTION_ID = `${HEADLINE_SECTION_PREFIX}global`;

/** Synthetic section id for a per-country headline section. `countryCode` is an
 *  ISO alpha-2 code as stored on `locations.country_code` / persisted on
 *  `article_suggestions.headline_country_code`; lower-cased so the derived
 *  testID (`dashboard-section-headline-country-in`) obeys the kebab-case rule. */
export function countryHeadlineSectionId(countryCode: string): string {
  return `${HEADLINE_SECTION_PREFIX}country-${countryCode.trim().toLowerCase()}`;
}

/** True when a section id was minted by this module (i.e. the section is a
 *  headline section, not a fact section). The single authority for that test —
 *  the Dashboard, the per-section feed screen, and the selector all use it
 *  rather than re-matching the prefix in three places. */
export function isHeadlineSectionId(id: string): boolean {
  return id.startsWith(HEADLINE_SECTION_PREFIX);
}

/**
 * A headline section's pseudo-weight, on the SAME axis as a fact's own
 * `fact.weight` — this is what lets synthetic headline sections be ordered
 * against real fact sections without a second sort dimension.
 *
 * COUNTRY = `HEADLINE_SECTION_BASE` × the strongest weight among the user's
 * locations in that country (absent ⇒ 1.0); GLOBAL = the fixed
 * `GLOBAL_SECTION_WEIGHT`. Both constants are pre-existing
 * (`scoringEngine`, pinned by config.test.ts) and are used here at their
 * documented meaning: a full-weight home country (0.55) outranks a
 * down-weighted fact while default-weight (1.0) fact sections stay above every
 * headline section, and GLOBAL (0.35) sits below every country section.
 */
export function headlineSectionWeight(
  scope: HeadlineSectionScope,
  locationWeight: number | null | undefined,
  config: HarnessConfig = DEFAULT_HARNESS_CONFIG,
): number {
  const e = config.scoringEngine;
  if (scope === 'GLOBAL') return e.GLOBAL_SECTION_WEIGHT;
  return e.HEADLINE_SECTION_BASE * (locationWeight ?? 1);
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
  /** ISO alpha-2 country of the scope that injected this row. Only ever set
   *  alongside `headlineScope === 'COUNTRY'`; a COUNTRY row that carries none
   *  belongs to NO country section (see the Dashboard selector). */
  headlineCountryCode?: string | null;
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
/**
 * Build the `factId → { score, count }` candidate map from a rep's matched
 * topics. `score` = max effective weight over that fact's matched ACTIVE topics,
 * `w_eff = clamp(topic.weight × (fact.weight ?? 1) × (highPriority?hpMult:1), -1, 1)`;
 * `count` = how many of the rep's topics resolved to that fact (breadth). Shared
 * by the strict {@link resolveOwnership} and the lenient
 * {@link resolveOwningFactLenient} so the two never drift.
 */
function computeFactCandidates(
  rep: ScoredSuggestionProjection,
  topics: Map<string, TopicSnapshot>,
  facts: Map<string, FactSnapshot>,
  hpMult: number,
): Map<string, { score: number; count: number }> {
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
  return candidates;
}

/** Pick the best-ranked candidate fact whose score passes the eligibility bar
 *  (`> 0` strict / `>= 0` lenient), applying the {@link factBeats} tie-break
 *  chain. Returns null when no candidate is eligible. */
function pickWinner(
  candidates: Map<string, { score: number; count: number }>,
  facts: Map<string, FactSnapshot>,
  allowZero: boolean,
): string | null {
  let winner: string | null = null;
  let winStats: { score: number; count: number } | null = null;
  for (const [factId, stats] of candidates) {
    if (allowZero ? stats.score < 0 : stats.score <= 0) continue;
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
  return winner;
}

export function resolveOwnership(
  rep: ScoredSuggestionProjection,
  topics: Map<string, TopicSnapshot>,
  facts: Map<string, FactSnapshot>,
  hpMult: number = DEFAULT_HARNESS_CONFIG.scoringEngine.HP_MULT,
): OwnershipResolution {
  const candidates = computeFactCandidates(rep, topics, facts, hpMult);
  const winner = pickWinner(candidates, facts, false); // strict: score > 0 owns
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

/**
 * LENIENT owning-fact resolution for the Dashboard's fact sections. Unlike the
 * strict {@link resolveOwningFact}, a fact whose best effective weight is exactly
 * 0 (an ACTIVE but no-signal match) still OWNS the group — so a low-signal story
 * folds into the fact it actually matched instead of a separate "Also for you"
 * catch-all. Positive matches still win over zero ones (same {@link factBeats}
 * tie-break). Returns null only when the group has no fact to belong to:
 *  - every matched fact is NEGATIVE (suppressed — stays dropped), or
 *  - it matched no active fact-linked topic at all (factless: tracked/exploration
 *    /deleted-fact topics) — the Dashboard drops these rather than showing them.
 */
export function resolveOwningFactLenient(
  rep: ScoredSuggestionProjection,
  topics: Map<string, TopicSnapshot>,
  facts: Map<string, FactSnapshot>,
  hpMult: number = DEFAULT_HARNESS_CONFIG.scoringEngine.HP_MULT,
): string | null {
  const candidates = computeFactCandidates(rep, topics, facts, hpMult);
  return pickWinner(candidates, facts, true); // lenient: score >= 0 owns
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
