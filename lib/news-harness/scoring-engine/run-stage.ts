// scoring-engine — the single stage BOTH scoring orchestrators route through
// (Wave 7b). Structural "no divergence" guarantee: scoring-service.ts (sync)
// and scoring-pipeline.ts (E2EE async) both call computeAndJudge, so the math +
// judge behaviour can never drift between them.
//
//   1. computeRelevance() per candidate (on-device math) → computed score +
//      components + mode ('math' | 'backstop').
//   2. MATH candidates → ONE combined judge+reason call per chunk
//      ({"j","s"?,"r"?}); the judge may fully override (fail-open to computed).
//   3. BACKSTOP candidates (never tagged) → the legacy tiered LLM score call,
//      unchanged. Reasons for backstop stay the orchestrator's job (this stage
//      returns only scores for them).
//
// Pure except for the injected LlmPort. RN-free.

import type { LlmPort, HarnessLogger } from '../core/ports';
import { NOOP_LOGGER } from '../core/ports';
import type { BatchCall, ScoringCandidate } from '../core/types';
import type { HarnessConfig } from '../core/config';
import { buildJudgeUserMessage } from '../prompts/prompts';
import {
  buildScoreCallForChunk,
  parseBatchRelevanceResponse,
  resolveCountryName,
  chunk,
} from '../article-pipeline/scoring';
import {
  computeRelevance,
  type ScoredCandidateInput,
  type RelevanceComponents,
  type ScoringMode,
} from './relevance';
import type { PersonaScoringContext } from './persona-context';
import { summarizeComponents, parseJudgeResponse } from './judge';

/** One candidate for the stage. `input` carries the rich metadata the math +
 *  judge need; `legacy` is the ScoringCandidate shape the backstop path scores
 *  through the untouched tiered LLM prompt (omit for math-only callers/eval). */
export interface StageCandidate {
  input: ScoredCandidateInput;
  legacy?: ScoringCandidate;
}

export interface StageResult {
  /** Final raw score per id (post-judge for math, LLM for backstop). */
  rawScoreMap: Map<string, number>;
  /** Pre-judge deterministic math score per id (persist as computed_score). */
  computedScoreMap: Map<string, number>;
  /** Full component breakdown per id (persist as score_components_json). */
  componentsMap: Map<string, RelevanceComponents>;
  modeMap: Map<string, ScoringMode>;
  /** Judge-authored reasons (math mode only; computed ≥ judgeReasonFloor). */
  reasonMap: Map<string, string>;
  /** ids the judge overrode by > OVERRIDE_DELTA (fed to the calibration loop). */
  overrideMap: Map<string, boolean>;
  /** ids the judge adjusted at all (any magnitude). */
  adjustedIds: Set<string>;
}

export interface ComputeAndJudgeOptions {
  /** Reference "now" for freshness (fixed in eval/replay for determinism). */
  nowMs?: number;
  /** Full fact-bank statements — only used by the backstop legacy score call. */
  factStatements?: string[];
  logger?: HarnessLogger;
  /** Skip the judge round trip and let every math score stand (fake-judge=ok).
   *  Used by the deterministic math-only eval. */
  skipJudge?: boolean;
}

/**
 * Compute the math score for every candidate, then judge the math-mode ones and
 * legacy-score the backstop ones. Returns merged per-id maps.
 */
export async function computeAndJudge(
  candidates: StageCandidate[],
  persona: PersonaScoringContext,
  llm: LlmPort,
  config: HarnessConfig,
  opts: ComputeAndJudgeOptions = {},
): Promise<StageResult> {
  const logger = opts.logger ?? NOOP_LOGGER;
  const nowMs = opts.nowMs ?? Date.now();
  const eng = config.scoringEngine;
  const pipe = config.articlePipeline;

  const rawScoreMap = new Map<string, number>();
  const computedScoreMap = new Map<string, number>();
  const componentsMap = new Map<string, RelevanceComponents>();
  const modeMap = new Map<string, ScoringMode>();
  const reasonMap = new Map<string, string>();
  const overrideMap = new Map<string, boolean>();
  const adjustedIds = new Set<string>();

  // --- 1. math for all; partition by mode -----------------------------------
  const mathItems: StageCandidate[] = [];
  const backstopItems: StageCandidate[] = [];
  for (const c of candidates) {
    const r = computeRelevance(c.input, persona, eng, nowMs);
    computedScoreMap.set(c.input.id, r.score);
    componentsMap.set(c.input.id, r.components);
    modeMap.set(c.input.id, r.mode);
    rawScoreMap.set(c.input.id, r.score); // default (judge/backstop overwrite)
    if (r.mode === 'math') mathItems.push(c);
    else backstopItems.push(c);
  }

  // --- 2. JUDGE the math-mode candidates ------------------------------------
  if (!opts.skipJudge && mathItems.length > 0) {
    const chunks = chunk(mathItems, pipe.judgeChunkSize);
    const calls: BatchCall[] = chunks.map((chunkItems, idx) => {
      const prompt = buildJudgeUserMessage({
        articles: chunkItems.map((c) => {
          const computed = computedScoreMap.get(c.input.id) ?? 0;
          const comps = componentsMap.get(c.input.id)!;
          return {
            title: c.input.titleEn ?? '',
            description: c.input.descriptionEn ?? '',
            country: resolveCountryName(c.input.countryCode),
            computedScore: computed,
            componentSummary: summarizeComponents(
              comps,
              c.input.matchedTopics,
              persona.locations,
              eng,
            ),
          };
        }),
      });
      return {
        id: `judge:${idx}`,
        system: pipe.judgeSystemPrompt,
        prompt,
        temperature: pipe.scoreTemperature,
        maxTokens: pipe.judgeMaxTokens,
      };
    });

    const results = await llm.batchComplete(calls, { model: pipe.model });
    const resultById = new Map(results.map((r) => [r.id, r]));

    chunks.forEach((chunkItems, idx) => {
      const result = resultById.get(`judge:${idx}`);
      const computed = chunkItems.map((c) => computedScoreMap.get(c.input.id) ?? 0);
      // Failed / missing chunk → fail-open: math scores stand for the chunk.
      if (!result || result.error) {
        if (result?.error) {
          logger.warn('[computeAndJudge] judge chunk failed — math stands', {
            chunkId: `judge:${idx}`,
            error: result.error,
            size: chunkItems.length,
          });
        }
        return;
      }
      const decisions = parseJudgeResponse(result.output, computed, eng, logger, `judge:${idx}`);
      chunkItems.forEach((c, i) => {
        const d = decisions[i];
        rawScoreMap.set(c.input.id, d.score);
        if (d.override) overrideMap.set(c.input.id, true);
        if (d.adjusted) adjustedIds.add(c.input.id);
        // Only keep a reason above the reason threshold (a judge demotion below
        // it discards the reason — matches the client-side gating in A3.2).
        if (d.reason && d.score >= pipe.reasonRelevanceThreshold) {
          reasonMap.set(c.input.id, d.reason);
        }
      });
    });
  }

  // --- 3. BACKSTOP: legacy tiered LLM score for never-tagged candidates ------
  const scorable = backstopItems.filter((c) => c.legacy);
  if (scorable.length > 0) {
    const facts = opts.factStatements ?? [];
    const chunks = chunk(scorable, pipe.articlesPerScorePrompt);
    const calls: BatchCall[] = chunks.map((chunkItems, idx) => {
      const { prompt, system } = buildScoreCallForChunk(
        chunkItems.map((c) => c.legacy!),
        facts,
        pipe.relevanceSystemPrompt,
      );
      return {
        id: `score:${idx}`,
        system,
        prompt,
        temperature: pipe.scoreTemperature,
        maxTokens: pipe.scoreBatchMaxTokens,
      };
    });
    const results = await llm.batchComplete(calls, { model: pipe.model });
    const resultById = new Map(results.map((r) => [r.id, r]));
    chunks.forEach((chunkItems, idx) => {
      const result = resultById.get(`score:${idx}`);
      if (!result || result.error) {
        // Fail-open: leave the math score (already in rawScoreMap).
        return;
      }
      const scores = parseBatchRelevanceResponse(
        result.output,
        chunkItems.length,
        `score:${idx}`,
        undefined,
        pipe,
        logger,
      );
      chunkItems.forEach((c, i) => rawScoreMap.set(c.input.id, scores[i]));
    });
  }

  return {
    rawScoreMap,
    computedScoreMap,
    componentsMap,
    modeMap,
    reasonMap,
    overrideMap,
    adjustedIds,
  };
}
