// feed-select — fact-sectioned For-You feed selector (Wave 7b-core M-P5b).
//
// PURE, RN-free. No imports of lib/database, lib/stores, expo, react-native, or
// watermelondb — it consumes plain projections (the store/UI sub-plan maps the
// WatermelonDB rows into these shapes and renders the result verbatim).
//
// `selectSections` turns a scored suggestion pool into ordered feed sections
// (one section per owning fact, plus synthetic headline sections), guaranteeing
// each STORY lands in exactly one section. See SUB-PLAN M addendum §A1
// (fact-sectioned feed selector) and the master plan's Breaking-strip decision.
//
// Pipeline: story-group FIRST → pick a representative per group → assign each
// group to a section via its representative → extract breaking → fold 1-item
// sections into "also_for_you" → order sections on one weight axis.

import {
  buildStoryGroups,
  pickRepresentative,
  TITLE_JACCARD_DISPLAY_THRESHOLD,
  CLUSTER_CORE_CONFIDENCE_THRESHOLD,
  type GroupableItem,
} from '../../feed-grouping/story-grouping';
import {
  DEFAULT_HARNESS_CONFIG,
  type HarnessConfig,
} from '../core/config';

// --- Bucket (display tier) ------------------------------------------------

/** The four persisted relevance tiers + an UNSCORED sentinel for rows that
 *  never cleared scoring (progressive-render placeholders / discarded). */
export type FeedBucket = 'EMERGENCY' | 'HIGH' | 'MEDIUM' | 'LOW' | 'UNSCORED';

/** Total-order rank for a bucket (higher = more prominent). Shared with the
 *  swipe deck (feed-select/deck.ts) as the first insertion-order key. */
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

/** The plain per-suggestion projection the selector reads. */
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
   *  scope, used to title + split the synthetic section. */
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
  /** Human fact statement — the fact section title. */
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

export interface SelectSectionsInput {
  suggestions: ScoredSuggestionProjection[];
  topics: Map<string, TopicSnapshot>;
  facts: Map<string, FactSnapshot>;
  locations: Map<string, LocationSnapshot>;
  config?: HarnessConfig;
}

// --- Output ---------------------------------------------------------------

export interface SectionGroup {
  representativeId: string;
  /** All member suggestion ids (representative included), in input order. */
  memberIds: string[];
  rawScore: number | null;
  bucket: FeedBucket;
}

/** `also` = the folded bucket of every 1-item section (master decision). */
export type SectionKind = 'fact' | 'headline' | 'also';

export interface FeedSection {
  key: string;
  kind: SectionKind;
  title: string;
  weight: number;
  factId?: string;
  scope?: 'CITY' | 'COUNTRY' | 'GLOBAL';
  locationId?: string;
  groups: SectionGroup[];
}

export interface BreakingItem {
  representativeId: string;
  memberIds: string[];
  rawScore: number | null;
  bucket: FeedBucket;
}

export interface SelectSectionsResult {
  breaking: BreakingItem[];
  sections: FeedSection[];
}

// --- Internals ------------------------------------------------------------

const BREAKING_EVENT_TYPES = new Set(['disaster', 'weather', 'conflict']);
const ALSO_SECTION_KEY = 'also_for_you';

interface GroupState extends GroupableItem {
  // GroupableItem: { id, title, clusters }
  index: number; // original input position (determinism)
  rep: ScoredSuggestionProjection;
  memberIds: string[];
  rawScore: number | null;
  bucket: FeedBucket;
}

/** rawScore for sorting: null (unscored) sorts BELOW every scored value. */
function scoreKey(raw: number | null): number {
  return raw == null ? Number.NEGATIVE_INFINITY : raw;
}

/** Representative comparator (over the per-item GroupStates): highest rawScore →
 *  newest → smallest id. Returns <0 when `a` is preferred over `b`. */
function repCompare(a: GroupState, b: GroupState): number {
  const sa = scoreKey(a.rep.rawScore);
  const sb = scoreKey(b.rep.rawScore);
  if (sa !== sb) return sb - sa; // desc
  if (a.rep.pubDateMs !== b.rep.pubDateMs) return b.rep.pubDateMs - a.rep.pubDateMs;
  return a.rep.id < b.rep.id ? -1 : a.rep.id > b.rep.id ? 1 : 0;
}

function toSectionGroup(g: GroupState): SectionGroup {
  return {
    representativeId: g.rep.id,
    memberIds: g.memberIds,
    rawScore: g.rawScore,
    bucket: g.bucket,
  };
}

function isBreaking(rep: ScoredSuggestionProjection): boolean {
  const raw = rep.rawScore;
  if (raw == null) return false;
  if (raw > 1.0) return true;
  return (
    raw >= 0.8 && rep.eventType != null && BREAKING_EVENT_TYPES.has(rep.eventType)
  );
}

/**
 * Why a group's representative has no positive-weight owning fact. Drives the
 * step-4 degrade decision (M-P5b fix — orphaned-but-valuable groups must DEGRADE
 * to `also_for_you`, not vanish):
 *  - `owned`    — an active, positive-weight fact wins → gets a fact section.
 *  - `orphan`   — no active fact resolved (retired/suppressed topic, deleted
 *                 fact, null factId, missing topic), OR the strongest active
 *                 effective weight is exactly 0 (active fact, no signal either
 *                 way). Degradable: falls through to `also_for_you` if relevant.
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
 * Only facts with factScore > 0 are eligible to OWN a section (negative-only
 * matches own no section — already score-gutted by P_NEG). When no fact owns,
 * the strongest active effective weight decides orphan (≥ 0 / none) vs negative
 * (< 0).
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
    if (stats.score <= 0) continue; // ≤ 0 → owns no section
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
  // NEGATIVE signal (strongest active effective weight < 0 — user actively
  // doesn't want this). Empty candidates ⇒ nothing active resolved ⇒ orphan.
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

/** Section ordering: weight desc → kind (fact < headline < also) → key. */
function sectionKindRank(kind: SectionKind): number {
  return kind === 'fact' ? 0 : kind === 'headline' ? 1 : 2;
}

function sectionCompare(a: FeedSection, b: FeedSection): number {
  if (a.weight !== b.weight) return b.weight - a.weight; // desc
  const ka = sectionKindRank(a.kind);
  const kb = sectionKindRank(b.kind);
  if (ka !== kb) return ka - kb;
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

interface HeadlineMeta {
  key: string;
  title: string;
  weight: number;
  scope: 'CITY' | 'COUNTRY' | 'GLOBAL';
  locationId?: string;
}

/** Build the synthetic-section identity for a headline group's representative. */
function headlineMeta(
  rep: ScoredSuggestionProjection,
  locations: Map<string, LocationSnapshot>,
  config: HarnessConfig,
): HeadlineMeta {
  const e = config.scoringEngine;
  const scope = rep.headlineScope as 'CITY' | 'COUNTRY' | 'GLOBAL';
  if (scope === 'GLOBAL') {
    return {
      key: 'headline:GLOBAL',
      title: 'Top stories · Worldwide',
      weight: e.GLOBAL_SECTION_WEIGHT,
      scope,
    };
  }
  const locId = rep.headlineLocationId ?? undefined;
  const loc = locId ? locations.get(locId) : undefined;
  const locWeight = loc?.weight ?? 1;
  const weight = e.HEADLINE_SECTION_BASE * locWeight;
  if (scope === 'CITY') {
    const city = loc?.city?.trim();
    return {
      key: locId ? `headline:CITY:${locId}` : 'headline:CITY',
      title: city ? `Local headlines · ${city}` : 'Local headlines',
      weight,
      scope,
      locationId: locId,
    };
  }
  // COUNTRY
  const country = loc?.country?.trim() || loc?.countryCode?.trim();
  return {
    key: locId ? `headline:COUNTRY:${locId}` : 'headline:COUNTRY',
    title: country ? `Top stories · ${country}` : 'Top stories',
    weight,
    scope,
    locationId: locId,
  };
}

// --- Public API -----------------------------------------------------------

/**
 * Turn a scored suggestion pool into ordered feed sections + a breaking strip.
 *
 * Guarantees:
 *  - Story grouping runs FIRST (buildStoryGroups over the whole pool), so a
 *    multi-source story is assigned as ONE group and can never straddle two
 *    sections (single-section guarantee).
 *  - Each group is assigned to exactly one section via its representative.
 *  - Breaking groups (raw>1.0, or disaster/weather/conflict with raw≥0.8) are
 *    pulled OUT of sections into `breaking` (shown in the compact strip only).
 *  - 1-item sections fold into a single trailing `also_for_you` section.
 *  - Sections order by weight desc → kind (fact<headline) → key.
 */
export function selectSections(input: SelectSectionsInput): SelectSectionsResult {
  const config = input.config ?? DEFAULT_HARNESS_CONFIG;
  const hpMult = config.scoringEngine.HP_MULT;
  const { suggestions, topics, facts, locations } = input;

  // 1. Story-group the whole pool. Display context → display Jaccard bar.
  const items: GroupState[] = suggestions.map((s, index) => ({
    id: s.id,
    title: s.title ?? null,
    clusters: s.clusterMemberships,
    index,
    rep: s, // provisional; overwritten below
    memberIds: [],
    rawScore: null,
    bucket: 'UNSCORED' as FeedBucket,
  }));
  const byId = new Map<string, ScoredSuggestionProjection>();
  for (const s of suggestions) byId.set(s.id, s);

  const groups = buildStoryGroups(items, {
    titleJaccardThreshold: TITLE_JACCARD_DISPLAY_THRESHOLD,
    clusterConfidenceThreshold: CLUSTER_CORE_CONFIDENCE_THRESHOLD,
  });

  // 2. Pick a representative per group; snapshot memberIds/rawScore/bucket.
  const groupStates: GroupState[] = groups.map((g) => {
    const repItem = pickRepresentative(g, repCompare);
    const rep = repItem.rep;
    return {
      id: rep.id,
      title: rep.title ?? null,
      clusters: rep.clusterMemberships,
      index: g[0].index,
      rep,
      memberIds: g.map((it) => it.id), // input order (buildStoryGroups preserves)
      rawScore: rep.rawScore,
      bucket: bucketOf(rep.relevance, config),
    };
  });

  // 3. Breaking extraction — pulled out ABOVE sections.
  const breaking: BreakingItem[] = [];
  const sectionable: GroupState[] = [];
  for (const gs of groupStates) {
    if (isBreaking(gs.rep)) {
      breaking.push({
        representativeId: gs.rep.id,
        memberIds: gs.memberIds,
        rawScore: gs.rawScore,
        bucket: gs.bucket,
      });
    } else {
      sectionable.push(gs);
    }
  }
  breaking.sort((a, b) => {
    const sa = scoreKey(a.rawScore);
    const sb = scoreKey(b.rawScore);
    if (sa !== sb) return sb - sa;
    const pa = byId.get(a.representativeId)!.pubDateMs;
    const pb = byId.get(b.representativeId)!.pubDateMs;
    if (pa !== pb) return pb - pa;
    return a.representativeId < b.representativeId ? -1 : 1;
  });

  // 4. Assign each remaining group to a section (fact → headline → degrade/drop).
  const factSections = new Map<string, FeedSection>();
  const headlineSections = new Map<string, FeedSection>();
  // Orphaned-but-valuable groups that degrade into `also_for_you` (M-P5b fix).
  const degradedGroups: SectionGroup[] = [];
  // Standard For-You render gate (rows render only when relevance > this — see
  // for-you-store / feed-sections-selector). Reused, NOT a new threshold.
  const renderGate = config.articlePipeline.reasonRelevanceThreshold;

  for (const gs of sectionable) {
    const ownership = resolveOwnership(gs.rep, topics, facts, hpMult);
    if (ownership.kind === 'owned') {
      const factId = ownership.factId;
      let sec = factSections.get(factId);
      if (!sec) {
        const fact = facts.get(factId);
        sec = {
          key: `fact:${factId}`,
          kind: 'fact',
          title: fact?.statement?.trim() || factId,
          weight: fact?.weight ?? 1,
          factId,
          groups: [],
        };
        factSections.set(factId, sec);
      }
      sec.groups.push(toSectionGroup(gs));
      continue;
    }
    // No positive-weight owning fact. Precedence:
    //  (a) headlineScope → synthetic headline section (unchanged behavior).
    if (gs.rep.headlineScope) {
      const meta = headlineMeta(gs.rep, locations, config);
      let sec = headlineSections.get(meta.key);
      if (!sec) {
        sec = {
          key: meta.key,
          kind: 'headline',
          title: meta.title,
          weight: meta.weight,
          scope: meta.scope,
          locationId: meta.locationId,
          groups: [],
        };
        headlineSections.set(meta.key, sec);
      }
      sec.groups.push(toSectionGroup(gs));
      continue;
    }
    // (b) Three-way orphan/negative rule — orphaned-but-valuable groups must
    //     DEGRADE, not disappear (the prod incident: deleting/retiring an AI
    //     persona orphaned an entire cluster of relevance-0.6 stories and the
    //     feed appeared gutted). See {@link OwnershipResolution}:
    //       - orphan (missing/inactive fact, null factId, or effective weight
    //         exactly 0 — no signal either way) AND representative clears the
    //         standard render gate (relevance > 0.3) → fall through to
    //         `also_for_you`.
    //       - negative (matched topic effective weight < 0 — user actively
    //         doesn't want it) → stay DROPPED (suppression working as intended).
    //       - orphan BELOW the render gate → stay DROPPED (not worth showing).
    if (ownership.kind === 'orphan' && (gs.rep.relevance ?? 0) > renderGate) {
      degradedGroups.push(toSectionGroup(gs));
    }
  }

  // 5. Order groups within each section; fold 1-item sections into also_for_you.
  const allSections = [
    ...factSections.values(),
    ...headlineSections.values(),
  ];
  const multiGroupSections: FeedSection[] = [];
  // also_for_you pool: folded 1-item sections + degraded orphaned groups (M-P5b).
  const alsoGroups: SectionGroup[] = [...degradedGroups];
  for (const sec of allSections) {
    sec.groups.sort((a, b) =>
      groupCompareFromSectionGroup(a, b, byId),
    );
    if (sec.groups.length <= 1) {
      alsoGroups.push(...sec.groups);
    } else {
      multiGroupSections.push(sec);
    }
  }

  multiGroupSections.sort(sectionCompare);

  const result: FeedSection[] = multiGroupSections;
  if (alsoGroups.length > 0) {
    alsoGroups.sort((a, b) => groupCompareFromSectionGroup(a, b, byId));
    result.push({
      key: ALSO_SECTION_KEY,
      kind: 'also',
      title: 'Also for you',
      weight: Number.NEGATIVE_INFINITY, // always last
      groups: alsoGroups,
    });
  }

  return { breaking, sections: result };
}

/** groupCompare over SectionGroup (needs the representative's pubDate). */
function groupCompareFromSectionGroup(
  a: SectionGroup,
  b: SectionGroup,
  byId: Map<string, ScoredSuggestionProjection>,
): number {
  const sa = scoreKey(a.rawScore);
  const sb = scoreKey(b.rawScore);
  if (sa !== sb) return sb - sa;
  const pa = byId.get(a.representativeId)!.pubDateMs;
  const pb = byId.get(b.representativeId)!.pubDateMs;
  if (pa !== pb) return pb - pa;
  return a.representativeId < b.representativeId ? -1 : 1;
}
