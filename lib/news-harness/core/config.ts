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
  CLOUD_V3_NOTE_SYSTEM_PROMPT,
  CLOUD_FEED_VERIFIER_SYSTEM_PROMPT,
  CLOUD_HEADLINE_RELEVANCE_SYSTEM_PROMPT,
  CLOUD_HEADLINE_REASON_SYSTEM_PROMPT,
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
  /** Output ceiling for one NOTE call ({@link legacyNoteDemote}): one sentence
   *  plus a tiny JSON wrapper. 96 is a ceiling 32 above `reasonMaxTokens`, and a
   *  ceiling is not a spend. */
  v3NoteMaxTokens: number;
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
  /**
   * LEGACY PATH ONLY — run the legacy reason pass through
   * {@link v3NoteSystemPrompt} instead of {@link reasonSystemPrompt}, so it may
   * also DEMOTE a false positive out of the feed rather than only captioning it.
   *
   * This was the one thing the retired v3 scorer did after inference that
   * carried a PRECISION judgement, transplanted onto the legacy path in
   * isolation and kept when the rest of v3 was deleted. It is available for FREE
   * because the two passes are the same call: v1's reason pass and the note pass
   * both visit ONE article, both build the user message
   * with `buildReasonUserMessage`, and both send the same article + score +
   * retrieval facts. Only the system prompt and the decoder differ — so turning
   * this on buys a precision pass at ZERO net LLM calls.
   *
   * v1 has had no precision pass since Wave 7b folded the standalone
   * `feedVerifierEnabled` verifier into the JUDGE — a pass the legacy path never
   * reaches, because a backstop batch never goes to the judge. So the legacy
   * path lost the verifier and got nothing back. This returns it, through the
   * prompt that already ships.
   *
   * MEASURED 2026-08-08 on `goldset-348`, paired within one scoring pass
   * (identical pass-1 model output; only this stage differs):
   *
   *              Pearson  Spearman  n@0.4  recall  skip%  demoted
   *   off         0.5689    0.6073    102   26/37  22.5%     —
   *   on          0.5791    0.6139     97   26/37  19.6%    5/102
   *
   * Precision up, recall UNCHANGED, ranking slightly better, no extra call. It
   * did NOT clear its pre-registered win bar, which demanded the judge-skip
   * share fall by >= 3.0pp; the measured fall is 2.9pp. It is shipped behind
   * this flag anyway, as an explicit owner decision to override a 0.1pp miss —
   * recorded here so the miss is never mistaken for a pass.
   *
   * COST: zero net calls. `v3NoteMaxTokens` (96) is a ceiling 32 above
   * `reasonMaxTokens` (64), and a ceiling is not a spend.
   *
   * SUBMIT/DECODE CONSISTENCY: reading this literal at decode would be a bug —
   * a batch submitted with the legacy reason prompt must not be parsed by the
   * note decoder just because an OTA flipped the flag while it was in flight.
   * The pipeline therefore persists the decision on the batch as `noteMode` at
   * submit and reads it back at decode, exactly as `v3Mode` already does.
   */
  legacyNoteDemote: boolean;
  /**
   * ADD 1 — LEGACY PATH ONLY: show the server's article-tag metadata
   * (`geo_tags` / `entities` / `event_type`) to the pass-1 batch scoring prompt,
   * as one compact `Article Metadata:` line per article block.
   *
   * RELEVANCE v4 — this and {@link legacyTagReasonGateEnabled} ARE v4. One
   * user-facing switch drives both (they were measured together and ship
   * together): the Zustand store field `relevanceV4`, layered onto this object
   * by `mera-protocol/stage-scoring::effectiveHarnessConfig`. The harness itself
   * never reads the store or `process.env`. Because the toggle is a RUNTIME
   * flag, the live app's call builders take the effective config as a parameter
   * (`mera-protocol/scoring-service::buildRelevanceCalls`) rather than reading a
   * module literal — without that the switch would move the offline harness twin
   * and nothing the app actually sends.
   *
   * DOES NOT TOUCH THE ENGINE. This flag reads `ScoringCandidate.meta` inside
   * the PROMPT builder only — see the mechanism note at the top of
   * `article-pipeline/tag-prompt.ts` — so `computeRelevance` and `scoringMode`
   * are bit-for-bit unchanged whichever way it is set. (It was deliberately kept
   * independent of the `USE_ARTICLE_TAGS` gate, which fed the same three columns
   * to the engine and has since been deleted outright.)
   *
   * MEASURED 2026-08-08 on `goldset-348`, 3 baseline + 3 injected + 3 CONTROL
   * replicates (`harness-local/scripts/score-v1-tagged.ts`). Primary metric is
   * must_show recall at a MATCHED feed size, because v1's scores are heavily
   * quantised and recall at a larger feed is not comparable recall:
   *
   *   feed size n   baseline   +tags    +SHUFFLED tags (control)
   *   80            23.00      +2.67    +2.00
   *   90            25.00      +3.33    +0.67
   *   100           26.67      +2.00    -0.67
   *   110           26.67      +2.67    -0.67
   *   120           27.00      +3.67    -1.00
   *   150           31.67      +2.00    -0.33
   *
   * The CONTROL arm sends the identical lines rotated by one within each chunk,
   * so every article carries a NEIGHBOUR's metadata: same tokens, same
   * structure, information destroyed. It tracks baseline everywhere. That is
   * what rules out "a longer, more structured prompt helps" — which would have
   * been a far cheaper thing to ship than a tagging pipeline — and it is the
   * reason this flag exists rather than a prompt reformat.
   *
   * Pearson is deliberately NOT cited as evidence here: the control absorbed
   * about half of its +0.037, so neither half clears the 0.03 noise floor.
   *
   * COST: +13.6% pass-1 prompt characters, no extra calls. Measured across 6
   * arms: 0 truncated calls, 0 regex-salvaged chunks, 0 unscored rows — the
   * bigger input did not push anything into the salvage path.
   */
  legacyTagPromptEnabled: boolean;
  /**
   * ADD 2 — LEGACY PATH ONLY: skip the pass-2 reason call for candidates whose
   * `event_type` is in {@link legacyTagReasonGateEventTypes}, and demote them
   * out of the feed.
   *
   * SKIPPING AND DEMOTING ARE ONE ACTION, NOT TWO. `reasonRelevanceThreshold`
   * equals this path's render gate, so every reason-eligible row is a row the
   * user would see; skipping its call without moving its score would render it
   * silently note-less. Over 1,260 candidate rules the best saving available
   * that way was 0.0%. The orchestrators therefore persist
   * `feedVerifierDemoteScore` for every id the gate returns.
   *
   * MEASURED 2026-08-08 on `goldset-348`, re-checked against all 6 fresh
   * scoring arms of the ADD-1 experiment plus the original run (7 independent
   * runs): 0 must_show lost in every one, recall-at-gate byte-identical before
   * and after, pass-2 calls saved 18.0%-23.8% (mean ~21%), judge-skip share of
   * the delivered feed 25.7% -> 16.7%, mean j_comp of the cut rows 3.48 against
   * 5.25 for the rows kept.
   *
   * Two honest bounds on that. (a) "0 must_show lost in 25 cut rows" bounds the
   * true loss rate at <= 12% (95%, rule of three) — it is not proof of zero.
   * (b) The saving straddles its own 20% acceptance bar: 2 of the 6 fresh runs
   * came in at 18.0% and 18.1%. It clears the bar on the mean, not on every run.
   *
   * INDEPENDENT OF ADD 1: measured at 20.7% mean saving on the untagged prompt
   * and 21.5% on the tag-injected one, so neither flag is a precondition for the
   * other. Together they deliver 28-29/37 must_show in a 77-82 row feed at
   * ~14.5% judge-skip, against baseline's 26-28/37 in a 100-110 row feed at ~24%.
   */
  legacyTagReasonGateEnabled: boolean;
  /**
   * The `event_type` values {@link legacyTagReasonGateEnabled} treats as
   * low-value. SINGLE SOURCE — the gate has no other notion of "low value", so
   * this list is the entire policy and editing it is the whole knob.
   *
   * CAVEAT 1 — THIS SET IS PER-PERSONA, NOT A GLOBAL TRUTH. It was derived from
   * ONE persona (an Amsterdam software engineer: AI research, Dutch housing,
   * cycling, Formula 1, chess) against ONE 348-row labelled corpus. `crime`
   * scored 0/18 must_show FOR THAT PERSON. For a security professional, a
   * policing reporter, or anyone whose stake IS crime, this same list would cut
   * their best content. Treat a global default as a temporary convenience; the
   * right long-term shape is a per-user set learned from their own
   * "not interested" feedback, which is proposed and NOT yet built.
   *
   * CAVEAT 2 — PART OF ITS MEASURED VALUE IS A TAGGER BUG. The enrichment
   * prompt's event vocabulary has no category for software vulnerability
   * advisories, so it files them under `crime`: 4 of the 25 rows the gate cut in
   * the reference run were MISP / Tenable / IBM advisories (j_comp 1.15-2.20).
   * Production reproduces the same mis-tag, so the measured saving is a correct
   * measurement of what ships — but the margin over the 20% bar is exactly one
   * bug wide. Fix the vocabulary (e.g. add `security_advisory` and route it to
   * `science_tech`) and this gate silently drops to 19.3%, i.e. UNDER its own
   * acceptance criterion. Re-measure at that point rather than assuming it holds.
   */
  legacyTagReasonGateEventTypes: readonly string[];
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
  /** Combined precision + note, ONE article per call. Replaces
   *  `reasonSystemPrompt` (and its headline twin) whenever
   *  {@link legacyNoteDemote} is on: unlike the legacy reason prompt it may also
   *  DEMOTE. Named for the retired v3 scorer it was written for; the name is
   *  kept because the prompt text and its decoder are unchanged. */
  v3NoteSystemPrompt: string;
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
  // --- HEADLINE variants (P4a — authored, not yet routed to) ----------------
  /** Top-headline articles bundled into one batched relevance prompt. Smaller
   *  than articlesPerScorePrompt because the headline rubric is longer and adds
   *  a second per-article procedure — see the literal's comment for the
   *  measured arithmetic. */
  headlineArticlesPerScorePrompt: number;
  /** System prompt for the cloud relevance pass over TOP-HEADLINE articles.
   *  Same base, same tiers, same `{"k","s"}` contract as
   *  relevanceSystemPrompt, plus the indirect-impact (event → channel →
   *  household) route. */
  headlineRelevanceSystemPrompt: string;
  /** System prompt for the cloud reason pass over TOP-HEADLINE articles. Same
   *  base + the same impact rubric as headlineRelevanceSystemPrompt, so a
   *  reason can only name a chain the scorer would have accepted. */
  headlineReasonSystemPrompt: string;
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
  /**
   * Output budget for CLOUD topic-generation calls, which run with thinking OFF.
   *
   * Sized off measurement, not guesswork: with `enable_thinking: false` a
   * 10-topic answer costs ~53-60 completion tokens end to end, so 400 is ~6x
   * headroom. Generation ran with thinking ON at 2048 between r12 P4 and this
   * change; a probe against Qwen3.6-35B-A3B showed the reasoning trace alone is
   * ~2000+ tokens, so it consumed the entire budget and `content` came back
   * EMPTY on 8 of 10 runs — the flow was failing, not merely slow. Thinking off
   * is 0.8-1.0s and valid on every run.
   *
   * There is no middle setting to reach for: `reasoning_effort: 'low'` produced
   * the same trace with worse variance, and `chat_template_kwargs.thinking_budget`
   * is silently ignored (the stock Qwen3 template does not implement it — an
   * unknown key there still returns 200, so "no error" proves nothing).
   *
   * CLOUD ONLY. The on-device path has its own budget (n_ctx is 4096 there); do
   * not reuse this constant for it.
   */
  cloudMaxTokens: number;
  /**
   * Output budget for the fact-combination TOP-UP, which still runs with
   * thinking ON (`topic-topup.ts`).
   *
   * The reasoning trace shares `max_tokens` with the answer, so this has to be
   * far larger than `cloudMaxTokens`. NOT read by topic generation any more —
   * that path is thinking-off and sized by `cloudMaxTokens`. Keep the two
   * separate: collapsing them would silently drag one path into the other's
   * regime.
   *
   * NOTE: the top-up sends a combo-only prompt, i.e. the same shape that failed
   * at 2048 in generation. It has not been probed yet — see the plan's
   * follow-ups.
   */
  cloudThinkingMaxTokens: number;
  /**
   * Seed weight for a topic appended by the fact-combination TOP-UP, as opposed
   * to one generated when the fact was first saved.
   *
   * Lower than `llmTopicWeight` on purpose. Seed weight drives per-topic
   * retrieval depth (retrieval-profile: limit = clamp(round(10 + 40*w))), so
   * 0.5 requests 30 articles where 0.75 requests 40 — a 25% cut in first-sync
   * depth per appended topic. These are speculative combinations the user never
   * asked for, so they should not arrive at full strength; user signal can
   * still promote them later.
   */
  topupTopicWeight: number;
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
  /** RETIRED routing switch, kept declared (and false) only so the calibration
   *  tests that pin "a boolean is not a tunable" keep their subject — it is
   *  deliberately absent from `calibration::TUNABLE_CONSTANTS`, whose layer
   *  applies `base × (1 + delta)` to NUMBERS only. Nothing reads it: the
   *  math-authoritative path it used to select is gone, and so is the
   *  `USE_ARTICLE_TAGS` gate it once subsumed (the engine now always sees the
   *  server's tags — see `relevance.ts`). */
  RELEVANCE_V2: boolean;
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
  /**
   * The floor an `entity`-kind suppression may push a score down TO, but never
   * through.
   *
   * WHY ENTITIES ARE DIFFERENT. A hand audit put entity extraction at 68.8%
   * correct — roughly one in three wrong. The owner's ruling: keep entities
   * (the feedback tree's entity like/dislike paths are valuable and the data is
   * fed to the LLM on optimisation runs) but never let them DELETE a
   * suggestion. Unreliable data may nudge a rank; it must not remove a row.
   *
   * `entity` is therefore excluded from every hard-exclusion path
   * (`suppression::canHardExclude`, and the hard/soft partition in
   * `stage-scoring::loadPersonaScoringContext` never files one as hard). That
   * alone is not enough: the SOFT penalty is subtracted from the score, and at
   * P_SUP 0.3 (capped 0.6) an entity match could push a renderable row under
   * the render gate — a hard filter wearing a soft filter's clothes. So the
   * entity part of the penalty is applied against this floor: it can move a row
   * down to it and no further, and it never moves a row that is already below
   * it.
   *
   * MUST EQUAL the render gate — `articlePipeline.discardFloor` and
   * `stores/fact-rows-selector::RENDER_GATE`, both 0.4. It lives here rather
   * than being read from `articlePipeline` because `computeRelevance` is handed
   * only the `scoringEngine` slice. `config.test.ts` pins the three together so
   * they cannot drift.
   */
  ENTITY_PENALTY_FLOOR: number;
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
    v3NoteMaxTokens: 96,
    scoreTemperature: 0.1,
    reasonTemperature: 0.2,
    reasonMaxTokens: 64,
    discardFloor: 0.4,
    fallbackRelevance: 0.3,
    ineligibleRelevance: 0.2,
    // Lockstep with RENDER_GATE / inference-results.REASON_RELEVANCE_THRESHOLD
    // (0.3 -> 0.4 in the v3 wave); comparisons are INCLUSIVE (>=).
    reasonRelevanceThreshold: 0.4,
    // OFF by default — an explicit literal, not an absent key read as falsy, in
    // the same style and for the same reason as the scoringEngine routing
    // switches: the harness default must always describe SHIPPED behaviour, and
    // the owner flips it once he has seen it work. See the field's doc comment
    // for the paired measurement AND for the pre-registered bar it missed.
    legacyNoteDemote: false,
    // RELEVANCE v4 — both article-tag features on the legacy path, OFF by
    // default, as explicit literals rather than absent keys read as falsy —
    // same style and same reason as `legacyNoteDemote` above and the
    // scoringEngine routing switches: the harness default must always describe
    // SHIPPED behaviour. Each field's doc comment carries its own paired
    // measurement. ONE user-facing switch (`relevanceV4`) turns both on; to
    // default v4 ON, flip BOTH of these to `true` (and update config.test.ts).
    legacyTagPromptEnabled: false,
    legacyTagReasonGateEnabled: false,
    // The measured set. Frozen as a literal so `config.test.ts` pins it and a
    // change has to be deliberate; see the field's TWO caveats before editing —
    // it is per-persona, and part of its value comes from a tagger mis-label.
    legacyTagReasonGateEventTypes: ['crime', 'other'],
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
    v3NoteSystemPrompt: CLOUD_V3_NOTE_SYSTEM_PROMPT,
    model: SMALL_MODEL,
    // Wave 7b: verifier absorbed into the judge; flag-off one release then
    // deleted (its NO-patterns live in CLOUD_JUDGE_SYSTEM_PROMPT). Code stays.
    feedVerifierEnabled: false,
    feedVerifierBatchSize: 15,
    feedVerifierDemoteScore: 0.28,
    feedVerifierMaxTokens: 260, // 15*12 + 80
    feedVerifierSystemPrompt: CLOUD_FEED_VERIFIER_SYSTEM_PROMPT,
    // Combined judge+reason pass (math-mode candidates).
    // HEADLINE batch size — measured, not guessed (estimateTokens, lib/llm/tokens.ts):
    //   live relevance prompt      4386 est tokens, batched 5/call
    //   headline relevance prompt  7036 est tokens  (+60.4%)
    //   per-article payload        ~335 est tokens worst case (title 500 chars
    //                              + description 500 + country 60 + "why" 200 + framing)
    // Live call today:   4386 + 5×335 = 6061 in, 1212 per article.
    // Headline at N=3:   7036 + 3×335 = 8041 in, 2680 per article.
    // (N=4 → 7940 / 1985; N=5 → 8275 / 1655.)
    //
    // 3 = 5 × (4386 / 7036) = 3.12 → 3: hold per-article ATTENTION on the
    // rubric, not per-article cost. The binding constraint here is not tokens —
    // it is that the headline rubric adds a SECOND per-article procedure (the
    // four impact gates + the magnitude test) on top of the base's Steps 1–4,
    // and its failure mode is hedged over-inclusion, which is exactly what a
    // long batch produces when the article payloads crowd the rubric. The live
    // 5 was tuned against a rubric with one procedure; scaling inversely with
    // rubric length keeps the same rubric-per-article budget.
    // Cost is affordable at 2.07× per article because headlines are a bounded
    // slice (per-scope headline depth, order tens per sync) rather than the
    // whole retrieved pool.
    // NOT a hard gate: lib/llm/cloudComplete.ts only LOGS estimated input
    // tokens (no ceiling check, no truncation), so this is a cost/reliability
    // judgement, revisable from measured output quality. Output side is
    // unchanged — {"k","s"} objects — so scoreBatchMaxTokens (320) stays ample
    // at N=3.
    headlineArticlesPerScorePrompt: 3,
    headlineRelevanceSystemPrompt: CLOUD_HEADLINE_RELEVANCE_SYSTEM_PROMPT,
    headlineReasonSystemPrompt: CLOUD_HEADLINE_REASON_SYSTEM_PROMPT,
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
    cloudMaxTokens: 400,
    cloudThinkingMaxTokens: 2048,
    topupTopicWeight: 0.5,
    factOnlySystemPrompt: CLOUD_TOPIC_GENERATION_SYSTEM_PROMPT,
    comboSystemPrompt: CLOUD_FACT_COMBO_TOPIC_GENERATION_SYSTEM_PROMPT,
  },
  scoringEngine: {
    // Relevance v2 is OFF by default for the same reason and in the same style:
    // an explicit literal, not an absent key read as falsy. Nothing layers it in
    // at runtime any more; the harness default must always describe today's
    // shipped behaviour.
    RELEVANCE_V2: false,
    // affinity component weights (positives sum to ≈ 1.0 at full saturation).
    // Wave 7b rebalance: W_TOPIC 0.42→0.32, the freed 0.10 → W_BREADTH.
    // Round-3 A2: freshness decay removed (W_FRESH 0.08 deleted). The remaining
    // seven positive weights are RENORMALIZED proportionally (÷0.92, the pre-A2
    // positive sum) so full-saturation affinity stays ≈1.0 and no borderline
    // article slips under the 0.3 render gate from a ~0.08-raw drop. Pre-A2 →
    // post-A2: 0.32→0.348, 0.10→0.109, 0.20→0.217, 0.08→0.087, 0.05→0.054,
    // 0.07→0.076, 0.10→0.109 (3dp; the seven sum to exactly 1.000).
    W_TOPIC: 0.348,
    W_BREADTH: 0.109,
    W_GEO: 0.217,
    W_ENTITY: 0.087,
    W_EVENT: 0.054,
    W_PUB: 0.076,
    W_POP: 0.109,
    // affinity → raw band
    BASE_OFFSET: 0.05,
    BASE_SLOPE: 1.05,
    BASE_MIN: 0.05,
    BASE_MAX: 1.1,
    // penalties
    P_NEG: 0.45,
    P_SUP: 0.3,
    P_SUP_CAP: 0.6,
    // == articlePipeline.discardFloor == RENDER_GATE. See the field's comment.
    ENTITY_PENALTY_FLOOR: 0.4,
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
