// Scoring Service — On-device relevance scoring of ArticleSuggestions (two-pass)
// Pass 1: Relevance score, batched 5 articles per LLM call (one JSON array out)
// Pass 2: Reason generation per article (only for relevance >= REASON_THRESHOLD)
//
// The PURE scoring logic (prompt building, parsing, decoding, bucketing) now
// lives in lib/news-harness/article-pipeline/scoring.ts. This module keeps the
// RN-coupled orchestration (WatermelonDB reads/writes, cloud/local LLM calls,
// the processing-mode store) and delegates the pure work to the harness,
// injecting the app logger + default config so behaviour is unchanged.

import { completeLocal } from '../llm/completeLocal';
import { cloudComplete, cloudBatchComplete } from '../llm/cloudComplete';
import { SMALL_MODEL } from '../llm/constants';
import logger from '../logger';
import {
  CLOUD_RELEVANCE_SYSTEM_PROMPT,
  CLOUD_REASON_SYSTEM_PROMPT,
  LOCAL_REASON_SYSTEM_PROMPT,
  buildBatchScoringUserMessage,
  buildReasonUserMessage,
} from './prompts';
import {
  batchMarkExcluded,
  countUnscoredSuggestions,
  getScoredSuggestionsWithoutReasons,
  getUnscoredSuggestionsWithFacts,
  saveReason,
  saveScoringResult,
  type ScoringCandidate,
} from '../database/services/article-suggestion-service';
import { getFacts } from '../database/services/fact-service';
import { isCulledHeadlineRelevance } from '../feed-ordering/importance-filter';
import { useMeraProtocolStore } from '../stores/mera-protocol-store';
import { ProcessingMode } from '../generated/graphql-types';
import type { BatchCall } from '../llm/types';
import type { BatchCompletionResult } from '../llm/cloudComplete';
import { DEFAULT_HARNESS_CONFIG } from '@/lib/news-harness/core/config';
import { appHarnessLogger } from '@/lib/news-harness-app/logger-adapter';
import {
  resolveCountryName,
  buildUserContext,
  isEligible,
  isScorableCandidate,
  chunk,
  bucketScores,
  parseReasonResponse,
  decodeCloudBatchResults as harnessDecodeCloudBatchResults,
  buildFeedVerifierCalls,
  applyFeedVerifierDecisions,
  isHeadlineCandidate,
  resolveScoringVariant,
  relevanceSystemPromptFor,
  reasonSystemPromptFor,
  scoreChunkSizeFor,
  CLOUD_SCORE_CHUNK_SIZE,
  CLOUD_HEADLINE_SCORE_CHUNK_SIZE,
  REASON_MIN_RAW_SCORE,
} from '@/lib/news-harness/article-pipeline/scoring';
import type {
  CloudCallBundle,
  DecodedResults,
  ScoringResult,
} from '@/lib/news-harness/article-pipeline/scoring';
import { computeAndJudgeForCandidates } from './stage-scoring';
import { recordOverrides } from '@/lib/database/services/calibration-service';
import { buildCalibrationCase } from '@/lib/news-harness/scoring-engine';
import { yieldToInteractions } from '@/lib/scheduler/idle';

const ARTICLE_CFG = DEFAULT_HARNESS_CONFIG.articlePipeline;

const isOnDeviceMode = () =>
  useMeraProtocolStore.getState().processingMode === ProcessingMode.OnDevice;

// --- Re-exports (canonical homes moved to the harness) ---

export {
  bucketScores,
  CLOUD_SCORE_CHUNK_SIZE,
  CLOUD_HEADLINE_SCORE_CHUNK_SIZE,
  REASON_MIN_RAW_SCORE,
};
export type { CloudCallBundle, DecodedResults, ScoringResult };

// --- Local constants for the RN-coupled orchestration (mirror harness config) ---

/** Articles bundled into one batched relevance prompt (cloud). */
const ARTICLES_PER_SCORE_PROMPT = ARTICLE_CFG.articlesPerScorePrompt;

/** Relevance threshold — generate reasons for every scored candidate. */
const REASON_THRESHOLD = 0;

/** Fallback when LLM scoring fails or output is unparseable. */
const FALLBACK_RELEVANCE = ARTICLE_CFG.fallbackRelevance;

/** Default for candidates that are ineligible for scoring (no body, no facts). */
const INELIGIBLE_RELEVANCE = ARTICLE_CFG.ineligibleRelevance;

/** Output token ceiling for one batched score call. */
const SCORE_BATCH_MAX_TOKENS = ARTICLE_CFG.scoreBatchMaxTokens;

// --- Fact loading ---

async function loadAllFactStatements(): Promise<string[]> {
  const facts = await getFacts();
  return facts
    .map((f) => f.statement)
    .filter((s) => typeof s === 'string' && s.trim().length > 0);
}

// --- Batch scoring + reason generation ---
//
// The score/reason PROMPT building stays here (rather than delegating to the
// harness) so it keeps flowing through the mockable `./prompts` builders. The
// pure, prompt-independent helpers (resolveCountryName, buildUserContext,
// isEligible, chunk, parsers, bucketing, decode) come from the harness. The
// harness has its own equivalent builders for its own consumers; golden-prompts
// tests pin that the two produce byte-identical output.

function buildScoreCallForChunk(
  chunkCandidates: ScoringCandidate[],
  allFactStatements: string[],
  systemPrompt: string = CLOUD_RELEVANCE_SYSTEM_PROMPT,
): { prompt: string; system: string } {
  const userContext = buildUserContext(allFactStatements);
  const prompt = buildBatchScoringUserMessage({
    userContext,
    articles: chunkCandidates.map((c) => ({
      title: c.titleEn ?? '',
      description: c.descriptionEn ?? '',
      country: resolveCountryName(c.countryCode),
      relatedFacts: c.relatedFacts.map((f) => f.statement),
    })),
  });
  return { prompt, system: systemPrompt };
}

async function generateReasonForCandidate(
  candidate: ScoringCandidate,
  userContext: string,
  relevance: number,
): Promise<string> {
  const userMessage = buildReasonUserMessage({
    userContext,
    articleTitle: candidate.titleEn ?? '',
    articleDescription: candidate.descriptionEn ?? '',
    articleCountry: resolveCountryName(candidate.countryCode),
    relevance,
    relatedFacts: candidate.relatedFacts.map((f) => f.statement),
  });
  const output = isOnDeviceMode()
    ? await completeLocal({
        systemPrompt: LOCAL_REASON_SYSTEM_PROMPT,
        prompt: userMessage,
        maxTokens: ARTICLE_CFG.reasonMaxTokens,
        temperature: ARTICLE_CFG.reasonTemperature,
        responseFormat: 'json',
      })
    : await cloudComplete({
        systemPrompt: CLOUD_REASON_SYSTEM_PROMPT,
        prompt: userMessage,
        maxTokens: ARTICLE_CFG.reasonMaxTokens,
        temperature: ARTICLE_CFG.reasonTemperature,
        model: SMALL_MODEL,
      });
  return parseReasonResponse(output, candidate.id, userMessage, appHarnessLogger);
}

/**
 * The unconditional top-headline cull: a headline-sourced row that lands in the
 * LOW band or below is terminal (`excluded`), never a saved suggestion —
 * headlines exist to surface what matters in a region, so a LOW one is noise on
 * every surface. Non-headline rows are NEVER culled.
 *
 * `bucketedScoreMap` must hold POST-`bucketScores` values: the predicate reads
 * the band, and raw scores don't map to bands one-to-one (a raw 0.45 buckets to
 * LOW ⇒ culled, a raw 0.55 to MEDIUM ⇒ kept).
 *
 * `candidates` must ALREADY exclude ineligible and failed rows. Both carry a
 * placeholder score (INELIGIBLE_RELEVANCE / FALLBACK_RELEVANCE) that lands in
 * the culled band, but neither is a verdict this path is entitled to make
 * terminal: an ineligible (e.g. factless) headline was never scored, and a
 * failed one must stay retryable.
 */
function collectCulledHeadlineIds(
  candidates: ScoringCandidate[],
  bucketedScoreMap: Map<string, number>,
): Set<string> {
  const culled = new Set<string>();
  for (const c of candidates) {
    if (!isHeadlineCandidate(c)) continue;
    const relevance = bucketedScoreMap.get(c.id);
    if (relevance !== undefined && isCulledHeadlineRelevance(relevance)) culled.add(c.id);
  }
  return culled;
}

export interface BatchScoreResult {
  /** Raw score per id (pre-bucket). Ineligible rows get INELIGIBLE_RELEVANCE. */
  scoreMap: Map<string, number>;
  reasonMap: Map<string, string>;
  failedIds: Set<string>;
  /** Persona-v3 audit: pre-judge deterministic math score per id. */
  computedMap: Map<string, number>;
  /** Persona-v3 audit: JSON-encoded RelevanceComponents per id. */
  componentsJsonMap: Map<string, string>;
  /** Screened out by a hard "not interested" filter. These ids get NO scoreMap
   *  entry and are NOT in failedIds — they are not a failure, they are a user
   *  decision. The caller persists them as terminal `excluded`. */
  excludedIds: Set<string>;
  /** excluded id → display value of the filter that matched it (logging). */
  excludedValueById: Map<string, string>;
  /** Top-headline rows this batch scored into the LOW band or below. Like
   *  `excludedIds` they get NO scoreMap-driven persist — the caller marks them
   *  terminally `excluded`. Computed here (not by the caller) because this is
   *  where the eligible/failed split lives; see collectCulledHeadlineIds. */
  culledHeadlineIds: Set<string>;
}

/**
 * Persona-v3 (Wave 7b M-P5): score a batch through the SINGLE math + judge stage
 * (computeAndJudge, via stage-scoring), then run the reason pass for any
 * survivor that still lacks a reason. Returns RAW scores (bucketing is the
 * caller's job) plus the computed_score / components audit maps.
 *
 * `scoreMap` values are the FINAL raw score (post-judge for math candidates,
 * legacy LLM for backstop). `reasonMap` carries the judge's combined reasons;
 * the reason pass below fills in survivors the judge didn't caption (backstop
 * rows + math rows the judge left below the reason floor but that still bucket
 * into FEED).
 */
export async function batchScoreAndReason(
  candidates: ScoringCandidate[],
): Promise<BatchScoreResult> {
  const useOnDevice = isOnDeviceMode();

  const scoreMap = new Map<string, number>();
  const reasonMap = new Map<string, string>();
  const failedIds = new Set<string>();
  const computedMap = new Map<string, number>();
  const componentsJsonMap = new Map<string, string>();
  let excludedIds = new Set<string>();
  let excludedValueById = new Map<string, string>();
  let culledHeadlineIds = new Set<string>();

  // Ineligible ones get a fixed low score, never hit the engine/LLM.
  const eligible: ScoringCandidate[] = [];
  for (const c of candidates) {
    if (isEligible(c)) eligible.push(c);
    else scoreMap.set(c.id, INELIGIBLE_RELEVANCE);
  }
  if (eligible.length === 0) {
    return {
      scoreMap,
      reasonMap,
      failedIds,
      computedMap,
      componentsJsonMap,
      excludedIds,
      excludedValueById,
      culledHeadlineIds,
    };
  }

  // ---- ONE math + judge stage (shared by both orchestrators) ----
  let stage;
  try {
    stage = await computeAndJudgeForCandidates(eligible);
  } catch (err) {
    logger.warn('[batchScoreAndReason] computeAndJudge failed — fallback relevance', {
      error: err instanceof Error ? err.message : String(err),
      count: eligible.length,
    });
    eligible.forEach((c) => {
      scoreMap.set(c.id, FALLBACK_RELEVANCE);
      failedIds.add(c.id);
    });
    return {
      scoreMap,
      reasonMap,
      failedIds,
      computedMap,
      componentsJsonMap,
      excludedIds,
      excludedValueById,
      culledHeadlineIds,
    };
  }

  // ---- HARD "not interested" filters: drop before anything else ----
  // Excluded rows must never enter the scoring loop below — a missing
  // rawScoreMap entry there means "the stage failed", which would hand them
  // FALLBACK_RELEVANCE and add them to failedIds. They are neither scored nor
  // failed; they are terminal by the user's request.
  excludedIds = stage.excludedIds ?? new Set<string>();
  excludedValueById = stage.excludedValueById ?? new Map<string, string>();
  const active =
    excludedIds.size > 0 ? eligible.filter((c) => !excludedIds.has(c.id)) : eligible;
  if (excludedIds.size > 0) {
    logger.info('[batchScoreAndReason] hard filters excluded rows', {
      excluded: excludedIds.size,
      of: eligible.length,
      values: [...new Set(excludedValueById.values())].slice(0, 10),
    });
  }

  // M-P5c: capture LARGE judge overrides (stage.overrideMap) for the on-device
  // calibration loop. Cheap on the hot path — just shape the numeric
  // computed/judge/components (NO article text) into a CalibrationCase; the
  // tally + persistent counter + threshold notification are all handled
  // asynchronously (fire-and-forget) by the calibration service below.
  //
  // Round-3 A1: the judge is ADVISORY — `raw` here is the APPLIED math score
  // (stage.rawScoreMap == computed for math rows), so the calibration case is
  // built as (computed, judgeScore) with the ADVISORY judge score from
  // stage.judgeScoreMap. applied = computed in every case.
  const overrideCases: import('@/lib/news-harness/scoring-engine').CalibrationCase[] = [];

  for (const c of active) {
    const raw = stage.rawScoreMap.get(c.id);
    if (raw === undefined) {
      scoreMap.set(c.id, FALLBACK_RELEVANCE);
      failedIds.add(c.id);
      continue;
    }
    scoreMap.set(c.id, raw);
    const computed = stage.computedScoreMap.get(c.id);
    if (computed !== undefined) computedMap.set(c.id, computed);
    const comps = stage.componentsMap.get(c.id);
    if (comps) componentsJsonMap.set(c.id, JSON.stringify(comps));
    const reason = stage.reasonMap.get(c.id);
    if (reason) reasonMap.set(c.id, reason);
    if (stage.overrideMap.get(c.id) && computed !== undefined && comps) {
      const judgeScore = stage.judgeScoreMap.get(c.id);
      if (judgeScore !== undefined) {
        overrideCases.push(buildCalibrationCase(c.id, computed, judgeScore, comps));
      }
    }
  }

  // Off the critical path: tally overrides toward the 7-day calibration counter
  // and (if the threshold + rails allow) produce the recalibration notification.
  if (overrideCases.length > 0) {
    void recordOverrides(overrideCases).catch((err) => {
      logger.warn('[batchScoreAndReason] recordOverrides failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }

  // ---- Reason pass: only survivors ≥ reasonRelevanceThreshold that the judge
  //      didn't already caption (backstop rows + un-captioned math rows). ----
  // Top-headline cull, decided here and carried out by the caller. Dropping the
  // culled rows from the survivor set spends no reason tokens on a row that
  // ends up terminally `excluded` (its reason would be discarded with it).
  // `scoreMap` is RAW at this point, so the cull needs its own bucketed copy.
  const bucketedForCull = new Map(scoreMap);
  bucketScores(bucketedForCull);
  culledHeadlineIds = collectCulledHeadlineIds(
    active.filter((c) => !failedIds.has(c.id)),
    bucketedForCull,
  );

  const survivors = active.filter((c) => {
    const r = scoreMap.get(c.id);
    return (
      typeof r === 'number' &&
      r >= ARTICLE_CFG.reasonRelevanceThreshold &&
      !reasonMap.has(c.id) &&
      !failedIds.has(c.id) &&
      !culledHeadlineIds.has(c.id)
    );
  });

  if (survivors.length > 0) {
    const allFactStatements = await loadAllFactStatements();
    const fullUserContext = buildUserContext(allFactStatements);
    if (useOnDevice) {
      for (const c of survivors) {
        const relevance = scoreMap.get(c.id)!;
        try {
          const reason = await generateReasonForCandidate(c, fullUserContext, relevance);
          if (reason) reasonMap.set(c.id, reason);
        } catch (err) {
          logger.warn('[batchScoreAndReason] local reason failed', {
            id: c.id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    } else {
      const phase2 = buildReasonCallsForSurvivors(survivors, scoreMap, allFactStatements);
      const reasonResults = await cloudBatchComplete(phase2.calls, SMALL_MODEL);
      const decodedReasons = decodeCloudBatchResults({
        batchResults: reasonResults,
        promptsById: phase2.promptsById,
        chunkIdToCandidates: phase2.chunkIdToCandidates,
      });
      for (const [id, reason] of decodedReasons.reasonMap) reasonMap.set(id, reason);
      for (const id of decodedReasons.failedIds) failedIds.add(id);
    }
  }

  return {
    scoreMap,
    reasonMap,
    failedIds,
    computedMap,
    componentsJsonMap,
    excludedIds,
    excludedValueById,
    culledHeadlineIds,
  };
}

// ---------------------------------------------------------------------------
// Cloud-call builders — thin wrappers over the harness builders that inject the
// user's full fact bank (loaded from WatermelonDB), the default config, and the
// app logger. Signatures are UNCHANGED from before the harness split.
// ---------------------------------------------------------------------------

/**
 * Sync cloud phase-2: build reason BatchCalls for the survivors — candidates
 * whose phase-1 score cleared REASON_THRESHOLD.
 */
function buildReasonCallsForSurvivors(
  survivors: ScoringCandidate[],
  scoreMap: Map<string, number>,
  allFactStatements: string[],
): CloudCallBundle {
  const calls: BatchCall[] = [];
  const promptsById = new Map<string, string>();
  const fullUserContext = buildUserContext(allFactStatements);

  for (const c of survivors) {
    const relevance = scoreMap.get(c.id);
    if (typeof relevance !== 'number') continue;
    const reasonPrompt = buildReasonUserMessage({
      userContext: fullUserContext,
      articleTitle: c.titleEn ?? '',
      articleDescription: c.descriptionEn ?? '',
      articleCountry: resolveCountryName(c.countryCode),
      relevance,
      relatedFacts: c.relatedFacts.map((f) => f.statement),
    });
    const reasonId = `reason:${c.id}`;
    promptsById.set(reasonId, reasonPrompt);
    calls.push({
      id: reasonId,
      // P4b: a TOP-HEADLINE row gets the headline reason prompt (same impact
      // rubric its score pass ran), so the note can name the causal mechanism
      // the scorer accepted. One call per candidate ⇒ no chunking constraint,
      // so this is a straight per-candidate selection.
      system: reasonSystemPromptFor(
        ARTICLE_CFG,
        isHeadlineCandidate(c) ? 'headline' : 'standard',
      ),
      prompt: reasonPrompt,
      temperature: ARTICLE_CFG.reasonTemperature,
      maxTokens: ARTICLE_CFG.reasonMaxTokens,
    });
  }

  return {
    calls,
    promptsById,
    chunkIdToCandidates: new Map(),
    eligibleCandidates: survivors,
  };
}

/**
 * Phase-1 of the two-phase async flow: score-only calls, no reason prompts.
 * Loads the user's fact bank internally so callers keep the original signature.
 *
 * P4b: the system prompt and the chunk size are chosen by the variant the
 * candidates resolve to — TOP-HEADLINE sets take the indirect-impact prompt at
 * CLOUD_HEADLINE_SCORE_CHUNK_SIZE, everything else the standard pair at
 * ARTICLES_PER_SCORE_PROMPT. The selection helpers are imported from the
 * harness (never re-derived here) so the two paths cannot drift; the size
 * actually used comes back on the bundle for the async decoder to persist.
 */
export async function buildRelevanceCalls(
  candidates: ScoringCandidate[],
): Promise<CloudCallBundle> {
  // isScorableCandidate, not isEligible — a pure TOP-HEADLINE row is factless by
  // design. Dropping it here would leave the batch's rows Unscored with NO score
  // write (the empty-bundle branch in scoring-pipeline markBatchDone's and
  // returns), so every later gate pass would re-elect them: an unbounded churn
  // loop rather than a visible headline.
  const eligible = candidates.filter(isScorableCandidate);
  const variant = resolveScoringVariant(eligible);
  const scoreChunkSize = scoreChunkSizeFor(ARTICLE_CFG, variant);
  const systemPrompt = relevanceSystemPromptFor(ARTICLE_CFG, variant);
  const chunks = chunk(eligible, scoreChunkSize);
  const allFactStatements = await loadAllFactStatements();

  const calls: BatchCall[] = [];
  const promptsById = new Map<string, string>();
  const chunkIdToCandidates = new Map<string, ScoringCandidate[]>();

  chunks.forEach((chunkCandidates, idx) => {
    const { prompt, system } = buildScoreCallForChunk(
      chunkCandidates,
      allFactStatements,
      systemPrompt,
    );
    const scoreId = `score:${idx}`;
    promptsById.set(scoreId, prompt);
    chunkIdToCandidates.set(scoreId, chunkCandidates);
    calls.push({
      id: scoreId,
      system,
      prompt,
      temperature: ARTICLE_CFG.scoreTemperature,
      maxTokens: SCORE_BATCH_MAX_TOKENS,
    });
  });

  return {
    calls,
    promptsById,
    chunkIdToCandidates,
    eligibleCandidates: eligible,
    scoreChunkSize,
  };
}

/**
 * Phase-2 of the two-phase async flow: reason-only calls for the subset of
 * candidates whose relevance exceeds `subsetThreshold`.
 */
export async function buildReasonCallsForSubset(
  candidates: ScoringCandidate[],
  relevanceMap: Record<string, number>,
  subsetThreshold: number,
): Promise<CloudCallBundle> {
  const subset = candidates.filter((c) => {
    // This is the LIVE reason path (scoring-pipeline :1231 and :1846). Fixing
    // only the harness twin would fix the offline harness and leave prod
    // broken: a factless headline scoring 0.6 would get no reason, stay
    // `reason_pending`, and isVisible would keep it invisible.
    if (!isScorableCandidate(c)) return false;
    const rel = relevanceMap[c.id];
    return typeof rel === 'number' && rel > subsetThreshold;
  });

  const calls: BatchCall[] = [];
  const promptsById = new Map<string, string>();
  const allFactStatements = await loadAllFactStatements();
  const fullUserContext = buildUserContext(allFactStatements);

  for (const c of subset) {
    const reasonPrompt = buildReasonUserMessage({
      userContext: fullUserContext,
      articleTitle: c.titleEn ?? '',
      articleDescription: c.descriptionEn ?? '',
      articleCountry: resolveCountryName(c.countryCode),
      relevance: relevanceMap[c.id],
      relatedFacts: c.relatedFacts.map((f) => f.statement),
    });
    const reasonId = `reason:${c.id}`;
    promptsById.set(reasonId, reasonPrompt);
    calls.push({
      id: reasonId,
      // P4b: a TOP-HEADLINE row gets the headline reason prompt (same impact
      // rubric its score pass ran), so the note can name the causal mechanism
      // the scorer accepted. One call per candidate ⇒ no chunking constraint,
      // so this is a straight per-candidate selection.
      system: reasonSystemPromptFor(
        ARTICLE_CFG,
        isHeadlineCandidate(c) ? 'headline' : 'standard',
      ),
      prompt: reasonPrompt,
      temperature: ARTICLE_CFG.reasonTemperature,
      maxTokens: ARTICLE_CFG.reasonMaxTokens,
    });
  }

  return {
    calls,
    promptsById,
    chunkIdToCandidates: new Map(),
    eligibleCandidates: subset,
  };
}

/**
 * Decode a raw BatchCompletionResult[] back into per-candidate score + reason
 * maps. Thin wrapper that injects the app logger + default config.
 */
export function decodeCloudBatchResults(params: {
  batchResults: BatchCompletionResult[];
  promptsById: Map<string, string>;
  chunkIdToCandidates: Map<string, ScoringCandidate[]>;
}): DecodedResults {
  return harnessDecodeCloudBatchResults(params, ARTICLE_CFG, appHarnessLogger);
}

/** Exported alias so the reconciler can import a canonical helper name. */
export const decodeResults = decodeCloudBatchResults;

// --- Second-pass FEED verifier (cloud) ---
//
// Runs the validated second-pass FEED verifier over a batch's freshly-decoded
// RAW scores, demoting clear first-pass false positives out of FEED. Mutates
// `scoreMap` IN PLACE (raw scores) and returns the number of articles demoted.
//
// This is the production wiring point for the pipelined cloud path
// (scoring-pipeline.ts::handleRelevanceResults calls it after score decode,
// before bucketing/persist). The verifier LLM call goes through the SAME E2EE
// primitive as the first pass (`cloudBatchComplete`) — article content + facts
// are encrypted client-side, so the privacy model is preserved. FAIL-OPEN: any
// error (LLM failure, empty facts) leaves every score untouched. Gated by
// config.feedVerifierEnabled. `candidates` must carry title/description/facts
// (as returned by getUnscoredSuggestionsWithFacts).
export async function runFeedVerifierPass(
  candidates: ScoringCandidate[],
  scoreMap: Map<string, number>,
): Promise<number> {
  if (!ARTICLE_CFG.feedVerifierEnabled) return 0;
  const feedCandidates = candidates.filter(
    (c) => (scoreMap.get(c.id) ?? 0) >= ARTICLE_CFG.discardFloor,
  );
  if (feedCandidates.length === 0) return 0;

  try {
    const allFactStatements = await loadAllFactStatements();
    const { calls, verifyIdToCandidates } = buildFeedVerifierCalls(
      feedCandidates,
      allFactStatements,
      ARTICLE_CFG,
      appHarnessLogger,
    );
    if (calls.length === 0) return 0;
    const results = await cloudBatchComplete(calls, SMALL_MODEL);
    const demoted = applyFeedVerifierDecisions(
      scoreMap,
      verifyIdToCandidates,
      results,
      ARTICLE_CFG,
      appHarnessLogger,
    );
    logger.info('[runFeedVerifierPass] verified batch', {
      audited: feedCandidates.length,
      demoted,
    });
    return demoted;
  } catch (err) {
    logger.warn('[runFeedVerifierPass] verifier failed — scores unchanged', {
      error: err instanceof Error ? err.message : String(err),
    });
    return 0;
  }
}

// --- Main entry: score every unscored row ---

export async function processAllUnscored(
  onProgress?: (completed: number, total: number) => void,
  batchSize = 20,
  onBatchComplete?: (updates: { id: string; relevance: number; reason: string | null }[]) => void,
): Promise<number> {
  const totalUnscored = await countUnscoredSuggestions();
  if (totalUnscored === 0) {
    onProgress?.(0, 0);
    return 0;
  }

  let totalProcessed = 0;
  onProgress?.(0, totalUnscored);

  while (true) {
    const batch = await getUnscoredSuggestionsWithFacts(batchSize);
    if (batch.length === 0) break;

    const {
      scoreMap,
      reasonMap,
      failedIds,
      computedMap,
      componentsJsonMap,
      excludedIds,
      culledHeadlineIds,
    } = await batchScoreAndReason(batch);

    // Snapshot RAW (post-judge) scores before bucketing — persisted as
    // raw_score for within-section ordering (the bucketed value is `relevance`).
    const rawMap = new Map(scoreMap);
    // Bucket qualifying raw scores into LOW (0.4) / MEDIUM (0.6) / HIGH (0.8) /
    // EMERGENCY (1.1). Below-threshold rows stay untouched and are discarded.
    bucketScores(scoreMap);

    const succeeded: { id: string; relevance: number; reason: string | null }[] = [];

    // Hard-filtered + culled-headline rows: ONE terminal write, no scoring
    // result (saveScoringResult would overwrite the terminal Excluded status).
    // They count as processed (they DID leave `unscored`, so the loop still
    // terminates and onProgress's denominator stays honest) and are emitted to
    // onBatchComplete exactly like a discarded row so the store refreshes.
    if (excludedIds.size > 0 || culledHeadlineIds.size > 0) {
      const ids = [...new Set([...excludedIds, ...culledHeadlineIds])];
      try {
        await batchMarkExcluded(ids);
        for (const id of ids) succeeded.push({ id, relevance: 0, reason: null });
      } catch (err) {
        logger.error('[processAllUnscored] batchMarkExcluded failed', err, {
          count: ids.length,
        });
      }
    }
    if (culledHeadlineIds.size > 0) {
      logger.info('[processAllUnscored] culled low-band top headlines', {
        culled: culledHeadlineIds.size,
        of: batch.length,
      });
    }

    await Promise.all(
      batch.map(async (candidate) => {
        if (
          failedIds.has(candidate.id) ||
          excludedIds.has(candidate.id) ||
          culledHeadlineIds.has(candidate.id)
        )
          return;
        const relevance = scoreMap.get(candidate.id) ?? 0.3;
        const reason = reasonMap.get(candidate.id) ?? '';
        // REASON_THRESHOLD = 0 → reasons generated for every row, including
        // sub-DISCARD-floor low-relevance ones. Skip flag now only fires if
        // phase-2 was bypassed entirely.
        const reasonSkipped = relevance < REASON_THRESHOLD;
        try {
          await saveScoringResult(candidate.id, {
            relevance,
            reason,
            reasonSkipped,
            computedScore: computedMap.get(candidate.id),
            rawScore: rawMap.get(candidate.id),
            scoreComponentsJson: componentsJsonMap.get(candidate.id),
          });
          succeeded.push({ id: candidate.id, relevance, reason: reason || null });
        } catch (err) {
          logger.error('[processAllUnscored] saveScoringResult failed', err, { id: candidate.id });
        }
      }),
    );

    if (succeeded.length > 0 && onBatchComplete) onBatchComplete(succeeded);

    totalProcessed += succeeded.length;
    onProgress?.(totalProcessed, totalUnscored);

    if (succeeded.length === 0) {
      logger.warn('[processAllUnscored] entire batch failed — stopping to retry next cycle', {
        failedCount: failedIds.size,
      });
      break;
    }

    // A6: yield to interactions between scoring batches so the on-device pass
    // (which runs entirely on the JS thread) doesn't starve rendering/touch —
    // the just-scored batch can paint before the next batch is fetched + scored.
    await yieldToInteractions();
  }

  onProgress?.(totalProcessed, totalUnscored);

  // After scoring fresh rows, sweep any previously-scored rows whose reason
  // generation failed (reason_generation_completed = false). Non-fatal.
  try {
    await retryMissingReasons(batchSize);
  } catch (err) {
    logger.captureException(err, {
      tags: { service: 'scoring-service', method: 'processAllUnscored.retry' },
    });
  }

  return totalProcessed;
}

// --- Reason retry: regenerate reasons for rows where the first pass returned empty ---

/**
 * Re-runs reason generation for cluster suggestions that were scored in a
 * previous sync but whose reason came back empty. Quiet background pass.
 * Returns the count of rows whose reason was successfully populated.
 */
export async function retryMissingReasons(batchSize = 10): Promise<number> {
  const useOnDevice = isOnDeviceMode();
  let totalRecovered = 0;

  while (true) {
    const batch = await getScoredSuggestionsWithoutReasons(batchSize);
    if (batch.length === 0) break;

    const reasonMap = new Map<string, string>();
    const allFactStatements = await loadAllFactStatements();
    const fullUserContext = buildUserContext(allFactStatements);

    if (useOnDevice) {
      // Local path — sequential.
      for (const candidate of batch) {
        // isScorableCandidate covers both the text and the fact test. A pure
        // TOP-HEADLINE row is factless by design, so the old fact `continue`
        // stranded it in `reason_pending` forever once its first reason attempt
        // failed — this is the recovery path for exactly that row.
        if (!isScorableCandidate(candidate)) continue;
        const relevance = candidate.relevance ?? 0.7;
        try {
          const reason = await generateReasonForCandidate(
            candidate,
            fullUserContext,
            relevance,
          );
          if (reason) reasonMap.set(candidate.id, reason);
        } catch (err) {
          logger.warn('[retryMissingReasons] local reason generation failed', {
            id: candidate.id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    } else {
      // Cloud path — single batch call for all reason prompts in this batch.
      const calls: BatchCall[] = [];
      const promptsById = new Map<string, string>();
      for (const candidate of batch) {
        // Same leak on the cloud half — see the local branch above.
        if (!isScorableCandidate(candidate)) continue;
        const reasonPrompt = buildReasonUserMessage({
          userContext: fullUserContext,
          // `?? ''` is for the TYPE only: isScorableCandidate already guarantees
          // both are non-empty (it requires title+description on every branch).
          // The old code narrowed via an explicit `!titleEn || !descriptionEn`
          // continue, which the predicate now subsumes.
          articleTitle: candidate.titleEn ?? '',
          articleDescription: candidate.descriptionEn ?? '',
          articleCountry: resolveCountryName(candidate.countryCode),
          relevance: candidate.relevance ?? 0.7,
          relatedFacts: candidate.relatedFacts.map((f) => f.statement),
        });
        const reasonId = `reason:${candidate.id}`;
        promptsById.set(reasonId, reasonPrompt);
        calls.push({
          id: reasonId,
          system: reasonSystemPromptFor(
            ARTICLE_CFG,
            isHeadlineCandidate(candidate) ? 'headline' : 'standard',
          ),
          prompt: reasonPrompt,
          temperature: ARTICLE_CFG.reasonTemperature,
          maxTokens: ARTICLE_CFG.reasonMaxTokens,
        });
      }

      if (calls.length === 0) break;

      try {
        const batchResults = await cloudBatchComplete(calls, SMALL_MODEL);
        for (const result of batchResults) {
          const serverId = result.id.slice('reason:'.length);
          if (result.error) {
            logger.warn('[retryMissingReasons] cloud reason failed', {
              id: serverId,
              error: result.error,
            });
            continue;
          }
          const reason = parseReasonResponse(
            result.output,
            serverId,
            promptsById.get(result.id),
            appHarnessLogger,
          );
          if (reason) reasonMap.set(serverId, reason);
        }
      } catch (err) {
        logger.captureException(err, {
          tags: { service: 'scoring-service', method: 'retryMissingReasons' },
        });
        break;
      }
    }

    // Persist whatever came back non-empty. Leave the empties alone — next sync
    // will pick them up again via the same query.
    await Promise.all(
      Array.from(reasonMap.entries()).map(async ([id, reason]) => {
        try {
          await saveReason(id, reason);
          totalRecovered += 1;
        } catch (err) {
          logger.error('[retryMissingReasons] saveReason failed', err, { id });
        }
      }),
    );

    // If the whole batch came back empty, don't loop infinitely on the same rows.
    if (reasonMap.size === 0) break;
  }

  return totalRecovered;
}
