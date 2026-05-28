// Scoring Service — On-device relevance scoring of ArticleSuggestions (two-pass)
// Pass 1: Relevance score, batched 5 articles per LLM call (one JSON array out)
// Pass 2: Reason generation per article (only for relevance >= REASON_THRESHOLD)
//
// Input comes from getUnscoredSuggestionsWithFacts which pre-joins each
// article_suggestion row with its linked facts via article_suggestion_facts.
// Output is written to the article_suggestions.relevance / .reason columns
// directly — relevance IS NULL is the canonical "not yet scored" state.

import countries from 'i18n-iso-countries';
import en from 'i18n-iso-countries/langs/en.json';
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

const isOnDeviceMode = () =>
  useMeraProtocolStore.getState().processingMode === ProcessingMode.OnDevice;
import type { BatchCall } from '../llm/types';
import type { BatchCompletionResult } from '../llm/cloudComplete';

countries.registerLocale(en);

function resolveCountryName(code: string | null | undefined): string | undefined {
  if (!code) return undefined;
  return countries.getName(code, 'en', { select: 'alias' }) || code;
}

// --- Types ---

export interface ScoringResult {
  relevance: number;
  reason: string | null;
}

/** Articles bundled into one batched relevance prompt.
 *  15 fits comfortably in Qwen3-30B's context (system ~1.8K tokens + 15 ×
 *  ~110 per article ≈ 3.5K in, ~150 out) and cuts phase-1 HTTP round-trips
 *  ~3× vs the previous 5. `decodeResults` already tolerates length
 *  mismatches via the failedIds path. */
const ARTICLES_PER_SCORE_PROMPT = 5;

/** Local (Qwen3.5-4B on-device, qwen35 architecture) batch size — score one
 *  article per call. The 3.5-4B is more capable than 3-4B, but per-article
 *  attention still wins for calibration on a 4B at Q4 quant — even if 2 would
 *  parse fine. Cloud's 30B-A3B holds 5 fine. */
const LOCAL_ARTICLES_PER_SCORE_PROMPT = 1;

/** Relevance threshold — generate reasons for every scored candidate, including
 *  low-relevance ones. The reason prompt has explicit tone bands down to ≤0.25
 *  so low scores get an honest "topic-only link, named gap" sentence instead of
 *  being skipped. Set to 0 to opt every eligible candidate into phase-2. */
const REASON_THRESHOLD = 0;

/** Bucketing DISCARD floor — raw scores below this stay raw (not bucketed).
 *  Independent of REASON_THRESHOLD so we can keep the LOW-bucket cutoff at 0.4
 *  while still generating reasons for sub-0.4 articles. */
const DISCARD_FLOOR = 0.4;

/** Raw-score floor for phase-2 reason generation in the async reconciler.
 *  Set to 0 so reasons are generated for low-relevance articles too — the
 *  reason prompt has explicit honest tone bands down to ≤0.25. The async
 *  path also filters by REASON_RELEVANCE_THRESHOLD (bucketed) for *displaying*
 *  rows; this knob only governs whether a reason gets written. */
export const REASON_MIN_RAW_SCORE = 0;

/** Fallback when LLM scoring fails or output is unparseable. */
const FALLBACK_RELEVANCE = 0.3;

/** Default for candidates that are ineligible for scoring (no body, no facts). */
const INELIGIBLE_RELEVANCE = 0.2;

/** Output token ceiling for one batched score call. ~6 tokens per "0.73, "
 *  entry; 80 leaves slack for a 5-article array plus JSON framing. */
const SCORE_BATCH_MAX_TOKENS = 80;

// --- Helpers ---

/**
 * Build the "[User facts] …" string from the user's FULL fact bank. Every
 * scoring / reason call receives the same bank so the model always has the
 * complete picture (location + profession + family + interests + …) when
 * deciding relevance or writing a reason. Per-article topic-match facts are
 * passed separately as `Related User Fact`.
 *
 * Falls back to the candidate's own retrieval-linked facts if the bank is
 * empty (defensive — a fact should always exist if the candidate has a
 * related fact).
 */
function buildUserContext(
  allFactStatements: string[],
  candidate?: ScoringCandidate,
): string {
  const fromBank = allFactStatements.filter((s) => s && s.trim().length > 0);
  const statements =
    fromBank.length > 0
      ? fromBank
      : (candidate?.relatedFacts.map((f) => f.statement) ?? []);
  return `[User facts] ${statements.join('. ')}.`;
}

async function loadAllFactStatements(): Promise<string[]> {
  const facts = await getFacts();
  return facts
    .map((f) => f.statement)
    .filter((s) => typeof s === 'string' && s.trim().length > 0);
}

function isEligible(c: ScoringCandidate): boolean {
  return Boolean(c.titleEn && c.descriptionEn && c.relatedFacts.length > 0);
}

function chunk<T>(arr: T[], size: number): T[][] {
  if (size <= 0) return [arr];
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** Bucket cutoffs (raw LLM score) and persisted representative values. */
const MEDIUM_PRIORITY_CUTOFF = 0.6;
const HIGH_PRIORITY_CUTOFF = 0.8;
const EMERGENCY_PRIORITY_CUTOFF = 1.0; // strictly greater than this → EMERGENCY
const LOW_PRIORITY_SCORE = 0.4;
const MEDIUM_PRIORITY_SCORE = 0.6;
const HIGH_PRIORITY_SCORE = 0.8;
const EMERGENCY_PRIORITY_SCORE = 1.1;

/**
 * Bucket raw LLM scores into four priority bands in-place:
 *   raw <  DISCARD_FLOOR     → DISCARD   (untouched, still gets reason)
 *   floor ≤ raw < 0.6        → LOW       (set to LOW_PRIORITY_SCORE)
 *   0.6 ≤ raw < 0.8          → MEDIUM    (set to MEDIUM_PRIORITY_SCORE)
 *   0.8 ≤ raw ≤ 1.0          → HIGH      (set to HIGH_PRIORITY_SCORE)
 *   raw >  1.0               → EMERGENCY (set to EMERGENCY_PRIORITY_SCORE)
 */
export { bucketScores };
function bucketScores(scoreMap: Map<string, number>): void {
  for (const [id, raw] of scoreMap) {
    if (raw < DISCARD_FLOOR) continue;
    if (raw > EMERGENCY_PRIORITY_CUTOFF) scoreMap.set(id, EMERGENCY_PRIORITY_SCORE);
    else if (raw >= HIGH_PRIORITY_CUTOFF) scoreMap.set(id, HIGH_PRIORITY_SCORE);
    else if (raw >= MEDIUM_PRIORITY_CUTOFF) scoreMap.set(id, MEDIUM_PRIORITY_SCORE);
    else scoreMap.set(id, LOW_PRIORITY_SCORE);
  }
}

// --- Batch scoring + reason generation ---

function buildScoreCallForChunk(
  chunk: ScoringCandidate[],
  allFactStatements: string[],
  systemPrompt: string = CLOUD_RELEVANCE_SYSTEM_PROMPT,
): { prompt: string; system: string } {
  const userContext = buildUserContext(allFactStatements);
  const prompt = buildBatchScoringUserMessage({
    userContext,
    articles: chunk.map((c) => ({
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
        maxTokens: 64,
        temperature: 0.2,
        responseFormat: 'json',
      })
    : await cloudComplete({
        systemPrompt: CLOUD_REASON_SYSTEM_PROMPT,
        prompt: userMessage,
        maxTokens: 64,
        temperature: 0.2,
        model: SMALL_MODEL,
      });
  return parseReasonResponse(output, candidate.id, userMessage);
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
          temperature: 0.1,
          responseFormat: 'json',
        });
        scores = parseBatchRelevanceResponse(output, chunkCandidates.length, chunkCandidates[0].id, prompt);
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
  //      reason calls *only* for candidates whose decoded score >= threshold.
  //      The earlier optimistic fan-out queued reason calls for every eligible
  //      candidate with a hardcoded relevance=0.7 and discarded the losers
  //      post-hoc — that wasted ~half the reason tokens and fed the reason
  //      model a lie about the score so its tone calibration drifted.
  //      Pays one extra HTTP roundtrip per refresh in exchange. ----
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
// Exported helpers — shared between the sync batchScoreAndReason path and the
// async (background-task) inference path in submitInferenceJob + reconciler.
// ---------------------------------------------------------------------------

export interface CloudCallBundle {
  calls: BatchCall[];
  promptsById: Map<string, string>;
  chunkIdToCandidates: Map<string, ScoringCandidate[]>;
  /** Candidates that passed eligibility — the source of truth for candidateIds
   *  when persisting a pending async job. */
  eligibleCandidates: ScoringCandidate[];
}

/** Chunk size used when fanning score prompts into BatchCalls. Exported so the
 *  async reconciler can reconstruct the chunk-to-candidates mapping identically. */
export const CLOUD_SCORE_CHUNK_SIZE = ARTICLES_PER_SCORE_PROMPT;

/**
 * Sync cloud phase-1: build score-only BatchCalls from pre-chunked candidates.
 * No reason fan-out — phase-2 issues those after scores come back, with the
 * actual decoded relevance per call.
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
      temperature: 0.1,
      maxTokens: SCORE_BATCH_MAX_TOKENS,
    });
  });

  return { calls, promptsById, chunkIdToCandidates, eligibleCandidates };
}

/**
 * Sync cloud phase-2: build reason BatchCalls for the survivors — candidates
 * whose phase-1 score cleared REASON_THRESHOLD. Each reason prompt carries
 * the candidate's actual decoded score so the reason model's tone matches the
 * score (the prior optimistic path lied with a hardcoded 0.7).
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
      temperature: 0.2,
      maxTokens: 64,
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
 * Each chunk produces one BatchCall with id `score:N`.
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
      temperature: 0.1,
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
 * candidates whose relevance (computed in phase-1) exceeds `subsetThreshold`.
 * Caller passes the fixed `REASON_RELEVANCE_THRESHOLD` (0.3) so only articles
 * the user would actually see consume reason-generation compute.
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
      temperature: 0.2,
      maxTokens: 64,
    });
  }

  return {
    calls,
    promptsById,
    // Phase-2 has no score chunks — this map stays empty but keeps the
    // CloudCallBundle shape consistent so the decoder can dispatch by prefix.
    chunkIdToCandidates: new Map(),
    eligibleCandidates: subset,
  };
}

export interface DecodedResults {
  scoreMap: Map<string, number>;
  reasonMap: Map<string, string>;
  failedIds: Set<string>;
}

/**
 * Decode a raw BatchCompletionResult[] (as returned by the server's
 * /v1/chat/completions/batch or by the async /v1/inference/jobs/:id/results
 * endpoint) back into per-candidate score + reason maps. Kept in one place
 * so sync and async paths produce identical outputs.
 */
export function decodeCloudBatchResults(params: {
  batchResults: BatchCompletionResult[];
  promptsById: Map<string, string>;
  chunkIdToCandidates: Map<string, ScoringCandidate[]>;
}): DecodedResults {
  const { batchResults, promptsById, chunkIdToCandidates } = params;
  const scoreMap = new Map<string, number>();
  const reasonMap = new Map<string, string>();
  const failedIds = new Set<string>();

  for (const result of batchResults) {
    if (result.id.startsWith('score:')) {
      const chunkCandidates = chunkIdToCandidates.get(result.id) ?? [];
      if (result.error) {
        logger.warn('[decodeCloudBatchResults] chunk score failed', {
          chunkId: result.id,
          error: result.error,
          chunkSize: chunkCandidates.length,
        });
        chunkCandidates.forEach((c) => {
          scoreMap.set(c.id, FALLBACK_RELEVANCE);
          failedIds.add(c.id);
        });
        continue;
      }
      const scores = parseBatchRelevanceResponse(
        result.output,
        chunkCandidates.length,
        chunkCandidates[0]?.id ?? result.id,
        promptsById.get(result.id),
      );
      chunkCandidates.forEach((c, i) => scoreMap.set(c.id, scores[i]));
    } else if (result.id.startsWith('reason:')) {
      const serverId = result.id.slice('reason:'.length);
      if (result.error) {
        reasonMap.set(serverId, '');
      } else {
        reasonMap.set(
          serverId,
          parseReasonResponse(
            result.output,
            serverId,
            promptsById.get(result.id),
          ),
        );
      }
    }
  }

  return { scoreMap, reasonMap, failedIds };
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
  // generation failed (reason_generation_completed = false). Non-fatal —
  // a failure here doesn't invalidate the main pass.
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
 * previous sync but whose reason came back empty. Quiet background pass —
 * no progress UI, no device-progress store updates. Any still-empty outputs
 * are left empty so the next syncFeed tries again.
 *
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
          temperature: 0.2,
          maxTokens: 64,
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
          const reason = parseReasonResponse(result.output, serverId, promptsById.get(result.id));
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

// --- Response parsing ---

function clampRelevance(n: number): number {
  return Math.max(0, Math.min(1.1, n));
}

/**
 * Parse a batched relevance response — expects a JSON array of N floats in
 * 0.0–1.1 input order. Falls back to extracting any numbers via regex if the
 * output isn't valid JSON. Always returns exactly `expectedCount` scores,
 * padding with FALLBACK_RELEVANCE if the LLM returned fewer.
 */
function parseBatchRelevanceResponse(
  output: string,
  expectedCount: number,
  id: string,
  prompt?: string,
): number[] {
  const trimmed = output.trim();

  // Primary path: JSON array of numbers.
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (Array.isArray(parsed)) {
      const numbers = parsed.map((v) => (typeof v === 'number' ? clampRelevance(v) : NaN));
      if (numbers.every((n) => !isNaN(n))) {
        if (numbers.length === expectedCount) return numbers;
        logger.warn('Batch relevance: array length mismatch — padding with fallback', {
          expected: expectedCount,
          got: numbers.length,
          id,
        });
        const padded = numbers.slice(0, expectedCount);
        while (padded.length < expectedCount) padded.push(FALLBACK_RELEVANCE);
        return padded;
      }
    }
    // Single-number JSON (legacy format) — only valid for single-article chunks.
    if (typeof parsed === 'number' && expectedCount === 1) return [clampRelevance(parsed)];
  } catch {
    // fall through
  }

  // Fallback: regex-extract every number from the string.
  const matches = trimmed.match(/-?\d+\.?\d*/g) ?? [];
  const nums = matches
    .map((s) => parseFloat(s))
    .filter((n) => !isNaN(n))
    .map(clampRelevance);

  if (nums.length >= expectedCount) return nums.slice(0, expectedCount);
  if (nums.length > 0) {
    logger.warn('Batch relevance: regex fallback under-filled — padding with fallback', {
      expected: expectedCount,
      got: nums.length,
      id,
      prompt,
    });
    const padded = [...nums];
    while (padded.length < expectedCount) padded.push(FALLBACK_RELEVANCE);
    return padded;
  }

  logger.warn('Batch relevance: failed to parse output — using fallback for all', {
    output: trimmed,
    expected: expectedCount,
    id,
    prompt,
  });
  return new Array<number>(expectedCount).fill(FALLBACK_RELEVANCE);
}

function parseReasonResponse(output: string, id: string, prompt?: string): string {
  let text = output.trim();

  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === 'string' && parsed.length > 0) {
      text = parsed;
    } else if (typeof parsed === 'object' && parsed !== null && 'reason' in parsed) {
      const reason = (parsed as { reason: unknown }).reason;
      if (typeof reason === 'string') text = reason;
    }
  } catch {
    text = text.replace(/^["']|["']$/g, '');
  }

  text = text
    .replace(/\*?\*?\[User facts\]\*?\*?.*$/gm, '')
    .replace(/\*?\*?Relevance Score:?\s*[\d.]+\*?\*?/gi, '')
    .replace(/\*?\*?Why this matters to you:?\*?\*?\s*/gi, '')
    .replace(/[*#]+/g, '')
    .replace(/\n+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();

  if (text.length > 0) return text.slice(0, 200);

  logger.warn('Reason generation: failed to parse LLM output', {
    output: output.trim(),
    id,
    prompt,
  });

  return '';
}
