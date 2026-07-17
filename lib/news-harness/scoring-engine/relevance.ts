// scoring-engine — the deterministic math relevance engine (Wave 7a).
//
// Pure, RN-free, testable. computeRelevance() produces a raw score in the
// EXISTING 0.05–1.10 band so bucketScores / discardLowRelevance /
// reasonRelevanceThreshold / eval-golden.js keep working with zero contract
// change. The LLM judge (later wave) only confirms/adjusts this number; here the
// math stands alone.
//
// Formula (SUB-PLAN M §2.2 + A6, Wave 7b breadth + vectorScore modulation):
//   topicComp: strongest matched topic's weight, each positive weight first
//              scaled by smoothstep(vectorScore, VS_LO, VS_HI) (absent → ×1).
//   breadthComp = clamp((#distinct positive matched topics − 1)/BREADTH_SAT, 0,1)
//   affinity = W_TOPIC·topicComp + W_BREADTH·breadthComp + W_GEO·geoComp
//            + W_ENTITY·entityComp + W_EVENT·eventComp + W_PUB·pubComp
//            + W_POP·popComp + W_FRESH·freshComp
//   mathBase = clamp(BASE_OFFSET + BASE_SLOPE·clampPos(affinity), BASE_MIN, BASE_MAX)
//   base     = headlineScope ? max(mathBase, HEADLINE_BASE_FLOOR + HEADLINE_POP_LIFT·popComp)
//                            : mathBase                                   (before penalties)
//   raw      = clamp(base − negTopicPenalty − suppressPenalty − wrongLocPenalty − seenPenalty,
//                    BASE_MIN, BASE_MAX)

import type { ScoringEngineConfig } from '../core/config';
import {
  normText,
  type PersonaScoringContext,
} from './persona-context';
import {
  resolveGeoMatch,
  type ArticleGeoTag,
  type GeoAlignment,
  type GeoMatchResult,
} from './geo';

export type ScoringMode = 'math' | 'backstop';

export type HeadlineScope = 'CITY' | 'COUNTRY' | 'GLOBAL';

/** One matched topic on a candidate. effectiveWeight is precomputed by the
 *  caller = clamp(topic.weight × (fact.weight ?? 1), -1, 1); highPriority is
 *  applied here (score-only) via HP_MULT. */
export interface MatchedTopicInput {
  topicId: string | null;
  /** Human topic text — surfaced to the judge's "why" phrase (never used in
   *  the math). Optional; absent for synthetic headline entries. */
  text?: string;
  effectiveWeight: number;
  highPriority?: boolean;
  /** Set when the topic is location-anchored → drives wrong-location. */
  locationId?: string;
  /** Server geoMatch hint (advisory only; on-device geo.ts is authoritative). */
  geoMatch?: GeoAlignment;
  vectorScore?: number;
}

/** Plain candidate input — no DB/RN. */
export interface ScoredCandidateInput {
  id: string;
  titleEn?: string | null;
  descriptionEn?: string | null;
  publicationName?: string | null;
  countryCode?: string | null;
  pubDateMs?: number | null;
  maxClusterSize?: number | null;
  eventType?: string | null;
  category?: string | null;
  geoTags?: ArticleGeoTag[];
  entities?: string[];
  matchedTopics: MatchedTopicInput[];
  headlineScope?: HeadlineScope | null;
  /** Stable cluster id (for seen-story dedup against seenStoryIds). */
  stableClusterId?: string | null;
}

export interface RelevanceComponents {
  topicComp: number;
  breadthComp: number;
  geoComp: number;
  geoAlignment: GeoAlignment;
  entityComp: number;
  eventComp: number;
  pubComp: number;
  popComp: number;
  freshComp: number;
  affinity: number;
  /** base before the headline floor. */
  mathBase: number;
  /** base after the headline floor, before penalties. */
  base: number;
  negTopicPenalty: number;
  suppressPenalty: number;
  wrongLocPenalty: number;
  seenPenalty: number;
  wrongLocationFlag: 0 | 1;
  matchedLocationId?: string;
}

export interface RelevanceResult {
  /** Raw score in [BASE_MIN, BASE_MAX] — the value buckets/eval consume. */
  score: number;
  components: RelevanceComponents;
  mode: ScoringMode;
}

const clampPos = (x: number): number => (x > 0 ? x : 0);
const clamp = (x: number, lo: number, hi: number): number =>
  x < lo ? lo : x > hi ? hi : x;

/** Smooth Hermite step: 0 below `lo`, 1 above `hi`, S-curve between. */
function smoothstep(x: number, lo: number, hi: number): number {
  if (hi <= lo) return x >= hi ? 1 : 0;
  const t = clamp((x - lo) / (hi - lo), 0, 1);
  return t * t * (3 - 2 * t);
}

/** Event types that are personally actionable when tied to an interest — a
 *  small nudge (breaking local weather/disaster/crime/etc.). */
const ACTIONABLE_EVENT_TYPES = new Set([
  'disaster',
  'weather',
  'accident',
  'conflict',
  'crime',
  'health',
  'election',
]);

/**
 * The "signedSoftmaxMax" of §2.2 with a sharp temperature → the single
 * strongest-magnitude matched topic dominates (sign preserved). A solo topic
 * returns its own value; adding a weaker topic never lowers the result
 * (monotone), and a strongly-negative learned topic wins over a weaker positive
 * so it can gut the score via clampPos + P_NEG.
 */
function signedMaxByMagnitude(values: number[]): number {
  let best = 0;
  let bestMag = -1;
  for (const v of values) {
    const mag = Math.abs(v);
    if (mag > bestMag) {
      bestMag = mag;
      best = v;
    }
  }
  return best;
}

/** popComp = clamp(log2(1+n)/log2(1+POP_SAT), 0, 1); 0 when size unknown. */
function popularity(maxClusterSize: number | null | undefined, cfg: ScoringEngineConfig): number {
  if (!maxClusterSize || maxClusterSize <= 1) return 0;
  const v = Math.log2(1 + maxClusterSize) / Math.log2(1 + cfg.POP_SAT);
  return clamp(v, 0, 1);
}

/** freshness: 1.0 ≤ FRESH_FULL_HOURS, linear → FRESH_MID_SCORE at
 *  FRESH_DECAY_HOURS, FRESH_OLD_SCORE beyond. Unknown date → FRESH_OLD_SCORE. */
function freshness(
  pubDateMs: number | null | undefined,
  nowMs: number,
  cfg: ScoringEngineConfig,
): number {
  if (pubDateMs == null || Number.isNaN(pubDateMs)) return cfg.FRESH_OLD_SCORE;
  const ageH = (nowMs - pubDateMs) / 3_600_000;
  if (ageH <= cfg.FRESH_FULL_HOURS) return 1.0;
  if (ageH >= cfg.FRESH_DECAY_HOURS) return cfg.FRESH_OLD_SCORE;
  const t = (ageH - cfg.FRESH_FULL_HOURS) / (cfg.FRESH_DECAY_HOURS - cfg.FRESH_FULL_HOURS);
  return 1.0 + t * (cfg.FRESH_MID_SCORE - 1.0);
}

/** entityComp = max persona interest over the article's entities (0 if none). */
function maxEntityInterest(
  entities: string[] | undefined,
  interest: Map<string, number> | undefined,
): number {
  if (!entities?.length || !interest?.size) return 0;
  let best = 0;
  for (const e of entities) {
    const w = interest.get(normText(e));
    if (w && w > best) best = w;
  }
  return clamp(best, 0, 1);
}

/** Small event-type affinity: actionable types with at least one matched topic. */
function eventTypeAffinity(
  eventType: string | null | undefined,
  matchedTopics: MatchedTopicInput[],
): number {
  if (!eventType || !ACTIONABLE_EVENT_TYPES.has(eventType)) return 0;
  const hasPositiveTopic = matchedTopics.some((t) => t.effectiveWeight > 0);
  return hasPositiveTopic ? 0.5 : 0;
}

/** pubComp: preference weight for the article's publication (0 default). */
function pubPref(
  publicationName: string | null | undefined,
  prefs: Map<string, number>,
): number {
  if (!publicationName) return 0;
  return prefs.get(normText(publicationName)) ?? 0;
}

/** suppressPenalty: Σ P_SUP·strength over soft suppressions whose keyword hits
 *  the article's title/description/entities; capped at P_SUP_CAP. */
function suppressionPenalty(
  candidate: ScoredCandidateInput,
  ctx: PersonaScoringContext,
  cfg: ScoringEngineConfig,
): number {
  if (!ctx.softSuppressions?.length) return 0;
  const haystack = [
    normText(candidate.titleEn ?? ''),
    normText(candidate.descriptionEn ?? ''),
    ...(candidate.entities ?? []).map(normText),
  ].join('  ');
  let sum = 0;
  for (const s of ctx.softSuppressions) {
    const hit = s.keywords.some((k) => {
      const kk = normText(k);
      return kk.length > 0 && haystack.includes(kk);
    });
    if (hit) sum += cfg.P_SUP * s.strength;
  }
  return Math.min(cfg.P_SUP_CAP, sum);
}

/** A candidate is `backstop` (route to legacy LLM scoring) only when it carries
 *  NO geo tags AND NO entities AND NO event type — i.e. never tagged. A
 *  tagged-but-empty article (event_type 'other') is still `math`. */
function isBackstop(candidate: ScoredCandidateInput): boolean {
  return (
    (candidate.geoTags?.length ?? 0) === 0 &&
    (candidate.entities?.length ?? 0) === 0 &&
    !candidate.eventType
  );
}

/**
 * Compute the deterministic relevance for one candidate.
 *
 * @param nowMs reference "now" for freshness (defaults to Date.now()); pass a
 *        fixed value in replays/eval for determinism.
 */
export function computeRelevance(
  candidate: ScoredCandidateInput,
  persona: PersonaScoringContext,
  config: ScoringEngineConfig,
  nowMs: number = Date.now(),
): RelevanceResult {
  const mode: ScoringMode = isBackstop(candidate) ? 'backstop' : 'math';

  // --- topicComp (score-only HP lift, re-clamped to |w|≤1) ----------------
  // Positive weights are additionally scaled by the topic's vectorScore via
  // smoothstep (a weak semantic match is suppressed); a missing vectorScore is
  // neutral (×1). Negative weights pass through unmodulated so a learned
  // negative topic still demotes regardless of retrieval similarity.
  const weighted = candidate.matchedTopics.map((t) => {
    const w = clamp(t.effectiveWeight * (t.highPriority ? config.HP_MULT : 1), -1, 1);
    if (w > 0 && t.vectorScore != null) {
      return w * smoothstep(t.vectorScore, config.VS_LO, config.VS_HI);
    }
    return w;
  });
  const topicComp = signedMaxByMagnitude(weighted);
  const maxNegativeMatchedWeight = candidate.matchedTopics.reduce(
    (mx, t) => Math.max(mx, t.effectiveWeight < 0 ? -t.effectiveWeight : 0),
    0,
  );

  // --- breadthComp: distinct positive matched topics discriminate FEED from
  //     the single-spurious-topic tail (EXCL≈1.26 vs FEED≈2.85 matched topics).
  const positiveMatchCount = candidate.matchedTopics.reduce(
    (n, t) => n + (t.effectiveWeight > 0 ? 1 : 0),
    0,
  );
  const breadthComp = clamp((positiveMatchCount - 1) / config.BREADTH_SAT, 0, 1);

  // --- geo ----------------------------------------------------------------
  const anchoredLocationIds = new Set(
    candidate.matchedTopics
      .filter((t) => t.effectiveWeight > 0 && t.locationId)
      .map((t) => t.locationId as string),
  );
  const geo: GeoMatchResult = resolveGeoMatch(
    candidate.geoTags ?? [],
    persona.locations,
    config,
    anchoredLocationIds,
  );

  // --- remaining components -----------------------------------------------
  const geoComp = geo.geoScore;
  const entityComp = maxEntityInterest(candidate.entities, persona.entityInterest);
  const eventComp = eventTypeAffinity(candidate.eventType, candidate.matchedTopics);
  const pubComp = pubPref(candidate.publicationName, persona.pubPrefs);
  const popComp = popularity(candidate.maxClusterSize, config);
  const freshComp = freshness(candidate.pubDateMs, nowMs, config);

  const affinity =
    config.W_TOPIC * topicComp +
    config.W_BREADTH * breadthComp +
    config.W_GEO * geoComp +
    config.W_ENTITY * entityComp +
    config.W_EVENT * eventComp +
    config.W_PUB * pubComp +
    config.W_POP * popComp +
    config.W_FRESH * freshComp;

  const mathBase = clamp(
    config.BASE_OFFSET + config.BASE_SLOPE * clampPos(affinity),
    config.BASE_MIN,
    config.BASE_MAX,
  );

  // Headline floor (BEFORE penalties): a COUNTRY/GLOBAL headline clears the 0.3
  // render gate even with topicComp 0 — but penalties still apply below, so a
  // suppressed or wrong-city headline still dies.
  const base = candidate.headlineScope
    ? Math.max(mathBase, config.HEADLINE_BASE_FLOOR + config.HEADLINE_POP_LIFT * popComp)
    : mathBase;

  // --- penalties ----------------------------------------------------------
  const negTopicPenalty = config.P_NEG * maxNegativeMatchedWeight;
  const suppressPenalty = suppressionPenalty(candidate, persona, config);
  const wrongLocPenalty = config.P_WRONG * geo.wrongLocationFlag;
  const seen =
    persona.seenStoryIds &&
    (persona.seenStoryIds.has(candidate.id) ||
      (candidate.stableClusterId != null && persona.seenStoryIds.has(candidate.stableClusterId)))
      ? 1
      : 0;
  const seenPenalty = config.P_SEEN * seen;

  const score = clamp(
    base - negTopicPenalty - suppressPenalty - wrongLocPenalty - seenPenalty,
    config.BASE_MIN,
    config.BASE_MAX,
  );

  return {
    score,
    mode,
    components: {
      topicComp,
      breadthComp,
      geoComp,
      geoAlignment: geo.alignment,
      entityComp,
      eventComp,
      pubComp,
      popComp,
      freshComp,
      affinity,
      mathBase,
      base,
      negTopicPenalty,
      suppressPenalty,
      wrongLocPenalty,
      seenPenalty,
      wrongLocationFlag: geo.wrongLocationFlag,
      matchedLocationId: geo.matchedLocationId,
    },
  };
}
