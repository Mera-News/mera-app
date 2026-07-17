// scoring-engine — pure judge cloud-call builders + decoder, extracted so the
// E2EE pipeline (scoring-pipeline.ts) can build the judge job at SUBMIT time and
// decode it at POLL time, sharing the EXACT judge framing computeAndJudge uses
// inline (buildJudgeUserMessage + summarizeComponents + parseJudgeResponse).
// This is the structural "no divergence" seam between the two orchestrators —
// both build and decode judge calls through these functions.
//
// Pure / RN-free.

import type { BatchCall, BatchCompletionResult } from '../core/types';
import type { HarnessConfig } from '../core/config';
import type { HarnessLogger } from '../core/ports';
import { NOOP_LOGGER } from '../core/ports';
import { buildJudgeUserMessage } from '../prompts/prompts';
import { resolveCountryName, chunk } from '../article-pipeline/scoring';
import type { ScoredCandidateInput, RelevanceComponents } from './relevance';
import type { PersonaScoringContext } from './persona-context';
import { summarizeComponents, parseJudgeResponse } from './judge';

export interface JudgeBundle {
  calls: BatchCall[];
  /** call id (`${idPrefix}:${idx}`) → ordered candidate ids in that chunk. */
  chunkIds: Map<string, string[]>;
}

/**
 * Build the combined judge+reason BatchCalls for math-mode candidates, chunked
 * at config.articlePipeline.judgeChunkSize. Identical framing to
 * computeAndJudge's inline judge calls.
 */
export function buildJudgeCalls(
  items: { input: ScoredCandidateInput }[],
  computedScoreMap: Map<string, number>,
  componentsMap: Map<string, RelevanceComponents>,
  persona: PersonaScoringContext,
  config: HarnessConfig,
  idPrefix = 'judge',
): JudgeBundle {
  const pipe = config.articlePipeline;
  const chunks = chunk(items, pipe.judgeChunkSize);
  const calls: BatchCall[] = [];
  const chunkIds = new Map<string, string[]>();
  chunks.forEach((chunkItems, idx) => {
    const id = `${idPrefix}:${idx}`;
    chunkIds.set(
      id,
      chunkItems.map((c) => c.input.id),
    );
    const prompt = buildJudgeUserMessage({
      articles: chunkItems.map((c) => ({
        title: c.input.titleEn ?? '',
        description: c.input.descriptionEn ?? '',
        country: resolveCountryName(c.input.countryCode),
        computedScore: computedScoreMap.get(c.input.id) ?? 0,
        componentSummary: summarizeComponents(
          componentsMap.get(c.input.id)!,
          c.input.matchedTopics,
          persona.locations,
        ),
      })),
    });
    calls.push({
      id,
      system: pipe.judgeSystemPrompt,
      prompt,
      temperature: pipe.scoreTemperature,
      maxTokens: pipe.judgeMaxTokens,
    });
  });
  return { calls, chunkIds };
}

export interface JudgeDecodeResult {
  /** Final raw score per id (judge decision; computed on fail-open). */
  rawScoreMap: Map<string, number>;
  reasonMap: Map<string, string>;
  overrideMap: Map<string, boolean>;
  adjustedIds: Set<string>;
}

/**
 * Decode judge BatchCompletionResults back into per-id maps. A missing/failed
 * chunk fails open — the persisted computed (math) score stands for that chunk.
 * Reasons are kept only for rows whose final score ≥ reasonRelevanceThreshold
 * (mirrors computeAndJudge).
 */
export function decodeJudgeResults(
  results: BatchCompletionResult[],
  chunkIds: Map<string, string[]>,
  computedScoreMap: Map<string, number>,
  config: HarnessConfig,
  logger: HarnessLogger = NOOP_LOGGER,
): JudgeDecodeResult {
  const eng = config.scoringEngine;
  const pipe = config.articlePipeline;
  const rawScoreMap = new Map<string, number>();
  const reasonMap = new Map<string, string>();
  const overrideMap = new Map<string, boolean>();
  const adjustedIds = new Set<string>();
  const resultById = new Map(results.map((r) => [r.id, r]));

  for (const [callId, ids] of chunkIds) {
    const computed = ids.map((id) => computedScoreMap.get(id) ?? 0);
    const result = resultById.get(callId);
    if (!result || result.error) {
      ids.forEach((id, i) => rawScoreMap.set(id, computed[i]));
      if (result?.error) {
        logger.warn('[decodeJudgeResults] judge chunk failed — math stands', {
          callId,
          error: result.error,
        });
      }
      continue;
    }
    const decisions = parseJudgeResponse(result.output, computed, eng, logger, callId);
    ids.forEach((id, i) => {
      const d = decisions[i];
      rawScoreMap.set(id, d.score);
      if (d.override) overrideMap.set(id, true);
      if (d.adjusted) adjustedIds.add(id);
      if (d.reason && d.score >= pipe.reasonRelevanceThreshold) {
        reasonMap.set(id, d.reason);
      }
    });
  }

  return { rawScoreMap, reasonMap, overrideMap, adjustedIds };
}
