// news-harness — pure article relevance-scoring logic.
//
// Extracted verbatim (behaviour byte-identical) from
// lib/mera-protocol/scoring-service.ts. Everything here is pure: it takes fact
// statements, config, and a logger as parameters instead of reaching into
// WatermelonDB, module constants, or lib/logger. The RN-coupled orchestration
// (batchScoreAndReason, processAllUnscored, retryMissingReasons, local paths)
// stays in scoring-service.ts and calls into these helpers.

import countries from 'i18n-iso-countries';
import en from 'i18n-iso-countries/langs/en.json';
import {
  buildBatchScoringUserMessage,
  buildReasonUserMessage,
} from '../prompts/prompts';
import {
  DEFAULT_HARNESS_CONFIG,
  type ArticlePipelineConfig,
} from '../core/config';
import { NOOP_LOGGER, type HarnessLogger } from '../core/ports';
import type {
  BatchCall,
  BatchCompletionResult,
  CloudCallBundle,
  DecodedResults,
  ScoringCandidate,
  ScoringResult,
} from '../core/types';

// Re-export the shared types for convenience (canonical home is core/types).
export type { CloudCallBundle, DecodedResults, ScoringResult, ScoringCandidate };

const ARTICLE_CFG = DEFAULT_HARNESS_CONFIG.articlePipeline;

countries.registerLocale(en);

export function resolveCountryName(
  code: string | null | undefined,
): string | undefined {
  if (!code) return undefined;
  return countries.getName(code, 'en', { select: 'alias' }) || code;
}

// --- Constants shared with the async (background-task) inference path ---

/** Chunk size used when fanning score prompts into BatchCalls. */
export const CLOUD_SCORE_CHUNK_SIZE = ARTICLE_CFG.articlesPerScorePrompt;

/** Raw-score floor for phase-2 reason generation in the async reconciler. */
export const REASON_MIN_RAW_SCORE = 0;

// --- Helpers ---

/**
 * Build the "[User facts] …" string from the user's FULL fact bank. Falls back
 * to the candidate's own retrieval-linked facts if the bank is empty.
 */
export function buildUserContext(
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

export function isEligible(c: ScoringCandidate): boolean {
  return Boolean(c.titleEn && c.descriptionEn && c.relatedFacts.length > 0);
}

export function chunk<T>(arr: T[], size: number): T[][] {
  if (size <= 0) return [arr];
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * Bucket raw LLM scores into four priority bands in-place:
 *   raw <  discardFloor       → DISCARD   (untouched, still gets reason)
 *   floor ≤ raw < 0.6         → LOW       (set to lowPriorityScore)
 *   0.6 ≤ raw < 0.8           → MEDIUM    (set to mediumPriorityScore)
 *   0.8 ≤ raw ≤ 1.0           → HIGH      (set to highPriorityScore)
 *   raw >  1.0                → EMERGENCY (set to emergencyPriorityScore)
 */
export function bucketScores(
  scoreMap: Map<string, number>,
  config: ArticlePipelineConfig = ARTICLE_CFG,
): void {
  for (const [id, raw] of scoreMap) {
    if (raw < config.discardFloor) continue;
    if (raw > config.emergencyPriorityCutoff)
      scoreMap.set(id, config.emergencyPriorityScore);
    else if (raw >= config.highPriorityCutoff)
      scoreMap.set(id, config.highPriorityScore);
    else if (raw >= config.mediumPriorityCutoff)
      scoreMap.set(id, config.mediumPriorityScore);
    else scoreMap.set(id, config.lowPriorityScore);
  }
}

// --- Batch scoring + reason generation ---

export function buildScoreCallForChunk(
  chunkCandidates: ScoringCandidate[],
  allFactStatements: string[],
  systemPrompt: string = ARTICLE_CFG.relevanceSystemPrompt,
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

/**
 * Phase-1 of the two-phase async flow: score-only calls, no reason prompts.
 * Each chunk produces one BatchCall with id `score:N`. Pure — fact statements
 * are supplied by the caller (previously loaded from WatermelonDB inside).
 */
export function buildRelevanceCalls(
  candidates: ScoringCandidate[],
  factStatements: string[],
  config: ArticlePipelineConfig = ARTICLE_CFG,
  logger: HarnessLogger = NOOP_LOGGER,
): CloudCallBundle {
  const eligible = candidates.filter(isEligible);
  const chunks = chunk(eligible, config.articlesPerScorePrompt);

  const calls: BatchCall[] = [];
  const promptsById = new Map<string, string>();
  const chunkIdToCandidates = new Map<string, ScoringCandidate[]>();

  chunks.forEach((chunkCandidates, idx) => {
    const { prompt, system } = buildScoreCallForChunk(
      chunkCandidates,
      factStatements,
      config.relevanceSystemPrompt,
    );
    const scoreId = `score:${idx}`;
    promptsById.set(scoreId, prompt);
    chunkIdToCandidates.set(scoreId, chunkCandidates);
    calls.push({
      id: scoreId,
      system,
      prompt,
      temperature: config.scoreTemperature,
      maxTokens: config.scoreBatchMaxTokens,
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
 * Pure — fact statements are supplied by the caller.
 */
export function buildReasonCallsForSubset(
  candidates: ScoringCandidate[],
  relevanceMap: Record<string, number>,
  subsetThreshold: number,
  factStatements: string[],
  config: ArticlePipelineConfig = ARTICLE_CFG,
  logger: HarnessLogger = NOOP_LOGGER,
): CloudCallBundle {
  const subset = candidates.filter((c) => {
    if (!isEligible(c)) return false;
    const rel = relevanceMap[c.id];
    return typeof rel === 'number' && rel > subsetThreshold;
  });

  const calls: BatchCall[] = [];
  const promptsById = new Map<string, string>();
  const fullUserContext = buildUserContext(factStatements);

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
      system: config.reasonSystemPrompt,
      prompt: reasonPrompt,
      temperature: config.reasonTemperature,
      maxTokens: config.reasonMaxTokens,
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

/**
 * Decode a raw BatchCompletionResult[] back into per-candidate score + reason
 * maps. Kept in one place so sync and async paths produce identical outputs.
 */
export function decodeCloudBatchResults(
  params: {
    batchResults: BatchCompletionResult[];
    promptsById: Map<string, string>;
    chunkIdToCandidates: Map<string, ScoringCandidate[]>;
  },
  config: ArticlePipelineConfig = ARTICLE_CFG,
  logger: HarnessLogger = NOOP_LOGGER,
): DecodedResults {
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
          scoreMap.set(c.id, config.fallbackRelevance);
          failedIds.add(c.id);
        });
        continue;
      }
      const scores = parseBatchRelevanceResponse(
        result.output,
        chunkCandidates.length,
        chunkCandidates[0]?.id ?? result.id,
        promptsById.get(result.id),
        config,
        logger,
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
            logger,
          ),
        );
      }
    }
  }

  return { scoreMap, reasonMap, failedIds };
}

// --- Response parsing ---

function clampRelevance(n: number): number {
  return Math.max(0, Math.min(1.1, n));
}

/**
 * Product-tier bands keyed by the stake tag the model outputs alongside each
 * score (`{"k":"family","s":0.72}`): FEED stakes 0.40–1.10, interest-only
 * 0.25–0.39, none 0.05–0.24. The decoder clamps a score into its declared
 * band, so a right classification with a drifted score still lands in the
 * right tier. Unknown tags fall back to plain 0–1.1 clamping.
 */
const STAKE_SCORE_BANDS: Record<string, [number, number]> = {
  home: [0.4, 1.1],
  family: [0.4, 1.1],
  travel: [0.4, 1.1],
  domain: [0.4, 1.1],
  attend: [0.4, 1.1],
  interest: [0.25, 0.39],
  none: [0.05, 0.24],
};

function clampToStakeBand(s: number, k: unknown): number {
  const band = typeof k === 'string' ? STAKE_SCORE_BANDS[k] : undefined;
  if (!band) return clampRelevance(s);
  return Math.max(band[0], Math.min(band[1], clampRelevance(s)));
}

/**
 * Parse a batched relevance response — a JSON array of N entries in input
 * order, where each entry is either a float in 0.0–1.1 (legacy format) or a
 * `{"k":"<stake>","s":<float>}` object (tiered format; `s` is clamped into
 * the band declared by `k`). Falls back to extracting any numbers via regex
 * if the output isn't valid JSON. Always returns exactly `expectedCount`
 * scores, padding with the fallback relevance if the LLM returned fewer.
 */
export function parseBatchRelevanceResponse(
  output: string,
  expectedCount: number,
  id: string,
  prompt?: string,
  config: ArticlePipelineConfig = ARTICLE_CFG,
  logger: HarnessLogger = NOOP_LOGGER,
): number[] {
  const trimmed = output.trim();

  // Primary path: JSON array of numbers.
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (Array.isArray(parsed)) {
      const numbers = parsed.map((v) => {
        if (typeof v === 'number') return clampRelevance(v);
        if (
          typeof v === 'object' &&
          v !== null &&
          typeof (v as { s?: unknown }).s === 'number'
        ) {
          return clampToStakeBand(
            (v as { s: number }).s,
            (v as { k?: unknown }).k,
          );
        }
        return NaN;
      });
      if (numbers.every((n) => !isNaN(n))) {
        if (numbers.length === expectedCount) return numbers;
        logger.warn(
          'Batch relevance: array length mismatch — padding with fallback',
          {
            expected: expectedCount,
            got: numbers.length,
            id,
          },
        );
        const padded = numbers.slice(0, expectedCount);
        while (padded.length < expectedCount)
          padded.push(config.fallbackRelevance);
        return padded;
      }
    }
    // Single-number JSON (legacy format) — only valid for single-article chunks.
    if (typeof parsed === 'number' && expectedCount === 1)
      return [clampRelevance(parsed)];
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
    logger.warn(
      'Batch relevance: regex fallback under-filled — padding with fallback',
      {
        expected: expectedCount,
        got: nums.length,
        id,
        prompt,
      },
    );
    const padded = [...nums];
    while (padded.length < expectedCount) padded.push(config.fallbackRelevance);
    return padded;
  }

  logger.warn('Batch relevance: failed to parse output — using fallback for all', {
    output: trimmed,
    expected: expectedCount,
    id,
    prompt,
  });
  return new Array<number>(expectedCount).fill(config.fallbackRelevance);
}

export function parseReasonResponse(
  output: string,
  id: string,
  prompt?: string,
  logger: HarnessLogger = NOOP_LOGGER,
): string {
  let text = output.trim();

  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === 'string' && parsed.length > 0) {
      text = parsed;
    } else if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'reason' in parsed
    ) {
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
