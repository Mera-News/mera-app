// news-harness — configuration.
//
// The literals below are the EXACT current production values, previously spread
// as module constants across scoring-service.ts, inference-results.ts,
// topic-generation-service.ts, tool-handlers.ts, and feed-sync-steps.ts. They
// are gathered here so the harness has a single injectable config surface while
// behaviour stays bit-identical. See config.test.ts, which pins every literal.

import {
  CLOUD_RELEVANCE_SYSTEM_PROMPT,
  CLOUD_REASON_SYSTEM_PROMPT,
  CLOUD_FEED_VERIFIER_SYSTEM_PROMPT,
  CLOUD_JUDGE_SYSTEM_PROMPT,
  CLOUD_TOPIC_GENERATION_SYSTEM_PROMPT,
  CLOUD_FACT_COMBO_TOPIC_GENERATION_SYSTEM_PROMPT,
} from '../prompts/prompts';

/** SMALL_MODEL literal — mirrored from lib/llm/constants.ts (kept out of the
 *  harness import graph on purpose so the harness stays RN-free). */
const SMALL_MODEL = 'Qwen/Qwen3.6-35B-A3B-FP8';

export interface ArticlePipelineConfig {
  /** Articles bundled into one batched relevance prompt (cloud). */
  articlesPerScorePrompt: number;
  /** Output token ceiling for one batched score call. */
  scoreBatchMaxTokens: number;
  /** Sampling temperature for relevance-score calls. */
  scoreTemperature: number;
  /** Sampling temperature for reason-generation calls. */
  reasonTemperature: number;
  /** Output token ceiling for one reason call. */
  reasonMaxTokens: number;
  /** Raw scores below this stay raw (not bucketed) — the DISCARD floor. */
  discardFloor: number;
  /** Fallback relevance when LLM scoring fails or output is unparseable. */
  fallbackRelevance: number;
  /** Default relevance for candidates ineligible for scoring (no body/facts). */
  ineligibleRelevance: number;
  /** Bucketed-relevance floor that gates phase-2 reason generation. */
  reasonRelevanceThreshold: number;
  // --- Bucket cutoffs (raw LLM score) + persisted representative values ---
  mediumPriorityCutoff: number;
  highPriorityCutoff: number;
  /** Strictly greater than this → EMERGENCY. */
  emergencyPriorityCutoff: number;
  lowPriorityScore: number;
  mediumPriorityScore: number;
  highPriorityScore: number;
  emergencyPriorityScore: number;
  /** Per-topic article-id fetch cap (feed-sync). */
  limitPerTopic: number;
  /** Chunk size when hydrating full article records (feed-sync). */
  hydrateChunkSize: number;
  /** System prompt for the cloud relevance pass. */
  relevanceSystemPrompt: string;
  /** System prompt for the cloud reason pass. */
  reasonSystemPrompt: string;
  /** Cloud model used for scoring + reason generation. */
  model: string;
  // --- Second-pass FEED verifier (validated 2026-07-16 multistage experiment,
  //     "Design A2 — tuned"; see CLOUD_FEED_VERIFIER_SYSTEM_PROMPT) -----------
  /** Enable the second-pass FEED verifier. A precision pass over only the
   *  first-pass FEED candidates (raw ≥ discardFloor) that demotes clear false
   *  positives out of FEED. Default ON — adopted from the experiment (+7.2pt
   *  FEED precision, unrelated-in-FEED 19→13, +3.8% tokens). */
  feedVerifierEnabled: boolean;
  /** Articles bundled into one verifier prompt. 15 amortizes the terse prompt
   *  across the batch; matches the validated experiment batch size. */
  feedVerifierBatchSize: number;
  /** Raw score a verifier-demoted ("no") article is set to. 0.28 is chosen so a
   *  demoted article: (a) sits BELOW reasonRelevanceThreshold (0.3) → it never
   *  gets a reason generated (noise gets no reason); (b) sits below the app's
   *  For-You visibility cutoff (rows render only when relevance > 0.3) → it
   *  never takes a For-You slot; (c) still lands inside the TANGENTIAL band
   *  (0.25–0.39) → a future Discover surface can still show it. NOTE: this is
   *  deliberately BELOW the experiment's 0.35 — 0.35 would still clear the 0.3
   *  reason/visibility cutoffs. This 0.28 encodes the product rule "noise gets
   *  no reason and no For-You slot." */
  feedVerifierDemoteScore: number;
  /** Output token ceiling for one verifier batch call. Derived from batch size:
   *  feedVerifierBatchSize*12 + 80 (the {"v":"yes"}/{"v":"no"} array is tiny;
   *  80 is array/format headroom). At batchSize 15 → 260, which the experiment
   *  confirmed never truncated. Keep consistent with feedVerifierBatchSize. */
  feedVerifierMaxTokens: number;
  /** System prompt for the second-pass FEED verifier. */
  feedVerifierSystemPrompt: string;
  // --- Combined JUDGE + reason pass (Wave 7b — replaces the two-pass scorer +
  //     verifier for math-mode candidates; see CLOUD_JUDGE_SYSTEM_PROMPT) ------
  /** Math-mode candidates bundled into one judge prompt. Larger than the
   *  score batch (5) because the judge prompt is ~1/5 the size (no fact bank,
   *  no anchor table) and each output object is tiny ({"j","s"?,"r"?}). */
  judgeChunkSize: number;
  /** Output token ceiling for one judge batch call. ≈ judgeChunkSize × (reason
   *  ≤22 words ~34 tok + object overhead ~8) + array headroom. */
  judgeMaxTokens: number;
  /** Computed-score floor at/above which a reason ("r") is requested in the
   *  combined call. 0.15 = reasonRelevanceThreshold(0.3) − OVERRIDE_DELTA(0.15
   *  legacy leash); below it a maximal judge lift still can't clear the reason
   *  cutoff, so the token is never spent. */
  judgeReasonFloor: number;
  /** System prompt for the combined judge+reason pass. */
  judgeSystemPrompt: string;
}

export interface TopicGenConfig {
  /** Default total topics per fact in cloud mode. */
  totalCloud: number;
  /** Default total topics per fact in on-device mode. */
  totalLocal: number;
  /** Sampling temperature for topic generation. */
  temperature: number;
  /** Maximum accepted fact statement length. */
  maxFactLength: number;
  /** Seed weight for an LLM-minted `topics` row (Wave 11 — the topic-row
   *  minting that closes the "metadata.topics never reach the feed" gap). A
   *  moderate-positive value: below a default user/fact weight but comfortably
   *  retrievable + positively scored by the math engine. */
  llmTopicWeight: number;
  /** System prompt for the fact-only topic-generation call. */
  factOnlySystemPrompt: string;
  /** System prompt for the fact+others combo topic-generation call. */
  comboSystemPrompt: string;
}

/**
 * Deterministic math-relevance engine constants (Wave 7a — `scoring-engine/`).
 *
 * Property names use the plan's UPPER_SNAKE identifiers verbatim (W_*, P_*,
 * HP_MULT, POP_SAT, HEADLINE_*) so the config surface reads 1:1 against
 * SUB-PLAN M §2.2 / §2.3 / A6. Every value is a SEED to be tuned against
 * `eval:golden`; config.test.ts pins each literal so drift fails loudly. These
 * do NOT touch the tier/bucket cutoffs in `articlePipeline` — the engine emits a
 * raw score into the same 0.05–1.10 band the existing buckets/eval consume.
 */
export interface ScoringEngineConfig {
  // --- affinity component weights (positive contributors sum ≈ 1) ---------
  /** Explicit topic interest (magnitude of the strongest matched topic). */
  W_TOPIC: number;
  /** Topic BREADTH — how many distinct active topics matched. Golden analysis:
   *  EXCLUDE articles match ~1.26 topics on average, FEED ~2.85. A single-topic
   *  match is mostly spurious (only ~14% are FEED); breadth is the strongest
   *  cheap discriminator the math has. Carved out of W_TOPIC (0.42→0.32) so a
   *  solo topic lands at the FEED boundary (judge decides) while a multi-topic
   *  story clears FEED on its own. */
  W_BREADTH: number;
  /** Location alignment (home/family/travel city/region/country match). */
  W_GEO: number;
  /** Key-entity interest match. */
  W_ENTITY: number;
  /** Event-type affinity (small). */
  W_EVENT: number;
  /** Publication preference. */
  W_PUB: number;
  /** Popularity — widely-covered stories (top-headline path leans here). */
  W_POP: number;
  /** Freshness. */
  W_FRESH: number;
  // --- affinity → raw band mapping ----------------------------------------
  /** base = clamp(BASE_OFFSET + BASE_SLOPE·clampPos(affinity), BASE_MIN, BASE_MAX). */
  BASE_OFFSET: number;
  BASE_SLOPE: number;
  BASE_MIN: number;
  BASE_MAX: number;
  // --- penalties (subtractive, after the band map) ------------------------
  /** Negative matched-topic demotion (a −1 topic guts the score). */
  P_NEG: number;
  /** Per soft-suppression strength unit. */
  P_SUP: number;
  /** Cap on the summed suppression penalty. */
  P_SUP_CAP: number;
  /** Wrong-location — HEAVY (user directive): a sibling-city match single-
   *  handedly drops a would-be-FEED into EXCLUDE. */
  P_WRONG: number;
  /** Already-seen story demotion — small (sinks a repeat below a fresh
   *  sibling, never flips FEED→EXCLUDE alone). */
  P_SEEN: number;
  // --- topic weighting -----------------------------------------------------
  /** high_priority multiplier (score-only; effective weight re-clamped |w|≤1). */
  HP_MULT: number;
  // --- breadth saturation --------------------------------------------------
  /** breadthComp = clamp((distinctPositiveMatchedTopics − 1) / BREADTH_SAT, 0, 1).
   *  BREADTH_SAT=2 → 1 topic 0.0, 2 topics 0.5, 3+ topics saturate at 1.0. */
  BREADTH_SAT: number;
  // --- vectorScore modulation ---------------------------------------------
  /** When a matched topic carries a server vectorScore, its positive weight is
   *  scaled by smoothstep(vectorScore, VS_LO, VS_HI): a low-similarity semantic
   *  match is suppressed toward 0, a strong one passes through. Below VS_LO → 0,
   *  above VS_HI → 1. ABSENT vectorScore (offline eval, warm-path rows) → neutral
   *  1.0 (no modulation) so the math is unchanged where the signal is missing. */
  VS_LO: number;
  VS_HI: number;
  // --- popularity saturation ----------------------------------------------
  /** popComp = clamp(log2(1+maxClusterSize)/log2(1+POP_SAT), 0, 1). */
  POP_SAT: number;
  // --- freshness knees -----------------------------------------------------
  /** ≤ this age (hours) → 1.0. */
  FRESH_FULL_HOURS: number;
  /** At this age (hours) → FRESH_MID_SCORE; linear from FRESH_FULL_HOURS. */
  FRESH_DECAY_HOURS: number;
  /** Freshness value at FRESH_DECAY_HOURS. */
  FRESH_MID_SCORE: number;
  /** Freshness value beyond FRESH_DECAY_HOURS. */
  FRESH_OLD_SCORE: number;
  // --- geo alignment multipliers (× location.weight) ----------------------
  GEO_CITY: number;
  GEO_REGION: number;
  GEO_COUNTRY: number;
  // --- headline floor (applied to headline-scope rows BEFORE penalties) ---
  /** base = max(mathBase, HEADLINE_BASE_FLOOR + HEADLINE_POP_LIFT·popComp)
   *  so COUNTRY/GLOBAL headlines clear the 0.3 render gate; penalties still
   *  apply, so suppressed/wrong-city headlines still die. */
  HEADLINE_BASE_FLOOR: number;
  HEADLINE_POP_LIFT: number;
  // --- headline SECTION pseudo-weights (feed-select/sections.ts, Wave 7b-core
  //     M-P5b — order the fact-sectioned For-You feed's synthetic headline
  //     sections against real fact sections on ONE weight axis) --------------
  /** Synthetic CITY/COUNTRY headline section weight = HEADLINE_SECTION_BASE ×
   *  location.weight. Seed 0.55 so a full-weight home location (→0.55) outranks
   *  a down-weighted fact, while default-weight (1.0) fact sections stay above
   *  every headline section. */
  HEADLINE_SECTION_BASE: number;
  /** GLOBAL "Top stories · Worldwide" synthetic section — fixed pseudo-weight
   *  (no owning location). Seed 0.35 sits it below CITY/COUNTRY headlines. */
  GLOBAL_SECTION_WEIGHT: number;
}

/**
 * Bounded persona-mutation rails (Wave 8 M-P6). The signal → weight-delta
 * budgets that gate every on-device persona nudge. HP_MULT is NOT here — it
 * already lives in `scoringEngine` (1.25); the rails reference it, never
 * duplicate it. Every value is a SEED; config.test.ts pins each literal so
 * drift fails loudly.
 */
export interface MutationRailsConfig {
  /** Per-topic per-day nudge budget: |Σ deltas today| ≤ this. */
  NUDGE_DAY_BUDGET: number; // 0.3
  /** "Show less" signal delta on matched topics. */
  SHOW_LESS: number; // -0.15
  /** Thumbs-down signal delta. */
  THUMBS_DOWN: number; // -0.1
  /** Weight of the location-anchored NEGATIVE topic minted on a wrong-location signal. */
  WRONG_LOCATION_NEG_TOPIC: number; // -0.6
}

export interface HarnessConfig {
  articlePipeline: ArticlePipelineConfig;
  topicGen: TopicGenConfig;
  scoringEngine: ScoringEngineConfig;
  mutationRails: MutationRailsConfig;
}

export const DEFAULT_HARNESS_CONFIG: HarnessConfig = {
  articlePipeline: {
    articlesPerScorePrompt: 5,
    // 5 articles × {"k":"…","s":0.xx} objects + array overhead. The tiered
    // relevance output (stake tag + score, decoder-clamped per band) needs
    // ~4× the budget of the old bare-numbers array; 320 leaves headroom so a
    // verbose model never truncates mid-array (truncation = whole batch falls
    // back to fallbackRelevance).
    scoreBatchMaxTokens: 320,
    scoreTemperature: 0.1,
    reasonTemperature: 0.2,
    reasonMaxTokens: 64,
    discardFloor: 0.4,
    fallbackRelevance: 0.3,
    ineligibleRelevance: 0.2,
    reasonRelevanceThreshold: 0.3,
    mediumPriorityCutoff: 0.6,
    highPriorityCutoff: 0.8,
    emergencyPriorityCutoff: 1.0,
    lowPriorityScore: 0.4,
    mediumPriorityScore: 0.6,
    highPriorityScore: 0.8,
    emergencyPriorityScore: 1.1,
    limitPerTopic: 20,
    hydrateChunkSize: 25,
    relevanceSystemPrompt: CLOUD_RELEVANCE_SYSTEM_PROMPT,
    reasonSystemPrompt: CLOUD_REASON_SYSTEM_PROMPT,
    model: SMALL_MODEL,
    // Wave 7b: verifier absorbed into the judge; flag-off one release then
    // deleted (its NO-patterns live in CLOUD_JUDGE_SYSTEM_PROMPT). Code stays.
    feedVerifierEnabled: false,
    feedVerifierBatchSize: 15,
    feedVerifierDemoteScore: 0.28,
    feedVerifierMaxTokens: 260, // 15*12 + 80
    feedVerifierSystemPrompt: CLOUD_FEED_VERIFIER_SYSTEM_PROMPT,
    // Combined judge+reason pass (math-mode candidates).
    judgeChunkSize: 12,
    judgeMaxTokens: 560, // 12*(34+8) + ~56 headroom
    judgeReasonFloor: 0.15,
    judgeSystemPrompt: CLOUD_JUDGE_SYSTEM_PROMPT,
  },
  topicGen: {
    // 2026-07-16: reduced 16→10 (cloud) / 14→10 (local). Golden-labeled
    // analysis of the 186-topic prod baseline showed the worst 25% of topics
    // could be cut with 0% loss of true-FEED articles (19/186 fetched zero;
    // worst 55 topics consumed 23.8% of the daily article quota for zero
    // feed-worthy yield). Fewer, better-targeted topics per fact → less quota
    // waste. Deliberate product change (config.test.ts pins updated to match).
    totalCloud: 10,
    totalLocal: 10,
    temperature: 0.3,
    maxFactLength: 200,
    llmTopicWeight: 0.75,
    factOnlySystemPrompt: CLOUD_TOPIC_GENERATION_SYSTEM_PROMPT,
    comboSystemPrompt: CLOUD_FACT_COMBO_TOPIC_GENERATION_SYSTEM_PROMPT,
  },
  scoringEngine: {
    // affinity component weights (positives sum to ≈ 1.0 at full saturation).
    // Wave 7b rebalance: W_TOPIC 0.42→0.32, the freed 0.10 → W_BREADTH. Both are
    // explicit-interest signals (magnitude vs. breadth of the match); the shift
    // stops a single seed-weight topic from single-handedly landing an article
    // in FEED (the dominant over-inclusion mode) while keeping the positives sum
    // at 1.0. All other weights unchanged.
    W_TOPIC: 0.32,
    W_BREADTH: 0.1,
    W_GEO: 0.2,
    W_ENTITY: 0.08,
    W_EVENT: 0.05,
    W_PUB: 0.07,
    W_POP: 0.1,
    W_FRESH: 0.08,
    // affinity → raw band
    BASE_OFFSET: 0.05,
    BASE_SLOPE: 1.05,
    BASE_MIN: 0.05,
    BASE_MAX: 1.1,
    // penalties
    P_NEG: 0.45,
    P_SUP: 0.3,
    P_SUP_CAP: 0.6,
    P_WRONG: 0.55,
    P_SEEN: 0.08,
    // topic weighting
    HP_MULT: 1.25,
    // breadth saturation (3+ distinct positive topics saturate)
    BREADTH_SAT: 2,
    // vectorScore modulation knees (production-only; eval rows have no vector)
    VS_LO: 0.78,
    VS_HI: 0.9,
    // popularity saturation
    POP_SAT: 32,
    // freshness knees
    FRESH_FULL_HOURS: 6,
    FRESH_DECAY_HOURS: 24,
    FRESH_MID_SCORE: 0.3,
    FRESH_OLD_SCORE: 0.1,
    // geo alignment multipliers
    GEO_CITY: 1.0,
    GEO_REGION: 0.6,
    GEO_COUNTRY: 0.3,
    // headline floor
    HEADLINE_BASE_FLOOR: 0.35,
    HEADLINE_POP_LIFT: 0.15,
    // headline section pseudo-weights (feed-select sectioning)
    HEADLINE_SECTION_BASE: 0.55,
    GLOBAL_SECTION_WEIGHT: 0.35,
  },
  mutationRails: {
    NUDGE_DAY_BUDGET: 0.3,
    SHOW_LESS: -0.15,
    THUMBS_DOWN: -0.1,
    WRONG_LOCATION_NEG_TOPIC: -0.6,
  },
};
