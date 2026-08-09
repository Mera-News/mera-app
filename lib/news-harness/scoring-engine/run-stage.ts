// scoring-engine — the single stage BOTH scoring orchestrators route through.
// Structural "no divergence" guarantee: scoring-service.ts (sync) and
// scoring-pipeline.ts (E2EE async) both call computeAndScore, so the hard
// screen, the math and the legacy scoring can never drift between them.
//
//   0. HARD "not interested" screen (persona.hardSuppressions) — matching
//      candidates are dropped here and returned in `excludedIds`; they never
//      reach the math, the LLM score or the reason pass.
//   1. computeRelevance() per candidate (on-device math) → computed score +
//      components + mode. The math score is the FALLBACK that stands if the LLM
//      call fails, and it is what carries the SOFT suppression penalty.
//   2. EVERY active candidate → the legacy tiered LLM score call, which applies
//      its score to rawScoreMap minus the soft suppression penalty the math
//      already computed for the same candidate — otherwise a "shown less" filter
//      would be silently inert. Reasons stay the orchestrator's job (this stage
//      returns only scores).
//
// THE JUDGE IS GONE. Step 2 used to be split: tagged ("math"-mode) candidates
// went to a combined judge+reason call and kept their math score, untagged
// ("backstop") ones took the legacy LLM path. With the judge deleted there is
// one path, so every candidate takes it — including tagged ones, which is what
// made it safe to delete the `USE_ARTICLE_TAGS` blanking afterwards (there is
// no longer a judge for a tagged row to be routed onto).
//
// `mode` survives as a DIAGNOSTIC, not as routing: it is persisted inside
// `score_components_json` and counted by `getScoringModeBreakdown` for the
// Observability feed funnel.
//
// Pure except for the injected LlmPort. RN-free.

import type { LlmPort, HarnessLogger } from '../core/ports';
import { NOOP_LOGGER } from '../core/ports';
import type { BatchCall, ScoringCandidate } from '../core/types';
import type { HarnessConfig } from '../core/config';
import {
  buildScoreCallForChunk,
  parseBatchRelevanceResponse,
  chunk,
} from '../article-pipeline/scoring';
import {
  applyEntityPenalty,
  computeRelevance,
  type ScoredCandidateInput,
  type RelevanceComponents,
  type ScoringMode,
} from './relevance';
import type { PersonaScoringContext } from './persona-context';
import { screenHardSuppressionsDetailed } from './suppression';

/** One candidate for the stage. `input` carries the rich metadata the math +
 *  math needs; `legacy` is the ScoringCandidate shape the tiered LLM prompt
 *  scores through (omit for math-only callers/eval). */
export interface StageCandidate {
  input: ScoredCandidateInput;
  legacy?: ScoringCandidate;
}

export interface StageResult {
  /** APPLIED raw score per id — the value to persist as relevance: the legacy
   *  LLM score, or the math score when its call failed (fail-open). */
  rawScoreMap: Map<string, number>;
  /** Deterministic math score per id (persist as computed_score). Kept separate
   *  from rawScoreMap: it is the fail-open value and the audit trail. */
  computedScoreMap: Map<string, number>;
  /** Full component breakdown per id (persist as score_components_json). */
  componentsMap: Map<string, RelevanceComponents>;
  /** Which path the ENGINE would have taken for each id. Diagnostic only since
   *  the judge was removed — nothing routes on it; it is persisted inside the
   *  components blob and counted by the Observability funnel. */
  modeMap: Map<string, ScoringMode>;
  /** ids a HARD "not interested" filter screened out (step 0). These get NO
   *  entry in any of the maps above — no math, no LLM score, no reason — and the
   *  orchestrator persists them as terminal `excluded` (relevance 0) rather than
   *  scoring them. */
  excludedIds: Set<string>;
  /** excluded id → the display value of the filter that matched it (for the
   *  per-batch log / the user-facing "why is this gone" surface). */
  excludedValueById: Map<string, string>;
  /** P6. Top-headline ids that MATCHED a hard filter and were kept anyway →
   *  the matching filter's display value. Unlike `excludedIds` these ARE scored
   *  (demoted, floored at HEADLINE_BASE_FLOOR) and DO appear in every map above;
   *  the value is what the card's "you filtered this" label names. */
  exemptedValueById: Map<string, string>;
}

export interface ComputeAndScoreOptions {
  /** Reference "now" (fixed in eval/replay for determinism). No longer affects
   *  the math since Round-3 A2 removed freshness decay. */
  nowMs?: number;
  /** Full fact-bank statements — used by the legacy score call. */
  factStatements?: string[];
  logger?: HarnessLogger;
  /** Skip the LLM round trip entirely and let every math score stand. Used by
   *  the deterministic math-only eval. (Was `skipJudge`; it now skips the only
   *  LLM call this stage makes.) */
  skipLlm?: boolean;
}

/**
 * Hard-screen, compute the math for every candidate, then score them all
 * through the legacy tiered LLM call. Returns merged per-id maps.
 */
export async function computeAndScore(
  candidates: StageCandidate[],
  persona: PersonaScoringContext,
  llm: LlmPort,
  config: HarnessConfig,
  opts: ComputeAndScoreOptions = {},
): Promise<StageResult> {
  const logger = opts.logger ?? NOOP_LOGGER;
  const nowMs = opts.nowMs ?? Date.now();
  const eng = config.scoringEngine;
  const pipe = config.articlePipeline;

  const rawScoreMap = new Map<string, number>();
  const computedScoreMap = new Map<string, number>();
  const componentsMap = new Map<string, RelevanceComponents>();
  const modeMap = new Map<string, ScoringMode>();

  // --- 0. HARD "not interested" screen ---------------------------------------
  // Runs BEFORE any math so an excluded row costs no compute, no judge tokens
  // and no reason call. Absent/empty hardSuppressions ⇒ nothing is screened,
  // i.e. exactly the pre-wave behaviour.
  //
  // P6: top-headline rows that MATCH a hard filter are NOT excluded — they stay
  // in `active` and computeRelevance demotes them (one shared predicate,
  // suppression.ts::isHardFilterExempt). Logged separately so the split is
  // visible in the field.
  //
  // THIS IS THE SCREEN THE WHOLE "not interested" FEATURE RUNS ON, and it is on
  // the legacy path — it did not go anywhere when the judge did.
  const { excluded: excludedValueById, exempted: exemptedValueById } =
    screenHardSuppressionsDetailed(
      candidates.map((c) => c.input),
      persona.hardSuppressions,
    );
  const excludedIds = new Set(excludedValueById.keys());
  const active =
    excludedIds.size > 0 ? candidates.filter((c) => !excludedIds.has(c.input.id)) : candidates;
  if (excludedIds.size > 0) {
    logger.debug('[computeAndScore] hard filters excluded candidates', {
      excluded: excludedIds.size,
      of: candidates.length,
      values: [...new Set(excludedValueById.values())].slice(0, 10),
    });
  }
  if (exemptedValueById.size > 0) {
    logger.debug('[computeAndScore] hard filters demoted (not removed) headlines', {
      exempted: exemptedValueById.size,
      of: candidates.length,
      values: [...new Set(exemptedValueById.values())].slice(0, 10),
    });
  }

  // --- 1. math for every active candidate ------------------------------------
  // No partition any more: with the judge gone there is nowhere else to send a
  // candidate, so `mode` is recorded for the Observability funnel and nothing
  // branches on it.
  for (const c of active) {
    const r = computeRelevance(c.input, persona, eng, nowMs);
    computedScoreMap.set(c.input.id, r.score);
    componentsMap.set(c.input.id, r.components);
    modeMap.set(c.input.id, r.mode);
    rawScoreMap.set(c.input.id, r.score); // fail-open default; the LLM overwrites
  }

  // --- 2. LEGACY tiered LLM score for EVERY active candidate -----------------
  // `c.legacy` is the ScoringCandidate the tiered prompt needs; math-only
  // callers (the offline eval) omit it and get the math score untouched, which
  // is also what `skipLlm` buys.
  const scorable = opts.skipLlm ? [] : active.filter((c) => c.legacy);
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
    let penalised = 0;
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
      // SOFT suppression. The LLM knows nothing about the
      // user's "shown less" filters, so its score REPLACES the math score that
      // carried the penalty — which left soft filters inert for every untagged
      // article (and, with enrichment unshipped, that is all of them). Re-apply
      // the SAME penalty the math already computed for this candidate
      // (components.suppressPenalty = Σ P_SUP·strength capped at P_SUP_CAP, via
      // the one kind-aware matcher in suppression.ts). No second matcher, no
      // second cap.
      //
      // Applied AT the overwrite site, not in a later sweep: a failed chunk
      // fail-opens to the math score above, which ALREADY has the penalty
      // subtracted — penalising that again would double-count.
      //
      // A candidate matching nothing takes the untouched `scores[i]` write, so
      // the no-filter path stays byte-identical to the pre-change behaviour.
      // Only the lower bound can bite: the parser already clamps to [0, 1.1] and
      // the penalty is non-negative, so the score can only fall.
      chunkItems.forEach((c, i) => {
        const comps = componentsMap.get(c.input.id);
        const penalty = comps?.suppressPenalty ?? 0;
        let next = scores[i];
        if (penalty > 0) {
          penalised += 1;
          next = Math.max(0, next - penalty);
        }
        // The ENTITY share is applied separately, against ENTITY_PENALTY_FLOOR
        // rather than subtracted outright: entity extraction is 68.8% correct,
        // so an entity filter may lower a row's rank but must never push it out
        // of the feed. Same helper `computeRelevance` uses on the fail-open
        // score, so the two paths cannot disagree about what "nudge, never
        // delete" means.
        const entityPenalty = comps?.entityPenalty ?? 0;
        if (entityPenalty > 0) {
          if (penalty <= 0) penalised += 1;
          next = applyEntityPenalty(next, entityPenalty, eng);
        }
        // P6 — DEMOTED, NEVER REMOVED. An exempt top headline carries a HARD
        // filter's penalty in `suppressPenalty` (folded in by computeRelevance),
        // and the LLM score it is subtracted from is not guaranteed to survive
        // it. Without this floor such a headline would vanish, which is
        // exclusion under another name.
        if (comps?.hardFilterExempt) {
          next = Math.max(next, eng.HEADLINE_BASE_FLOOR);
        }
        rawScoreMap.set(c.input.id, next);
      });
    });
    if (penalised > 0) {
      logger.debug('[computeAndScore] soft filters penalised candidates', {
        penalised,
        of: scorable.length,
      });
    }
  }

  return {
    rawScoreMap,
    computedScoreMap,
    componentsMap,
    modeMap,
    excludedIds,
    excludedValueById,
    exemptedValueById,
  };
}
