// scoring-engine — the deterministic math relevance engine.
//
// Pure, RN-free, testable. computeRelevance() produces a raw score in the
// EXISTING 0.05–1.10 band so bucketScores / discardLowRelevance /
// reasonRelevanceThreshold / eval-golden.js keep working with zero contract
// change.
//
// WHAT THIS IS FOR NOW THAT THE JUDGE IS GONE.
//
// The judge that consumed the math score — comparing it, adjusting it, feeding
// the calibration loop — has been deleted, and the LLM score from the legacy
// tiered pass is what gets persisted as `relevance`. This engine is NOT dead
// code; it has three live consumers, and the first is the important one:
//
//   1. SUPPRESSION. `components.suppressPenalty` is the user's "shown less"
//      filters expressed as a number, and `run-stage` subtracts it from the LLM
//      score. The LLM knows nothing about those filters, so without this the
//      soft half of "not interested" would be inert on every article. Its
//      sibling — the HARD screen — runs in `screenHardSuppressions*` off the
//      same matcher, before this function is called.
//   2. THE HEADLINE EXEMPTION (P6). `components.hardFilterExempt` is what
//      floors a hard-filtered top headline at HEADLINE_BASE_FLOOR instead of
//      removing it: demoted, never disappeared.
//   3. FAIL-OPEN. `score` is the value that stands when the LLM call fails, so
//      a dead gateway degrades the feed's ranking instead of emptying it.
//
// The affinity components themselves (topicComp / breadthComp / geoComp /
// entityComp / eventComp / pubComp / popComp and the non-suppression penalties)
// no longer steer anything on their own: they feed `score` — i.e. consumers 1
// and 3 above — and are persisted into `score_components_json` as an audit
// trail. `mode` is likewise diagnostic only now (the Observability funnel counts
// it); nothing routes on it. None of them are deleted, because `score` is a
// weighted sum of all of them and the fail-open value has to stay meaningful.
//
// ⚠ THE TAG-FED COMPONENTS HAVE NEVER RUN ON REAL DATA. Read this before
// trusting a fail-open score.
//
// `geoComp`, `entityComp`, `eventComp` and `wrongLocPenalty` are computed from
// the server's `geoTags` / `entities` / `eventType`. Until the `USE_ARTICLE_TAGS`
// gate was deleted, `applyArticleTagPolicy` blanked all three before this
// function ever saw them, so those four terms were HARD ZERO on every article
// in production — their weights (W_GEO 0.217, W_ENTITY 0.087, W_EVENT 0.054:
// ~36% of the positive weight budget) were carried but never exercised.
//
// The gate was removed because it was silently breaking a user-facing feature:
// the card feedback surface CREATES `event_type` / `entity` / `place`
// suppressions (`feedback-tree/resolve-leaf-actions.ts`,
// `persona-management/feedback-digest.ts`), and blanking the columns they match
// on meant those filters were stored, shown to the user, and matched nothing.
// Unblanking fixes that — and, as a deliberate and accepted side effect, turns
// those four scoring terms on for the first time.
//
// What that actually moves, in order of how much it matters:
//   - the FAIL-OPEN score (consumer 3). A tagged article whose LLM call fails
//     now scores differently — usually HIGHER, since three positive components
//     can now contribute. This is the live behaviour change; it is pinned by a
//     test ("the fail-open score is tag-sensitive").
//   - `hardFilterExempt` / the headline floor (consumer 2) reads the same score.
//   - `mode` flips from 'backstop' to 'math' for tagged rows, which moves the
//     Observability funnel's two counters. Nothing routes on it.
// It does NOT move what is normally persisted as `relevance`: that is the LLM's
// score on every successful call.
//
// HOW WELL MEASURED ARE THEY? Narrower than "unvalidated", and worth stating
// precisely. They have never run in PRODUCTION, but they HAVE been measured
// offline at corpus scale: `eval/lib/build-eval-scores.ts --engine=math` feeds
// `golden-tags.json` straight into this function with no blanking, and on the
// 1,000-article prod baseline `geoComp` fires on 465 rows, `eventComp` on 237
// and `wrongLocPenalty` on 90 (the `math` row in eval/README.md is that
// measurement). `entityComp` is the genuine unknown — 0/1000, because the eval
// persona expresses no entity interest and `entityInterest` is still unwired.
//
// The useful consequence: `--engine=math` used to DIVERGE from the app (the eval
// fed tags, the app blanked them). It now describes shipped engine behaviour, so
// its numbers are worth trusting again.
//
// Formula (SUB-PLAN M §2.2 + A6, Wave 7b breadth + vectorScore modulation):
//   topicComp: strongest matched topic's weight, each positive weight first
//              scaled by smoothstep(vectorScore, VS_LO, VS_HI) (absent → ×1).
//   breadthComp = clamp((#distinct positive matched topics − 1)/BREADTH_SAT, 0,1)
//   affinity = W_TOPIC·topicComp + W_BREADTH·breadthComp + W_GEO·geoComp
//            + W_ENTITY·entityComp + W_EVENT·eventComp + W_PUB·pubComp
//            + W_POP·popComp
//   (Round-3 A2: age/freshness decay removed — recency is honored by the
//    fact-rows view's pubDate ordering, not the score.)
//   mathBase = clamp(BASE_OFFSET + BASE_SLOPE·clampPos(affinity), BASE_MIN, BASE_MAX)
//   base     = headlineScope ? max(mathBase, HEADLINE_BASE_FLOOR + HEADLINE_POP_LIFT·popComp)
//                            : mathBase                                   (before penalties)
//   raw      = clamp(base − negTopicPenalty − suppressPenalty − wrongLocPenalty − seenPenalty,
//                    BASE_MIN, BASE_MAX)
//   (P6) a HEADLINE row matching a HARD filter is exempt from exclusion: its
//        matching hard filters join the soft list for the one capped
//        suppressPenalty, and `raw` is then floored at HEADLINE_BASE_FLOOR — so
//        it is demoted to the bottom of what renders, never removed.

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
import {
  buildSuppressionHaystack,
  isHardFilterExempt,
  matchingHardSuppressions,
  suppressionMatchesCandidate,
} from './suppression';

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
  /** Each tag's `countryCode` is ISO alpha-2 OR one of the curated
   *  supranational PLACE codes (`supranational-codes.ts`, e.g. "MIDDLE_EAST",
   *  "EU"). AUDITED: `geo.ts::resolveGeoMatch` matches it only by equality
   *  against the persona's own alpha-2 location codes, and a supranational
   *  code can never equal one (disjoint code spaces by construction), so it
   *  resolves NONE/0 rather than a false match — no name lookup, no crash. */
  geoTags?: ArticleGeoTag[];
  entities?: string[];
  matchedTopics: MatchedTopicInput[];
  headlineScope?: HeadlineScope | null;
  /** Uppercase ISO code of the country whose headline scope retrieved this
   *  candidate; only set alongside headlineScope === 'COUNTRY'. Carried so a
   *  per-country surface can tell one country's headlines from another's —
   *  the scoring formula itself does NOT read it. */
  headlineCountryCode?: string | null;
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
  affinity: number;
  /** base before the headline floor. */
  mathBase: number;
  /** base after the headline floor, before penalties. */
  base: number;
  negTopicPenalty: number;
  /** Σ P_SUP·strength over matching NON-entity soft suppressions, capped at
   *  P_SUP_CAP. Subtracted from the score outright. */
  suppressPenalty: number;
  /** The `entity`-kind share, kept SEPARATE because it is applied against
   *  ENTITY_PENALTY_FLOOR rather than subtracted outright — an entity match may
   *  lower a row's rank but must never push it out of the feed (68.8%-correct
   *  extraction; see ENTITY_PENALTY_FLOOR). Optional so existing component
   *  literals keep compiling; absent reads as 0. */
  entityPenalty?: number;
  wrongLocPenalty: number;
  seenPenalty: number;
  wrongLocationFlag: 0 | 1;
  matchedLocationId?: string;
  /** P6 — this row matched a HARD "not interested" filter and was kept anyway
   *  because it is a top headline: penalised, then floored at
   *  HEADLINE_BASE_FLOOR. Optional so the many existing component literals keep
   *  compiling; absent reads as false. The UI labels such a card so a filtered
   *  subject on screen is never a surprise. */
  hardFilterExempt?: boolean;
  /** WHICH PATH SCORED THIS ROW — the same value as `RelevanceResult.mode`,
   *  carried inside the components so it survives into the persisted
   *  `score_components_json` audit (both persist sites JSON-stringify this
   *  object wholesale). That is what makes the math-vs-LLM split readable after
   *  the fact, on the Observability screen, without a parallel record or a new
   *  column. Optional so the existing component literals in tests/fixtures keep
   *  compiling; absent on rows persisted before this field existed, which the
   *  readout reports as `unknown` rather than guessing. */
  mode?: ScoringMode;
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

/**
 * The exact per-topic weight the math scores with: effectiveWeight × HP_MULT
 * (high-priority, re-clamped to [-1,1]), positives additionally scaled by
 * smoothstep(vectorScore, VS_LO, VS_HI) (absent vectorScore → ×1; negatives
 * pass through unmodulated). Shared with summarizeComponents (judge.ts) so the
 * judge's "why" phrase names the SAME winning topic + strength the math used
 * (Wave 14 — previously the summary ranked by raw effectiveWeight and could
 * mislabel the dominant topic).
 */
export function modulatedTopicWeight(
  t: MatchedTopicInput,
  cfg: ScoringEngineConfig,
): number {
  const w = clamp(t.effectiveWeight * (t.highPriority ? cfg.HP_MULT : 1), -1, 1);
  if (w > 0 && t.vectorScore != null) {
    return w * smoothstep(t.vectorScore, cfg.VS_LO, cfg.VS_HI);
  }
  return w;
}

/** popComp = clamp(log2(1+n)/log2(1+POP_SAT), 0, 1); 0 when size unknown. */
function popularity(maxClusterSize: number | null | undefined, cfg: ScoringEngineConfig): number {
  if (!maxClusterSize || maxClusterSize <= 1) return 0;
  const v = Math.log2(1 + maxClusterSize) / Math.log2(1 + cfg.POP_SAT);
  return clamp(v, 0, 1);
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

/** suppressPenalty: Σ P_SUP·strength over soft suppressions that MATCH the
 *  candidate; capped at P_SUP_CAP. Matching (per kind) is the shared matcher in
 *  suppression.ts — keyword / NULL-kind rows keep byte-identical semantics.
 *
 *  EXPORTED so any future scoring source applies the capped soft penalty by
 *  CALLING this, never by re-deriving it — a second implementation of the cap
 *  is exactly the drift this wave exists to prevent (the hard screen has the
 *  same one-matcher rule via `screenHardSuppressions`). Export only; the maths
 *  are untouched. */
export function suppressionPenalty(
  candidate: ScoredCandidateInput,
  ctx: PersonaScoringContext,
  cfg: ScoringEngineConfig,
): number {
  const { other, entity } = splitSuppressionPenalty(candidate, ctx, cfg);
  return other + entity;
}

/**
 * The same penalty, split by whether it may remove a row.
 *
 * `other` is subtracted from the score outright. `entity` is applied against
 * ENTITY_PENALTY_FLOOR by the caller, so it can lower a rank but never take a
 * renderable row out of the feed. Each side is capped at P_SUP_CAP
 * INDEPENDENTLY — sharing one cap would let a pile of entity matches crowd out
 * the reliable kinds' penalty, which is the opposite of the intent.
 */
export function splitSuppressionPenalty(
  candidate: ScoredCandidateInput,
  ctx: PersonaScoringContext,
  cfg: ScoringEngineConfig,
): { other: number; entity: number } {
  if (!ctx.softSuppressions?.length) return { other: 0, entity: 0 };
  const haystack = buildSuppressionHaystack(candidate);
  let other = 0;
  let entity = 0;
  for (const s of ctx.softSuppressions) {
    if (!suppressionMatchesCandidate(candidate, s, haystack)) continue;
    const p = cfg.P_SUP * s.strength;
    if ((s.kind ?? 'keyword') === 'entity') entity += p;
    else other += p;
  }
  return {
    other: Math.min(cfg.P_SUP_CAP, other),
    entity: Math.min(cfg.P_SUP_CAP, entity),
  };
}

/**
 * Apply an entity-kind penalty WITHOUT letting it remove the row.
 *
 * The one place the "entities nudge, never delete" rule turns into arithmetic,
 * shared by `computeRelevance` (the fail-open score) and
 * `run-stage::computeAndScore` (the LLM score) so the two cannot drift.
 *
 *   - a score at or above the floor can be pushed down TO the floor, no further;
 *   - a score already below the floor is left alone (it is not renderable
 *     anyway, and lowering it further would only be a rank change nobody sees).
 */
export function applyEntityPenalty(
  score: number,
  entityPenalty: number,
  cfg: ScoringEngineConfig,
): number {
  if (!(entityPenalty > 0)) return score;
  return Math.max(score - entityPenalty, Math.min(score, cfg.ENTITY_PENALTY_FLOOR));
}

/** A candidate is `backstop` when it carries NO geo tags AND NO entities AND NO
 *  event type — i.e. it was never tagged. A tagged-but-empty article
 *  (event_type 'other') is still `math`.
 *
 *  NO LONGER ROUTING. It used to decide whether a candidate went to the judge;
 *  the judge is gone and every candidate takes the legacy LLM path. It survives
 *  as the ONE remaining producer of `mode`, whose live consumer chain is:
 *  computeRelevance → `components.mode` → persisted in `score_components_json`
 *  → `article-suggestion-service::getScoringModeBreakdown` → the Observability
 *  feed-funnel's tagged/untagged counters. Since `applyArticleTagPolicy` was
 *  deleted this answers a real question again ("did the server tag this
 *  article?") rather than always reporting 'backstop'. */
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
 * @param nowMs reference "now" (defaults to Date.now()). Retained for signature
 *        stability / deterministic replays; no longer consumed by the math since
 *        Round-3 A2 removed freshness decay.
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
  const weighted = candidate.matchedTopics.map((t) => modulatedTopicWeight(t, config));
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

  const affinity =
    config.W_TOPIC * topicComp +
    config.W_BREADTH * breadthComp +
    config.W_GEO * geoComp +
    config.W_ENTITY * entityComp +
    config.W_EVENT * eventComp +
    config.W_PUB * pubComp +
    config.W_POP * popComp;

  const mathBase = clamp(
    config.BASE_OFFSET + config.BASE_SLOPE * clampPos(affinity),
    config.BASE_MIN,
    config.BASE_MAX,
  );

  // Headline floor (BEFORE penalties): a COUNTRY/GLOBAL headline clears the 0.3
  // render gate even with topicComp 0 — but penalties still apply below, so a
  // suppressed or wrong-city headline still dies.
  //
  // The floor clears the RENDER GATE, not the MEDIUM band (0.53): capped at
  // HEADLINE_BASE_FLOOR + HEADLINE_POP_LIFT, a floor-only headline lands in the
  // LOW band and is therefore culled after scoring by
  // feed-ordering/importance-filter::isCulledHeadlineRelevance. That is
  // intended — the floor exists to keep a headline SCOREABLE (so real affinity
  // can lift it), not to guarantee it a slot.
  const base = candidate.headlineScope
    ? Math.max(mathBase, config.HEADLINE_BASE_FLOOR + config.HEADLINE_POP_LIFT * popComp)
    : mathBase;

  // --- penalties ----------------------------------------------------------
  const negTopicPenalty = config.P_NEG * maxNegativeMatchedWeight;

  // P6 — HEADLINE EXEMPTION. A top-headline row is exempt from HARD exclusion
  // (suppression.ts::isHardFilterExempt), so unlike every other candidate it can
  // reach the math while matching a hard "not interested" filter. It must not
  // reach it UNPENALISED: the matching hard rows are folded into the soft list
  // and run through the SAME `suppressionPenalty` call, so there is still one
  // matcher and one P_SUP_CAP. Nothing changes for a non-headline row, or for a
  // headline row matching only SOFT filters (which stays killed by the floor-is-
  // before-penalties rule below).
  const exemptHard = isHardFilterExempt(candidate)
    ? matchingHardSuppressions(candidate, persona.hardSuppressions)
    : [];
  const hardFilterExempt = exemptHard.length > 0;
  const { other: suppressPenalty, entity: entityPenalty } = splitSuppressionPenalty(
    candidate,
    hardFilterExempt
      ? { ...persona, softSuppressions: [...persona.softSuppressions, ...exemptHard] }
      : persona,
    config,
  );
  const wrongLocPenalty = config.P_WRONG * geo.wrongLocationFlag;
  const seen =
    persona.seenStoryIds &&
    (persona.seenStoryIds.has(candidate.id) ||
      (candidate.stableClusterId != null && persona.seenStoryIds.has(candidate.stableClusterId)))
      ? 1
      : 0;
  const seenPenalty = config.P_SEEN * seen;

  const penalised = applyEntityPenalty(
    clamp(
      base - negTopicPenalty - suppressPenalty - wrongLocPenalty - seenPenalty,
      config.BASE_MIN,
      config.BASE_MAX,
    ),
    entityPenalty,
    config,
  );

  // P6 — DEMOTED, NEVER REMOVED. For an exempt row the headline floor moves from
  // `base` (pre-penalty) to the FINAL score, minus its popularity lift. One hard
  // filter is P_SUP·1.0 = 0.3 against a 0.35 floor, so leaving the penalty
  // unclamped would sink every exempt headline under the 0.3 render gate —
  // i.e. exclusion by another name, which is precisely what this phase removes.
  // Pinning it to the bare HEADLINE_BASE_FLOOR keeps it visible while sorting it
  // below every unfiltered headline (which additionally earns
  // HEADLINE_POP_LIFT·popComp and its own mathBase) and below every topically
  // relevant article. No new tunable: this reuses the constant that defines
  // "a headline is worth showing" in the first place.
  const score = hardFilterExempt
    ? Math.max(penalised, config.HEADLINE_BASE_FLOOR)
    : penalised;

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
      affinity,
      mathBase,
      base,
      negTopicPenalty,
      suppressPenalty,
      entityPenalty,
      wrongLocPenalty,
      seenPenalty,
      wrongLocationFlag: geo.wrongLocationFlag,
      matchedLocationId: geo.matchedLocationId,
      hardFilterExempt,
      mode,
    },
  };
}
