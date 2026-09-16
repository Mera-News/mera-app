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
  buildFeedVerifierUserMessage,
  buildReasonUserMessage,
  parseV3NoteResponse,
} from '../prompts/prompts';
import {
  DEFAULT_HARNESS_CONFIG,
  type ArticlePipelineConfig,
} from '../core/config';
import { NOOP_LOGGER, type HarnessLogger } from '../core/ports';
import {
  resolvePromptVariant,
  systemPromptForSlot,
  type PromptVariantId,
} from '../prompts/prompt-variants';
import type {
  BatchCall,
  BatchCompletionResult,
  CloudCallBundle,
  DecodedResults,
  ScoringCandidate,
  ScoringResult,
} from '../core/types';
import { injectArticleMetadata, selectTagGatedDemoteIds } from './tag-prompt';

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

/** Chunk size for the TOP-HEADLINE relevance variant. Smaller than
 *  CLOUD_SCORE_CHUNK_SIZE because the headline rubric is ~1.5× longer (see the
 *  derivation in core/config.ts). */
export const CLOUD_HEADLINE_SCORE_CHUNK_SIZE =
  ARTICLE_CFG.headlineArticlesPerScorePrompt;

/** Raw-score floor for phase-2 reason generation in the async reconciler. */
export const REASON_MIN_RAW_SCORE = 0;

// --- Prompt variant routing (P4b) ----------------------------------------
//
// A candidate reaches the scorer by one of two routes: it matched one of the
// user's topics (standard), or it was retrieved as a TOP HEADLINE for one of
// the user's scopes (headline). The two get different system prompts — the
// headline pair carries the indirect-impact rubric — and, because that rubric
// is longer, different relevance chunk sizes.
//
// The chunk-size difference is why the variant is a property of the WHOLE
// bundle rather than of each chunk: the async decoder rebuilds the
// `score:N` → candidates join by re-chunking a flat id list, so one bundle must
// use exactly ONE chunk size. `resolveScoringVariant` therefore returns
// 'headline' only when EVERY candidate is headline-sourced; a mixed set falls
// back to 'standard' (and the caller keeps the batch homogeneous upstream, so a
// mixed set should never occur in the first place).

export type ScoringVariant = 'standard' | 'headline';

/** True for the three top-headline scope labels the retrieval profile emits. */
export function isHeadlineScope(scope: string | null | undefined): boolean {
  return scope === 'CITY' || scope === 'COUNTRY' || scope === 'GLOBAL';
}

/** A candidate is headline-sourced when its stage metadata carries a scope. */
export function isHeadlineCandidate(c: ScoringCandidate): boolean {
  return isHeadlineScope(c.meta?.headlineScope);
}

/**
 * The variant a single relevance bundle must be built with. 'headline' ONLY
 * when every candidate is headline-sourced — a mixed or empty set is
 * 'standard', which is exactly the pre-P4b behaviour.
 */
export function resolveScoringVariant(
  candidates: ScoringCandidate[],
): ScoringVariant {
  if (candidates.length === 0) return 'standard';
  return candidates.every(isHeadlineCandidate) ? 'headline' : 'standard';
}

/**
 * The relevance system prompt for a bundle.
 *
 * TWO INDEPENDENT AXES, and they are easy to confuse because both were once
 * called "variant":
 *  - `variant` (`ScoringVariant`) is LIVE PRODUCTION ROUTING — standard vs
 *    headline, decided by where the candidates came from.
 *  - `promptVariant` (`PromptVariantId`) is the EXPERIMENT ARM — which text to
 *    send for whichever slot the routing picked. Omitted or 'baseline' ⇒ the
 *    shipped prompt, unchanged.
 * An arm may override the standard slot without touching the headline one, so
 * the two must not be collapsed.
 */
export function relevanceSystemPromptFor(
  config: ArticlePipelineConfig,
  variant: ScoringVariant,
  promptVariant?: PromptVariantId,
): string {
  const shipped =
    variant === 'headline'
      ? config.headlineRelevanceSystemPrompt
      : config.relevanceSystemPrompt;
  return systemPromptForSlot(
    variant === 'headline' ? 'headlineRelevance' : 'relevance',
    shipped,
    resolvePromptVariant(promptVariant),
  );
}

/** See {@link relevanceSystemPromptFor} for the two-axis note. */
export function reasonSystemPromptFor(
  config: ArticlePipelineConfig,
  variant: ScoringVariant,
  promptVariant?: PromptVariantId,
): string {
  const shipped =
    variant === 'headline'
      ? config.headlineReasonSystemPrompt
      : config.reasonSystemPrompt;
  return systemPromptForSlot(
    variant === 'headline' ? 'headlineReason' : 'reason',
    shipped,
    resolvePromptVariant(promptVariant),
  );
}

export function scoreChunkSizeFor(
  config: ArticlePipelineConfig,
  variant: ScoringVariant,
): number {
  return variant === 'headline'
    ? config.headlineArticlesPerScorePrompt
    : config.articlesPerScorePrompt;
}

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

/**
 * ADMISSION predicate — "may this row enter scoring at all?" — as opposed to
 * {@link isEligible}, which additionally demands a linked fact.
 *
 * The two differ on exactly one population: TOP-HEADLINE rows. A headline is
 * injected with a SYNTHETIC matched topic carrying `topicId: null`
 * (feed-sync-steps `pushMatched`), and the fact-link step skips those
 * (`if (!m.topicId) continue`), so a PURE headline — one that matched no real
 * persona topic — has zero rows in `article_suggestion_facts` BY DESIGN. That
 * is not the same condition as a genuinely orphaned row, and it must not be
 * treated as one: `relatedFacts.length === 0` was tombstoning every pure
 * headline (relevance 0, status `complete`) before any scoring existed, which
 * is why the feature never delivered a single headline card.
 *
 * Title + description are still REQUIRED here — a row with no text cannot be
 * scored by any prompt, headline or not. Only the fact requirement is lifted.
 *
 * WHERE THIS IS USED (deliberately narrow — see the blast radius below):
 *   - the feed-sync ineligibility tombstone + its eligible-id collection,
 *   - `enqueueUnscoredEligible` (the post-finalize / quiet-feed enqueue),
 *   - the four relevance/reason BUNDLE BUILDERS (this module and the
 *     mera-protocol shim).
 *
 * WHERE IT IS NOT: `batchScoreAndReason` and `buildFeedVerifierCalls` keep
 * `isEligible`. Relaxing the shared predicate there would flip factless rows
 * off `INELIGIBLE_RELEVANCE` on the sync/on-device path as a side effect. The
 * consequence is that the inline path still scores a pure headline 0.2 — below
 * every gate, so it fails CLOSED — while the E2EE path (what production runs)
 * scores it for real.
 */
export function isScorableCandidate(c: ScoringCandidate): boolean {
  if (isEligible(c)) return true;
  return isHeadlineCandidate(c) && Boolean(c.titleEn && c.descriptionEn);
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
 *
 * This is the ONLY scoring path now, so this always runs. (The v3 scorer skipped
 * it — it persisted a continuous blended score, and collapsing that onto four
 * representative values was the compression v3 existed to remove. v3 is retired;
 * v4 is this path, and its scores are quantised to these four values again.
 * That is exactly why the render gate is 0.4 and not v3's 0.55 — see
 * `stores/fact-rows-selector::effectiveRenderGate`.)
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
  /** ADD 1 seam. Only `legacyTagPromptEnabled` is read; with it false (the
   *  shipped default) the returned prompt is the SAME string this function has
   *  always produced, and `injectArticleMetadata` is never called. */
  config: ArticlePipelineConfig = ARTICLE_CFG,
  /** Experiment arm. Omitted or 'baseline' ⇒ byte-identical output. */
  promptVariant?: PromptVariantId,
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
    promptVariant,
  });
  // The tag block is appended to the BUILT message rather than threaded through
  // `buildBatchScoringUserMessage`, so the pinned prompt builder is untouched
  // and the flag-off path is provably byte-identical. See tag-prompt.ts.
  return {
    prompt: config.legacyTagPromptEnabled
      ? injectArticleMetadata(prompt, chunkCandidates)
      : prompt,
    system: systemPrompt,
  };
}

/**
 * Phase-1 of the two-phase async flow: score-only calls, no reason prompts.
 * Each chunk produces one BatchCall with id `score:N`. Pure — fact statements
 * are supplied by the caller (previously loaded from WatermelonDB inside).
 *
 * The system prompt AND the chunk size both come from the resolved variant
 * (P4b): TOP-HEADLINE candidates get the indirect-impact prompt at
 * `headlineArticlesPerScorePrompt`, everything else the standard pair. Pass
 * `variant` to force one; omit it and it is derived from the candidates, which
 * yields 'headline' only for an all-headline set. The size actually used is
 * returned as `scoreChunkSize` so an async caller persists the real value
 * rather than re-deriving it at decode time.
 */
export function buildRelevanceCalls(
  candidates: ScoringCandidate[],
  factStatements: string[],
  config: ArticlePipelineConfig = ARTICLE_CFG,
  logger: HarnessLogger = NOOP_LOGGER,
  variant?: ScoringVariant,
): CloudCallBundle {
  // isScorableCandidate, not isEligible: a pure TOP-HEADLINE row is factless by
  // design and would otherwise be silently dropped from the bundle here even
  // after surviving the feed-sync tombstone.
  const eligible = candidates.filter(isScorableCandidate);
  const resolved = variant ?? resolveScoringVariant(eligible);
  const scoreChunkSize = scoreChunkSizeFor(config, resolved);
  const systemPrompt = relevanceSystemPromptFor(config, resolved);
  const chunks = chunk(eligible, scoreChunkSize);

  const calls: BatchCall[] = [];
  const promptsById = new Map<string, string>();
  const chunkIdToCandidates = new Map<string, ScoringCandidate[]>();

  chunks.forEach((chunkCandidates, idx) => {
    const { prompt, system } = buildScoreCallForChunk(
      chunkCandidates,
      factStatements,
      systemPrompt,
      config,
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
    scoreChunkSize,
  };
}

/**
 * Phase-2 of the two-phase async flow: reason-only calls for the subset of
 * candidates whose relevance (computed in phase-1) exceeds `subsetThreshold`.
 * Pure — fact statements are supplied by the caller.
 *
 * One call per candidate (`reason:<id>`), so unlike the relevance pass there is
 * no chunking to keep uniform — the headline reason prompt is selected
 * PER CANDIDATE, and a mixed subset is fine.
 */
export function buildReasonCallsForSubset(
  candidates: ScoringCandidate[],
  relevanceMap: Record<string, number>,
  subsetThreshold: number,
  factStatements: string[],
  config: ArticlePipelineConfig = ARTICLE_CFG,
  logger: HarnessLogger = NOOP_LOGGER,
  /**
   * v3 routes this pass to `v3NoteSystemPrompt`, which does one extra job the
   * legacy prompt cannot: it may DEMOTE. v3 absorbed the standalone verifier
   * pass when it merged scoring and prose into one call and then lost its
   * demote rules with it; this is where they come back. The USER MESSAGE is
   * identical either way — `buildReasonUserMessage` already carries the
   * article, its score and the retrieval facts, which is exactly what a
   * precision judgement needs too.
   *
   * Defaults false, so every existing caller keeps the legacy behaviour.
   */
  v3 = false,
  /** Experiment arm. Omitted or 'baseline' ⇒ byte-identical output. */
  promptVariant?: PromptVariantId,
): CloudCallBundle {
  const eligible = candidates.filter((c) => {
    // isScorableCandidate: without it a factless headline that SCORED well gets
    // no reason call, stays `reason_pending`, and isVisible keeps it invisible
    // anyway — the fix upstream would buy nothing.
    if (!isScorableCandidate(c)) return false;
    const rel = relevanceMap[c.id];
    // INCLUSIVE: the render gate is `>= 0.4`, so a row at exactly the
    // threshold renders and must stay reason-eligible (rescue-floor rows and
    // the legacy LOW bucket both land at exactly 0.4).
    return typeof rel === 'number' && rel >= subsetThreshold;
  });

  // ADD 2. Applied AFTER the relevance gate, deliberately: the gate's measured
  // saving is a percentage of the rows that would otherwise have been CALLED,
  // and it must never resurrect a row the threshold already excluded.
  //
  // The demote is the caller's job — see `selectTagGatedDemoteIds`. Skipping the
  // call without persisting `feedVerifierDemoteScore` for these ids leaves them
  // rendering with no note, which is the one outcome this feature must not have.
  const gatedDemoteIds = selectTagGatedDemoteIds(eligible, config);
  const gatedSet = new Set(gatedDemoteIds);
  const subset = gatedSet.size === 0 ? eligible : eligible.filter((c) => !gatedSet.has(c.id));

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
      promptVariant,
    });
    const reasonId = `reason:${c.id}`;
    promptsById.set(reasonId, reasonPrompt);
    calls.push({
      id: reasonId,
      // The v3 note prompt is deliberately NOT split by headline/standard: it
      // judges ONE article against the user's facts, and the headline/standard
      // distinction exists to change how an article is RETRIEVED and SCORED,
      // which pass 1 has already settled by the time we get here.
      system: v3
        ? config.v3NoteSystemPrompt
        : reasonSystemPromptFor(
            config,
            isHeadlineCandidate(c) ? 'headline' : 'standard',
            promptVariant,
          ),
      prompt: reasonPrompt,
      temperature: config.reasonTemperature,
      maxTokens: v3 ? config.v3NoteMaxTokens : config.reasonMaxTokens,
    });
  }

  return {
    calls,
    promptsById,
    // Phase-2 has no score chunks — this map stays empty but keeps the
    // CloudCallBundle shape consistent so the decoder can dispatch by prefix.
    chunkIdToCandidates: new Map(),
    eligibleCandidates: subset,
    tagGatedDemoteIds: gatedDemoteIds,
  };
}

// --- Second-pass FEED verifier -------------------------------------------
//
// A precision pass over ONLY the first-pass FEED candidates (raw ≥ discardFloor).
// It answers a terse per-article yes/no ("does this materially affect THIS
// user?"); "no" articles are demoted to config.feedVerifierDemoteScore so they
// drop out of FEED (and, being < reasonRelevanceThreshold, out of reason
// generation). Validated 2026-07-16 — see CLOUD_FEED_VERIFIER_SYSTEM_PROMPT.
//
// buildFeedVerifierCalls mirrors buildRelevanceCalls (same fact + article-block
// framing) but ids its calls `verify:N` and uses the verifier system prompt.
// The port call + demotion live in the pipeline (llm.batchComplete) / the app
// shim (cloudBatchComplete); parseFeedVerifierResponse + applyFeedVerifierDecisions
// are the shared pure decode.

/** A yes/no keep/demote decision, one per verified article. */
export type FeedVerifierLabel = 'yes' | 'no';

/**
 * Build the verifier BatchCalls from the pre-selected FEED candidates (the
 * caller filters to raw ≥ discardFloor). Chunks by config.feedVerifierBatchSize,
 * ids each call `verify:N`, and returns the id→candidates lookup the applier
 * needs to map decisions back to candidate ids. Pure — facts supplied by caller.
 */
export function buildFeedVerifierCalls(
  feedCandidates: ScoringCandidate[],
  factStatements: string[],
  config: ArticlePipelineConfig = ARTICLE_CFG,
  _logger: HarnessLogger = NOOP_LOGGER,
): { calls: BatchCall[]; verifyIdToCandidates: Map<string, ScoringCandidate[]> } {
  const eligible = feedCandidates.filter(isEligible);
  const chunks = chunk(eligible, config.feedVerifierBatchSize);
  const calls: BatchCall[] = [];
  const verifyIdToCandidates = new Map<string, ScoringCandidate[]>();
  const userContext = buildUserContext(factStatements);

  chunks.forEach((chunkCandidates, idx) => {
    const prompt = buildFeedVerifierUserMessage({
      userContext,
      articles: chunkCandidates.map((c) => ({
        title: c.titleEn ?? '',
        description: c.descriptionEn ?? '',
        country: resolveCountryName(c.countryCode),
        relatedFacts: c.relatedFacts.map((f) => f.statement),
      })),
    });
    const verifyId = `verify:${idx}`;
    verifyIdToCandidates.set(verifyId, chunkCandidates);
    calls.push({
      id: verifyId,
      system: config.feedVerifierSystemPrompt,
      prompt,
      temperature: config.scoreTemperature,
      maxTokens: config.feedVerifierMaxTokens,
    });
  });

  return { calls, verifyIdToCandidates };
}

/**
 * Parse a verifier batch response — a JSON array of N `{"v":"yes"|"no"}` objects
 * (bare "yes"/"no" strings also accepted). Returns exactly `expectedCount`
 * labels. CONSERVATIVE by contract: on parse failure, length mismatch, or any
 * non-"no" token, the article is KEPT ("yes") — the verifier only ever demotes
 * on an explicit, well-formed "no". (This is the failure mode the experiment
 * measured at ~1–2 of 14 batches, handled as a keep.)
 */
export function parseFeedVerifierResponse(
  output: string,
  expectedCount: number,
  logger: HarnessLogger = NOOP_LOGGER,
  id?: string,
): FeedVerifierLabel[] {
  const keepAll = (): FeedVerifierLabel[] =>
    new Array<FeedVerifierLabel>(expectedCount).fill('yes');

  const trimmed = output.trim();
  const jsonMatch = trimmed.match(/\[[\s\S]*\]/);
  if (jsonMatch) {
    try {
      const parsed: unknown = JSON.parse(jsonMatch[0]);
      if (Array.isArray(parsed)) {
        const labels: FeedVerifierLabel[] = parsed.map((v) => {
          let s = '';
          if (typeof v === 'string') s = v;
          else if (v && typeof v === 'object') {
            const o = v as Record<string, unknown>;
            s = String(o.v ?? o.a ?? o.decision ?? o.label ?? o.keep ?? '');
          }
          // Only an explicit "no" demotes; everything else keeps (conservative).
          return s.toLowerCase().trim() === 'no' ? 'no' : 'yes';
        });
        if (labels.length === expectedCount) return labels;
        logger.warn(
          'Feed verifier: array length mismatch — conservative keep for batch',
          { expected: expectedCount, got: labels.length, id },
        );
        return keepAll();
      }
    } catch {
      // fall through
    }
  }

  logger.warn('Feed verifier: failed to parse output — conservative keep', {
    output: trimmed.slice(0, 200),
    expected: expectedCount,
    id,
  });
  return keepAll();
}

/**
 * Apply verifier decisions to a raw score map IN PLACE: for each `verify:N`
 * result, parse its labels and set every "no" article to
 * config.feedVerifierDemoteScore (only when its current raw score is above that,
 * so nothing is ever raised). A per-chunk error → conservative keep for that
 * chunk. Returns the number of articles demoted. Pure — the LLM call is the
 * caller's responsibility.
 */
export function applyFeedVerifierDecisions(
  scoreMap: Map<string, number>,
  verifyIdToCandidates: Map<string, ScoringCandidate[]>,
  batchResults: BatchCompletionResult[],
  config: ArticlePipelineConfig = ARTICLE_CFG,
  logger: HarnessLogger = NOOP_LOGGER,
): number {
  let demoted = 0;
  for (const result of batchResults) {
    if (!result.id.startsWith('verify:')) continue;
    const chunkCandidates = verifyIdToCandidates.get(result.id) ?? [];
    if (result.error) {
      logger.warn('[applyFeedVerifierDecisions] verify chunk failed — keeping', {
        chunkId: result.id,
        error: result.error,
        chunkSize: chunkCandidates.length,
      });
      continue; // conservative: keep every article in a failed chunk
    }
    const labels = parseFeedVerifierResponse(
      result.output,
      chunkCandidates.length,
      logger,
      result.id,
    );
    chunkCandidates.forEach((c, i) => {
      if (labels[i] !== 'no') return;
      const cur = scoreMap.get(c.id);
      if (typeof cur === 'number' && cur > config.feedVerifierDemoteScore) {
        scoreMap.set(c.id, config.feedVerifierDemoteScore);
        demoted += 1;
      }
    });
  }
  return demoted;
}

// --- v3 NOTE pass — shared decode ----------------------------------------
//
// Pulled out of `scoring-pipeline::applyV3NoteResults` so the decision logic has
// exactly ONE implementation. That function still owns the DB writes (which
// cannot run outside the app), but it no longer owns the RULES — which is what
// makes the offline goldset replay a measurement of the SHIPPED behaviour rather
// than of a look-alike written beside it. Same argument, and the same shape, as
// `parseFeedVerifierResponse` / `applyFeedVerifierDecisions` above.

/** What the note pass decided for one article. */
export interface V3NoteDecisions {
  /** Ids the model explicitly demoted (`{"keep": false}`). The caller writes
   *  `feedVerifierDemoteScore` + a terminal reason-skipped state. */
  demoteIds: string[];
  /** id → the sentence to persist, for kept rows that produced one. */
  reasons: Map<string, string>;
  /** Results that could not be read as a verdict at all (error, or output the
   *  note parser rejected). FAIL OPEN — the caller leaves the pass-1 score and
   *  `reason_pending` so the orphan sweep retries. An unreadable answer is not
   *  evidence that an article deserves demoting. */
  unusableIds: string[];
}

/**
 * Decode a batch of per-article `reason:<id>` note results into keep/demote
 * decisions. Pure: no DB, no LLM, no clock.
 *
 * FAIL OPEN in both directions, matching the shipped contract:
 *   - an errored or unparseable result is `unusable`, never a demote;
 *   - a KEEP with no sentence is neither demoted nor captioned — the row stays
 *     scored and still owed a note, rather than stamped terminal with nothing to
 *     show.
 * Only an explicit `{"keep": false}` demotes.
 */
export function decodeV3NoteResults(
  batchResults: { id: string; output: string; error?: string }[],
): V3NoteDecisions {
  const demoteIds: string[] = [];
  const reasons = new Map<string, string>();
  const unusableIds: string[] = [];

  for (const res of batchResults) {
    if (!res.id.startsWith('reason:')) continue;
    const id = res.id.slice('reason:'.length);
    if (res.error) {
      unusableIds.push(id);
      continue;
    }
    const verdict = parseV3NoteResponse(res.output ?? '');
    if (!verdict) {
      unusableIds.push(id);
      continue;
    }
    if (!verdict.keep) demoteIds.push(id);
    else if (verdict.why) reasons.set(id, verdict.why);
  }

  return { demoteIds, reasons, unusableIds };
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

/**
 * Optional counters a CALLER may pass into {@link parseBatchRelevanceResponse}
 * to learn how well the model held its own output contract on this batch.
 *
 * WHY THIS EXISTS. The relevance prompt tells the model that `s` "MUST lie
 * inside the band of the `k` you chose. If your score wants to leave the band,
 * your `k` is wrong." The decoder has always enforced that by CLAMPING — so a
 * self-contradicting answer is silently corrected and the product is fine, but
 * the fact that the model contradicted itself is thrown away. That fact is a
 * direct, free measure of instruction-following: it needs no rater, no labels
 * and no extra call, and it is available on every batch the scorer has ever
 * run. `bandViolations` over `tieredEntries` is the metric; `bandViolationMass`
 * carries the SIZE of the disagreement, because one answer off by 0.01 and one
 * off by 0.6 are not the same finding.
 *
 * NOT INSTRUMENTATION. These count properties of MODEL OUTPUT within a single
 * decode call. Nothing here observes, derives from, or is keyed to a reader —
 * there is no row written, no counter persisted and no id of any kind. The
 * accumulator is created by the caller, lives as long as the caller's run, and
 * production passes none: omit the argument and this module behaves exactly as
 * it did before, which is why every existing call site is untouched.
 */
export interface RelevanceDecodeStats {
  /** Entries decoded from a well-formed JSON array, tiered or legacy. */
  entries: number;
  /** Entries that arrived as `{"k","s"}` — the only ones with a band to hold. */
  tieredEntries: number;
  /** Entries that arrived as a bare number (legacy shape, no `k`). */
  legacyNumberEntries: number;
  /** Tiered entries whose `k` is not in {@link STAKE_SCORE_BANDS}. These skip
   *  band clamping entirely and fall back to a plain 0–1.1 clamp, so they are
   *  worth separating from a violation: the contract was not broken, it was
   *  not engaged. */
  unknownStakeTags: number;
  /** Tiered entries whose `s` fell outside the band its own `k` declares. */
  bandViolations: number;
  /** Total absolute distance the violations were moved by the clamp. Divide by
   *  `bandViolations` for the mean severity. */
  bandViolationMass: number;
  /** The batch did not come back as a parseable JSON array at all and the
   *  regex fallback ran. */
  regexFallbacks: number;
  /** The array parsed but did not hold `expectedCount` entries. */
  lengthMismatches: number;
  /** Nothing parseable at all — every article in the batch took
   *  `fallbackRelevance`. */
  totalFailures: number;
}

/** A zeroed accumulator. Callers that want stats create one and pass it in. */
export function newRelevanceDecodeStats(): RelevanceDecodeStats {
  return {
    entries: 0,
    tieredEntries: 0,
    legacyNumberEntries: 0,
    unknownStakeTags: 0,
    bandViolations: 0,
    bandViolationMass: 0,
    regexFallbacks: 0,
    lengthMismatches: 0,
    totalFailures: 0,
  };
}

function clampToStakeBand(
  s: number,
  k: unknown,
  stats?: RelevanceDecodeStats,
): number {
  const band = typeof k === 'string' ? STAKE_SCORE_BANDS[k] : undefined;
  if (!band) {
    if (stats) stats.unknownStakeTags++;
    return clampRelevance(s);
  }
  const clamped = Math.max(band[0], Math.min(band[1], clampRelevance(s)));
  if (stats) {
    // Measure the violation against the RAW value, not the 0–1.1 clamp, so a
    // wild `s` of 7.0 under `"k":"none"` reports its real distance instead of
    // the distance left after another clamp already hid most of it.
    const distance = s < band[0] ? band[0] - s : s > band[1] ? s - band[1] : 0;
    if (distance > 0) {
      stats.bandViolations++;
      stats.bandViolationMass += distance;
    }
  }
  return clamped;
}

/**
 * The last complete, balanced top-level JSON array in `text`, or null.
 *
 * WHY THE LAST AND NOT THE FIRST. A thinking model writes a draft array while
 * reasoning and its real answer at the end. z-ai/glm-5.3-flash does exactly
 * that: the captured fixture in `__tests__/fixtures/glm-leaked-scoring.json`
 * holds the array twice, once inside the trace and once after `</think>`.
 * Taking the first reads the draft; taking the last reads the conclusion.
 *
 * Tracks string state so a bracket inside a JSON string cannot unbalance the
 * scan, and only counts TOP-LEVEL arrays so a nested one is never returned on
 * its own.
 */
function extractLastJsonArray(text: string): string | null {
  let depth = 0;
  let start = -1;
  let last: string | null = null;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '[') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === ']') {
      if (depth > 0) {
        depth--;
        if (depth === 0 && start !== -1) last = text.slice(start, i + 1);
      }
    }
  }
  return last;
}

/**
 * True when `text` carries prose, i.e. anything a model might be THINKING in
 * rather than answering with.
 *
 * This is the gate on the regex fallback. That fallback used to take the first
 * numbers found anywhere, which on a leaked reasoning trace meant scraping
 * "Article 0", "I'll go 0.60-0.63" and "Let's say 0.62" and returning them as
 * scores — a measured, silent wrong answer that included a 1.00 EMERGENCY-tier
 * score invented from the model's scratch work.
 *
 * A letter is the test because a legitimate bare list ("0.61, 0.22") has none
 * and every trace has many. Deliberately strict: a chatty-but-correct
 * "here you go: 0.61, 0.22" is now a clean failure too. That trade is
 * one-sided — a chatty model that still answers is rare and costs one batch a
 * fallback score, while a thinking model's trace is routine and cost us
 * invented scores that nothing recorded as a failure.
 */
function looksLikeProse(text: string): boolean {
  return /[A-Za-z]/.test(text);
}

/**
 * Parse a batched relevance response — a JSON array of N entries in input
 * order, where each entry is either a float in 0.0–1.1 (legacy format) or a
 * `{"k":"<stake>","s":<float>}` object (tiered format; `s` is clamped into
 * the band declared by `k`). Falls back to extracting any numbers via regex
 * if the output isn't valid JSON. Always returns exactly `expectedCount`
 * scores, padding with the fallback relevance if the LLM returned fewer.
 *
 * `stats` is optional and write-only: pass a {@link newRelevanceDecodeStats}
 * accumulator to learn how well the model held its output contract (see
 * {@link RelevanceDecodeStats}). Omit it — as every production call site does —
 * and the returned scores and every log line are byte-for-byte what they were
 * before the parameter existed.
 */
export function parseBatchRelevanceResponse(
  output: string,
  expectedCount: number,
  id: string,
  prompt?: string,
  config: ArticlePipelineConfig = ARTICLE_CFG,
  logger: HarnessLogger = NOOP_LOGGER,
  stats?: RelevanceDecodeStats,
): number[] {
  const trimmed = output.trim();

  // Primary path: JSON array of numbers.
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (Array.isArray(parsed)) {
      const numbers = parsed.map((v) => {
        if (typeof v === 'number') {
          if (stats) {
            stats.entries++;
            stats.legacyNumberEntries++;
          }
          return clampRelevance(v);
        }
        if (
          typeof v === 'object' &&
          v !== null &&
          typeof (v as { s?: unknown }).s === 'number'
        ) {
          if (stats) {
            stats.entries++;
            stats.tieredEntries++;
          }
          return clampToStakeBand(
            (v as { s: number }).s,
            (v as { k?: unknown }).k,
            stats,
          );
        }
        return NaN;
      });
      if (numbers.every((n) => !isNaN(n))) {
        if (numbers.length === expectedCount) return numbers;
        if (stats) stats.lengthMismatches++;
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

  // Second chance: the LAST balanced top-level array in the text. A thinking
  // model prefixes its answer with a trace (and may draft the array inside it),
  // so the array we want is the final one, not the first thing that parses.
  const lastArray = extractLastJsonArray(trimmed);
  if (lastArray) {
    try {
      const parsed: unknown = JSON.parse(lastArray);
      if (Array.isArray(parsed)) {
        const numbers = parsed.map((v) => {
          if (typeof v === 'number') {
            if (stats) {
              stats.entries++;
              stats.legacyNumberEntries++;
            }
            return clampRelevance(v);
          }
          if (
            typeof v === 'object' &&
            v !== null &&
            typeof (v as { s?: unknown }).s === 'number'
          ) {
            if (stats) {
              stats.entries++;
              stats.tieredEntries++;
            }
            return clampToStakeBand(
              (v as { s: number }).s,
              (v as { k?: unknown }).k,
              stats,
            );
          }
          return NaN;
        });
        if (numbers.every((n) => !isNaN(n))) {
          if (numbers.length === expectedCount) return numbers;
          if (stats) stats.lengthMismatches++;
          logger.warn(
            'Batch relevance: recovered array length mismatch — padding with fallback',
            { expected: expectedCount, got: numbers.length, id },
          );
          const padded = numbers.slice(0, expectedCount);
          while (padded.length < expectedCount)
            padded.push(config.fallbackRelevance);
          return padded;
        }
      }
    } catch {
      // fall through to the prose gate
    }
  }

  // Regex fallback, now gated on the text carrying NO prose. See
  // `looksLikeProse`: scraping numbers out of a reasoning trace produced
  // confident, wrong, unrecorded scores, which is worse than no answer.
  if (!looksLikeProse(trimmed)) {
    if (stats) stats.regexFallbacks++;
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
  }

  if (stats) stats.totalFailures++;
  logger.warn('Batch relevance: failed to parse output — using fallback for all', {
    output: trimmed,
    expected: expectedCount,
    id,
    prompt,
  });
  return new Array<number>(expectedCount).fill(config.fallbackRelevance);
}

/**
 * Dash characters that get used as clause punctuation: em dash, en dash and
 * horizontal bar. Hyphen-minus is deliberately NOT here — it is a real word
 * joiner ("on-device", "AI-industry") and replacing it would corrupt prose.
 */
const CLAUSE_DASHES = /(\s*)([\u2014\u2013\u2015])(\s*)/g;

/** Hard cap on a stored reason, applied at a word boundary. */
const REASON_MAX_CHARS = 200;

/**
 * Replace a dash used as clause punctuation with a comma, leaving real ranges
 * alone.
 *
 * WHY THE DECODER AND NOT JUST THE PROMPT. The reason is the only LLM-generated
 * user-facing string in the feed, and house style has no em dashes. A prompt
 * rule is advice the model can ignore; this is deterministic. It also covers
 * the ON-DEVICE path for free, which a cloud prompt rule cannot: the local
 * reason prompt carries its own copy of the voice rule rather than sharing the
 * cloud constant, so only shared post-processing reaches both.
 *
 * THREE CASES THAT ARE NOT CLAUSE PUNCTUATION, each one a real output:
 *  - Between digits it is a RANGE ("2014–2016", "10–15%"). Left exactly as it
 *    was, whitespace included.
 *  - Leading or trailing, there is no second clause to join, so a comma would
 *    be worse than nothing. Dropped.
 *  - A hyphen is not in the class at all, so hyphenated words are untouched.
 *
 * Never concatenates: "a—b" becomes "a, b", never "ab".
 */
function replaceClauseDashes(text: string): string {
  return text.replace(
    CLAUSE_DASHES,
    (match: string, _pre: string, _dash: string, _post: string, offset: number, whole: string) => {
      const before = whole.slice(0, offset);
      const after = whole.slice(offset + match.length);
      if (/\d$/.test(before) && /^\d/.test(after)) return match;
      if (before.trim().length === 0) return '';
      if (after.trim().length === 0) return '';
      return ', ';
    },
  );
}

/**
 * Cut to `max` characters at a word boundary.
 *
 * The prompt asks for 25 words or fewer, so reaching the cap already means
 * something went wrong upstream. The old `slice(0, max)` then made it visibly
 * broken by cutting mid-word. No ellipsis: a trailing "…" dresses a failure up
 * as an intentional summary. A single token longer than the cap has no boundary
 * to cut at, so it is hard-cut rather than emptied.
 */
function cutAtWordBoundary(text: string, max: number): string {
  if (text.length <= max) return text;
  const slice = text.slice(0, max);
  const lastSpace = slice.lastIndexOf(' ');
  return (lastSpace > 0 ? slice.slice(0, lastSpace) : slice).trimEnd();
}

/**
 * Openers that mean the model is DELIBERATING rather than answering.
 *
 * A backstop, not the main defence — the structural checks in
 * {@link parseReasonResponse} (a `</think>` closer, an unclosed `<think>`) carry
 * the weight. This catches the case a thinking model produces with no tags at
 * all, which is what z-ai/glm-5.3-flash does at the shipped 64-token reason
 * budget: it returns "Let me analyze this article..." cut mid-word, and the old
 * decoder handed that to the reader as the card's "why this matters to you".
 *
 * Deliberately narrow, anchored, and case-sensitive on the first letter,
 * because real reasons start with capitals and some start with these letters:
 * "Indian rail strike...", "Letting agents in Amsterdam...", "First-time buyer
 * rules...". Each alternative therefore requires what FOLLOWS the word, not
 * just the word.
 */
const DELIBERATION_OPENER =
  /^(?:Let(?: me| us|'s) |First,? I |I(?:'ll| will| need to| am going to| should) |Okay,? |OK,? |Alright,? |Looking at (?:this|the) (?:article|user))/;

export function parseReasonResponse(
  output: string,
  id: string,
  prompt?: string,
  logger: HarnessLogger = NOOP_LOGGER,
): string {
  let text = output.trim();

  // A leaked reasoning trace, handled BEFORE anything else so no later step can
  // tidy one into something that reads like prose. Two shapes, both measured
  // live against z-ai/glm-5.3-flash:
  //
  //  - `trace</think>answer` — keep only what follows the LAST closer. This is
  //    the same rule as lib/llm/reasoning-leak, applied here so it also covers
  //    the on-device path and harness-local, neither of which goes through
  //    cloudComplete.
  //  - an UNCLOSED `<think>` — the trace was cut before the model finished
  //    thinking, so there is no answer in the string at all. Reject.
  const lastCloser = text.lastIndexOf('</think>');
  if (lastCloser !== -1) {
    text = text.slice(lastCloser + '</think>'.length).trim();
  } else if (text.includes('<think>')) {
    logger.warn('Reason generation: unclosed reasoning trace — rejected', { id });
    return '';
  }

  if (DELIBERATION_OPENER.test(text)) {
    logger.warn('Reason generation: output is deliberation, not a reason', {
      id,
      output: text.slice(0, 120),
    });
    return '';
  }

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
    .replace(/\n+/g, ' ');
  // Dashes are replaced BEFORE the whitespace collapse on purpose: ", " emitted
  // where the model already had spaces around the dash would otherwise leave a
  // double space, and the existing collapse cleans it up for free.
  text = replaceClauseDashes(text)
    .replace(/\s{2,}/g, ' ')
    .trim();

  if (text.length > 0) return cutAtWordBoundary(text, REASON_MAX_CHARS);

  logger.warn('Reason generation: failed to parse LLM output', {
    output: output.trim(),
    id,
    prompt,
  });

  return '';
}
