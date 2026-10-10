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
import languages from '@cospired/i18n-iso-languages';
import langEn from '@cospired/i18n-iso-languages/langs/en.json';
import {
  buildBatchScoringUserMessage,
  buildFeedVerifierUserMessage,
  buildReasonUserMessage,
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

languages.registerLocale(langEn as Parameters<typeof languages.registerLocale>[0]);

/**
 * English name for a language tag, e.g. "pt-PT" -> "Portuguese".
 *
 * Only the `en` pack is registered: this feeds a PROMPT, which is always
 * English, so the 17 other packs `lib/algorithms/language-names.ts` carries would be ~100KB
 * of dead weight in the harness bundle. That file is also app-land and imports
 * `@/lib/algorithms/language-codes`, which the harness may not reach.
 *
 * Reduces to the primary subtag because the pack is keyed on bare ISO-639-1:
 * "pt-PT" and "zh-Hans" resolve only after the region or script is dropped.
 */
export function resolveLanguageName(
  code: string | null | undefined,
): string | undefined {
  if (!code) return undefined;
  const primary = String(code).split(/[-_]/)[0]?.toLowerCase();
  if (!primary) return undefined;
  return languages.getName(primary, 'en') || undefined;
}

/**
 * The `Publication: ...` value for a prompt, or undefined when there is nothing
 * worth saying.
 *
 * Shapes: "Diario de Noticias (Portuguese)", or the publisher alone when the
 * language is unknown or English, or "(Portuguese)" alone when only the language
 * is known. English is dropped deliberately: nearly every article reaching the
 * scorer is English or translated into it, so naming it adds a token to every
 * article and distinguishes nothing.
 */
export function buildPublicationLabel(
  publicationName: string | null | undefined,
  languageCode: string | null | undefined,
): string | undefined {
  const name = (publicationName ?? '').trim();
  const lang = resolveLanguageName(languageCode);
  const useLang = lang && lang.toLowerCase() !== 'english' ? lang : undefined;
  if (name && useLang) return `${name} (${useLang})`;
  if (name) return name;
  if (useLang) return `(${useLang})`;
  return undefined;
}

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
  for (const [id, raw] of scoreMap) scoreMap.set(id, bucketScore(raw, config));
}

/**
 * {@link bucketScores} for ONE value.
 *
 * Extracted because the pass-2 rescore arrives per row, long after the batch
 * was bucketed, and the alternative was a second copy of the four cutoffs at
 * every write site. Same rule, same order, sub-floor scores returned untouched.
 */
export function bucketScore(
  raw: number,
  config: ArticlePipelineConfig = ARTICLE_CFG,
): number {
  if (raw < config.discardFloor) return raw;
  if (raw > config.emergencyPriorityCutoff) return config.emergencyPriorityScore;
  if (raw >= config.highPriorityCutoff) return config.highPriorityScore;
  if (raw >= config.mediumPriorityCutoff) return config.mediumPriorityScore;
  return config.lowPriorityScore;
}

/** What a caller does with a pass-2 score. See `PromptVariantSpec.rescorePolicy`. */
export type RescorePolicy = 'replace' | 'demote-only';

/**
 * Combine a pass-1 RAW score with a pass-2 one.
 *
 * The shipped policy is `replace`, in both directions: pass 2 sees one article
 * where pass 1 saw five, with the same rubric and the same facts, so its answer
 * is the better-informed one whichever way it moves. `demote-only` is the guard
 * against pass 2 inflating, kept as an arm rather than a belief.
 *
 * RAW in, RAW out. Bucketing is the caller's last step, after this.
 */
export function applyRescorePolicy(
  pass1: number,
  rescored: number,
  policy: RescorePolicy = 'replace',
): number {
  return policy === 'demote-only' ? Math.min(pass1, rescored) : rescored;
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
      publication: buildPublicationLabel(
        c.publicationName ?? c.meta?.publicationName,
        c.languageCode,
      ),
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
 * Every chunk holds `articlesPerScorePrompt` candidates, headlines included, so
 * a batch can mix them freely. The system prompt is chosen PER CHUNK (P4b):
 * a chunk of TOP-HEADLINE candidates only gets the indirect-impact prompt,
 * any other chunk the standard one. Pass `variant` to force one prompt for every
 * chunk. The size used is returned as `scoreChunkSize` so an async caller
 * persists the real value rather than re-deriving it at decode time.
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
  const scoreChunkSize = config.articlesPerScorePrompt;
  const chunks = chunk(eligible, scoreChunkSize);

  const calls: BatchCall[] = [];
  const promptsById = new Map<string, string>();
  const chunkIdToCandidates = new Map<string, ScoringCandidate[]>();

  chunks.forEach((chunkCandidates, idx) => {
    const { prompt, system } = buildScoreCallForChunk(
      chunkCandidates,
      factStatements,
      relevanceSystemPromptFor(config, variant ?? resolveScoringVariant(chunkCandidates)),
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
      publication: buildPublicationLabel(
        c.publicationName ?? c.meta?.publicationName,
        c.languageCode,
      ),
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
