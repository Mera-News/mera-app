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
  LOCAL_RELEVANCE_SYSTEM_PROMPT,
  LOCAL_REASON_SYSTEM_PROMPT,
  buildBatchScoringUserMessage,
  buildReasonUserMessage,
} from './prompts';
import {
  countUnscoredSuggestions,
  getScoredSuggestionsWithoutReasons,
  getUnscoredSuggestionsWithFacts,
  saveReason,
  saveScoringResult,
  type ScoringCandidate,
} from '../database/services/article-suggestion-service';
import { getFacts } from '../database/services/fact-service';
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
  chunk,
  bucketScores,
  parseBatchRelevanceResponse,
  parseReasonResponse,
  decodeCloudBatchResults as harnessDecodeCloudBatchResults,
  CLOUD_SCORE_CHUNK_SIZE,
  REASON_MIN_RAW_SCORE,
} from '@/lib/news-harness/article-pipeline/scoring';
import type {
  CloudCallBundle,
  DecodedResults,
  ScoringResult,
} from '@/lib/news-harness/article-pipeline/scoring';

const ARTICLE_CFG = DEFAULT_HARNESS_CONFIG.articlePipeline;

const isOnDeviceMode = () =>
  useMeraProtocolStore.getState().processingMode === ProcessingMode.OnDevice;

// --- Re-exports (canonical homes moved to the harness) ---

export {
  bucketScores,
  CLOUD_SCORE_CHUNK_SIZE,
  REASON_MIN_RAW_SCORE,
};
export type { CloudCallBundle, DecodedResults, ScoringResult };

// --- Local constants for the RN-coupled orchestration (mirror harness config) ---

/** Articles bundled into one batched relevance prompt (cloud). */
const ARTICLES_PER_SCORE_PROMPT = ARTICLE_CFG.articlesPerScorePrompt;

/** Local (Qwen3.5-4B on-device) batch size — score one article per call. */
const LOCAL_ARTICLES_PER_SCORE_PROMPT = 1;

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

export async function batchScoreAndReason(
  candidates: ScoringCandidate[],
): Promise<{ scoreMap: Map<string, number>; reasonMap: Map<string, string>; failedIds: Set<string> }> {
  const useOnDevice = isOnDeviceMode();

  const scoreMap = new Map<string, number>();
  const reasonMap = new Map<string, string>();
  const failedIds = new Set<string>();

  // Bucket candidates: ineligible ones get a fixed low score, never hit the LLM.
  const eligible: ScoringCandidate[] = [];
  for (const c of candidates) {
    if (isEligible(c)) eligible.push(c);
    else scoreMap.set(c.id, INELIGIBLE_RELEVANCE);
  }

  if (eligible.length === 0) return { scoreMap, reasonMap, failedIds };

  const chunkSize = useOnDevice ? LOCAL_ARTICLES_PER_SCORE_PROMPT : ARTICLES_PER_SCORE_PROMPT;
  const chunks = chunk(eligible, chunkSize);
  const allFactStatements = await loadAllFactStatements();
  const fullUserContext = buildUserContext(allFactStatements);

  // ---- Local path: one batched score call per chunk, then sequential reasons ----
  if (useOnDevice) {
    for (const chunkCandidates of chunks) {
      const { prompt, system } = buildScoreCallForChunk(
        chunkCandidates,
        allFactStatements,
        LOCAL_RELEVANCE_SYSTEM_PROMPT,
      );
      let scores: number[];
      try {
        const output = await completeLocal({
          systemPrompt: system,
          prompt,
          maxTokens: SCORE_BATCH_MAX_TOKENS,
          temperature: ARTICLE_CFG.scoreTemperature,
          responseFormat: 'json',
        });
        scores = parseBatchRelevanceResponse(
          output,
          chunkCandidates.length,
          chunkCandidates[0].id,
          prompt,
          ARTICLE_CFG,
          appHarnessLogger,
        );
      } catch (err) {
        logger.warn('[batchScoreAndReason] local chunk score failed', {
          error: err instanceof Error ? err.message : String(err),
          chunkSize: chunkCandidates.length,
        });
        chunkCandidates.forEach((c) => {
          scoreMap.set(c.id, FALLBACK_RELEVANCE);
          failedIds.add(c.id);
        });
        continue;
      }
      for (let i = 0; i < chunkCandidates.length; i++) {
        const c = chunkCandidates[i];
        const relevance = scores[i];
        scoreMap.set(c.id, relevance);
        if (relevance < REASON_THRESHOLD) continue;
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
    }
    return { scoreMap, reasonMap, failedIds };
  }

  // ---- Cloud path: two-phase. Phase-1 sends only score chunks; phase-2 sends
  //      reason calls *only* for candidates whose decoded score >= threshold. ----
  const phase1 = buildScoreOnlyCloudCalls(chunks, allFactStatements);
  const scoreResults = await cloudBatchComplete(phase1.calls, SMALL_MODEL);

  const decodedScores = decodeCloudBatchResults({
    batchResults: scoreResults,
    promptsById: phase1.promptsById,
    chunkIdToCandidates: phase1.chunkIdToCandidates,
  });

  for (const [id, score] of decodedScores.scoreMap) scoreMap.set(id, score);
  for (const id of decodedScores.failedIds) failedIds.add(id);

  // Phase-2: only candidates clearing REASON_THRESHOLD get a reason call, and
  // each call carries the *actual* decoded score so the reason tone matches.
  const survivors = eligible.filter((c) => {
    const r = scoreMap.get(c.id);
    return typeof r === 'number' && r >= REASON_THRESHOLD;
  });

  if (survivors.length > 0) {
    const phase2 = buildReasonCallsForSurvivors(
      survivors,
      scoreMap,
      allFactStatements,
    );
    const reasonResults = await cloudBatchComplete(phase2.calls, SMALL_MODEL);
    const decodedReasons = decodeCloudBatchResults({
      batchResults: reasonResults,
      promptsById: phase2.promptsById,
      chunkIdToCandidates: phase2.chunkIdToCandidates,
    });
    for (const [id, reason] of decodedReasons.reasonMap) reasonMap.set(id, reason);
    for (const id of decodedReasons.failedIds) failedIds.add(id);
  }

  return { scoreMap, reasonMap, failedIds };
}

// ---------------------------------------------------------------------------
// Cloud-call builders — thin wrappers over the harness builders that inject the
// user's full fact bank (loaded from WatermelonDB), the default config, and the
// app logger. Signatures are UNCHANGED from before the harness split.
// ---------------------------------------------------------------------------

/**
 * Sync cloud phase-1: build score-only BatchCalls from pre-chunked candidates.
 */
function buildScoreOnlyCloudCalls(
  candidateChunks: ScoringCandidate[][],
  allFactStatements: string[],
): CloudCallBundle {
  const calls: BatchCall[] = [];
  const promptsById = new Map<string, string>();
  const chunkIdToCandidates = new Map<string, ScoringCandidate[]>();
  const eligibleCandidates: ScoringCandidate[] = [];

  candidateChunks.forEach((chunkCandidates, idx) => {
    eligibleCandidates.push(...chunkCandidates);
    const { prompt, system } = buildScoreCallForChunk(chunkCandidates, allFactStatements);
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

  return { calls, promptsById, chunkIdToCandidates, eligibleCandidates };
}

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
      system: CLOUD_REASON_SYSTEM_PROMPT,
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
 */
export async function buildRelevanceCalls(
  candidates: ScoringCandidate[],
): Promise<CloudCallBundle> {
  const eligible = candidates.filter(isEligible);
  const chunks = chunk(eligible, ARTICLES_PER_SCORE_PROMPT);
  const allFactStatements = await loadAllFactStatements();

  const calls: BatchCall[] = [];
  const promptsById = new Map<string, string>();
  const chunkIdToCandidates = new Map<string, ScoringCandidate[]>();

  chunks.forEach((chunkCandidates, idx) => {
    const { prompt, system } = buildScoreCallForChunk(chunkCandidates, allFactStatements);
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
    if (!isEligible(c)) return false;
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
      system: CLOUD_REASON_SYSTEM_PROMPT,
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

    const { scoreMap, reasonMap, failedIds } = await batchScoreAndReason(batch);

    // Bucket qualifying raw scores into LOW (0.4) / MEDIUM (0.6) / HIGH (0.8) /
    // EMERGENCY (1.1). Below-threshold rows stay untouched and are discarded.
    bucketScores(scoreMap);

    const succeeded: { id: string; relevance: number; reason: string | null }[] = [];
    await Promise.all(
      batch.map(async (candidate) => {
        if (failedIds.has(candidate.id)) return;
        const relevance = scoreMap.get(candidate.id) ?? 0.3;
        const reason = reasonMap.get(candidate.id) ?? '';
        // REASON_THRESHOLD = 0 → reasons generated for every row, including
        // sub-DISCARD-floor low-relevance ones. Skip flag now only fires if
        // phase-2 was bypassed entirely.
        const reasonSkipped = relevance < REASON_THRESHOLD;
        try {
          await saveScoringResult(candidate.id, { relevance, reason, reasonSkipped });
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
        if (!candidate.titleEn || !candidate.descriptionEn) continue;
        if (candidate.relatedFacts.length === 0) continue;
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
        if (!candidate.titleEn || !candidate.descriptionEn) continue;
        if (candidate.relatedFacts.length === 0) continue;
        const reasonPrompt = buildReasonUserMessage({
          userContext: fullUserContext,
          articleTitle: candidate.titleEn,
          articleDescription: candidate.descriptionEn,
          articleCountry: resolveCountryName(candidate.countryCode),
          relevance: candidate.relevance ?? 0.7,
          relatedFacts: candidate.relatedFacts.map((f) => f.statement),
        });
        const reasonId = `reason:${candidate.id}`;
        promptsById.set(reasonId, reasonPrompt);
        calls.push({
          id: reasonId,
          system: CLOUD_REASON_SYSTEM_PROMPT,
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
