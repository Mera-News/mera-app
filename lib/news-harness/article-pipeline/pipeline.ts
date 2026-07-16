// news-harness — end-to-end article relevance pipeline (RN-free).
//
// Sequentially reproduces the app's feed-sync + scoring semantics through the
// injected ports:
//   getFacts → deriveTopicTexts → getArticleIdsForTopics → buildArticleToTopicTexts
//   → hydrate (chunked) → buildCandidatesFromArticles → relevance (batchComplete)
//   → decode + bucket + saveScores → impactful subset → reasons (batchComplete)
//   → decode + saveReasons → PipelineReport.
//
// The gating mirrors lib/services/scoring-pipeline.ts::handleRelevanceResults +
// submitNeedsReasons and lib/services/inference-results.ts (REASON_MIN_RAW_SCORE,
// REASON_RELEVANCE_THRESHOLD). Timings use Date.now — this is plain Node/RN code.

import {
  DEFAULT_HARNESS_CONFIG,
  type ArticlePipelineConfig,
} from '../core/config';
import {
  NOOP_LOGGER,
  type HarnessLogger,
  type LlmPort,
  type NewsApiPort,
  type PersonaStorePort,
  type SuggestionSinkPort,
} from '../core/ports';
import type { Fact, HarnessArticle, ScoringCandidate } from '../core/types';
import {
  applyFeedVerifierDecisions,
  buildFeedVerifierCalls,
  buildReasonCallsForSubset,
  buildRelevanceCalls,
  bucketScores,
  chunk,
  decodeCloudBatchResults,
  REASON_MIN_RAW_SCORE,
} from './scoring';
import {
  buildArticleToTopicTexts,
  buildCandidatesFromArticles,
  deriveTopicTexts,
} from './candidates';

const ARTICLE_CFG = DEFAULT_HARNESS_CONFIG.articlePipeline;

export type PipelineStage =
  | 'facts'
  | 'topics'
  | 'article-ids'
  | 'articles'
  | 'candidates'
  | 'relevance'
  | 'verifier'
  | 'scores'
  | 'reasons'
  | 'done';

export interface PipelinePorts {
  llm: LlmPort;
  newsApi: NewsApiPort;
  personaStore: PersonaStorePort;
  sink: SuggestionSinkPort;
  logger?: HarnessLogger;
}

export interface PipelineHooks {
  onStage?(stage: PipelineStage, data: unknown): void;
}

export type ScoreBucketName =
  | 'DISCARD'
  | 'LOW'
  | 'MEDIUM'
  | 'HIGH'
  | 'EMERGENCY';

export interface PipelineScoreRow {
  id: string;
  titleEn: string | null;
  rawScore: number | null;
  bucketedScore: number | null;
  bucket: ScoreBucketName | null;
  /** raw score >= discardFloor (the plan's "kept" definition). */
  kept: boolean;
  reason: string | null;
  matchedTopics: string[];
  relatedFactIds: string[];
  failed: boolean;
}

export interface PipelineReport {
  counts: {
    facts: number;
    topics: number;
    articleIds: number;
    articles: number;
    candidates: number;
    eligible: number;
    ineligible: number;
    scored: number;
    kept: number;
    discarded: number;
    reasoned: number;
    failed: number;
  };
  buckets: Record<ScoreBucketName, number>;
  failedIds: string[];
  timings: { totalMs: number; stages: Partial<Record<PipelineStage, number>> };
  dailyLimitReached: boolean;
  resetAt?: string | null;
  // --- raw artifacts ---
  topics: string[];
  articleIdsByTopic: {
    topicText: string;
    articleIds: string[];
    hasNextPage: boolean;
    nextCursor?: string | null;
  }[];
  articles: HarnessArticle[];
  candidates: ScoringCandidate[];
  scores: PipelineScoreRow[];
  reasons: { id: string; reason: string }[];
}

/** Mirror of loadAllFactStatements in scoring-service.ts. */
function deriveFactStatements(facts: Fact[]): string[] {
  return facts
    .map((f) => f.statement)
    .filter((s) => typeof s === 'string' && s.trim().length > 0);
}

/** Name the priority band for a raw score — mirrors bucketScores' thresholds. */
export function bucketNameForRaw(
  raw: number,
  config: ArticlePipelineConfig = ARTICLE_CFG,
): ScoreBucketName {
  if (raw < config.discardFloor) return 'DISCARD';
  if (raw > config.emergencyPriorityCutoff) return 'EMERGENCY';
  if (raw >= config.highPriorityCutoff) return 'HIGH';
  if (raw >= config.mediumPriorityCutoff) return 'MEDIUM';
  return 'LOW';
}

export async function runArticlePipeline(
  ports: PipelinePorts,
  config: ArticlePipelineConfig = ARTICLE_CFG,
  hooks?: PipelineHooks,
): Promise<PipelineReport> {
  const logger = ports.logger ?? NOOP_LOGGER;
  const emit = (stage: PipelineStage, data: unknown) => hooks?.onStage?.(stage, data);
  const stages: Partial<Record<PipelineStage, number>> = {};
  const t0 = Date.now();
  let mark = t0;
  const tick = (stage: PipelineStage) => {
    const now = Date.now();
    stages[stage] = now - mark;
    mark = now;
  };

  // --- facts ---
  const facts = await ports.personaStore.getFacts();
  const factStatements = deriveFactStatements(facts);
  tick('facts');
  emit('facts', facts);

  // --- topics ---
  const topics = deriveTopicTexts(facts);
  tick('topics');
  emit('topics', topics);

  // --- article ids per topic ---
  const idsResponse = await ports.newsApi.getArticleIdsForTopics(
    topics.map((t) => ({ topicText: t })),
    { limitPerTopic: config.limitPerTopic },
  );
  const articleToTopicTexts = buildArticleToTopicTexts(idsResponse.results);
  const serverArticleIds = [...articleToTopicTexts.keys()];
  const articleIdsByTopic = idsResponse.results.map((r) => ({
    topicText: r.topicText,
    articleIds: r.articleIds,
    hasNextPage: r.hasNextPage,
    nextCursor: r.nextCursor ?? null,
  }));
  tick('article-ids');
  emit('article-ids', { results: articleIdsByTopic });

  // --- hydrate articles (chunked; respect + report dailyLimitReached) ---
  const articles: HarnessArticle[] = [];
  let dailyLimitReached = false;
  let resetAt: string | null | undefined;
  const idChunks = chunk(serverArticleIds, config.hydrateChunkSize);
  for (const idChunk of idChunks) {
    const response = await ports.newsApi.getArticlesForTopicsByIds(idChunk);
    articles.push(...response.articles);
    if (response.dailyLimitReached) {
      dailyLimitReached = true;
      resetAt = resetAt ?? response.resetAt;
      // Cap hit — keep what this chunk returned, stop hydrating further chunks.
      break;
    }
  }
  tick('articles');
  emit('articles', articles);

  // --- candidates ---
  const candidates = buildCandidatesFromArticles(
    articles,
    articleToTopicTexts,
    facts,
  );
  tick('candidates');
  emit('candidates', candidates);

  // --- relevance (score-only cloud calls) ---
  const scoreBundle = buildRelevanceCalls(
    candidates,
    factStatements,
    config,
    logger,
  );
  const scoreResults =
    scoreBundle.calls.length > 0
      ? await ports.llm.batchComplete(scoreBundle.calls, { model: config.model })
      : [];
  const decodedScores = decodeCloudBatchResults(
    {
      batchResults: scoreResults,
      promptsById: scoreBundle.promptsById,
      chunkIdToCandidates: scoreBundle.chunkIdToCandidates,
    },
    config,
    logger,
  );
  tick('relevance');
  emit('relevance', {
    rawScores: Object.fromEntries(decodedScores.scoreMap),
    failedIds: [...decodedScores.failedIds],
  });

  // --- second-pass FEED verifier (fail-open) ---
  // Audit only the first-pass FEED candidates (raw ≥ discardFloor); demote the
  // clear false positives to config.feedVerifierDemoteScore IN the raw score map
  // (before the snapshot below), so they fall out of FEED, out of reason
  // generation (< reasonRelevanceThreshold), and out of the app's visibility
  // cutoff. Any error leaves scores unchanged.
  let verifierDemoted = 0;
  if (config.feedVerifierEnabled) {
    const feedCandidates = scoreBundle.eligibleCandidates.filter(
      (c) => (decodedScores.scoreMap.get(c.id) ?? 0) >= config.discardFloor,
    );
    if (feedCandidates.length > 0) {
      try {
        const { calls, verifyIdToCandidates } = buildFeedVerifierCalls(
          feedCandidates,
          factStatements,
          config,
          logger,
        );
        if (calls.length > 0) {
          const verifyResults = await ports.llm.batchComplete(calls, {
            model: config.model,
          });
          verifierDemoted = applyFeedVerifierDecisions(
            decodedScores.scoreMap,
            verifyIdToCandidates,
            verifyResults,
            config,
            logger,
          );
        }
      } catch (err) {
        logger.warn('[article-pipeline] feed verifier failed — scores unchanged', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    logger.info('[article-pipeline] feed verifier', {
      audited: feedCandidates.length,
      demoted: verifierDemoted,
    });
  }
  tick('verifier');
  emit('verifier', { demoted: verifierDemoted });

  // Raw scores are needed for reason prompts + reporting; bucketing mutates the
  // map in place, so snapshot the raw values first (post-verifier).
  const rawScoreMap = new Map(decodedScores.scoreMap);
  const bucketedScoreMap = decodedScores.scoreMap;
  bucketScores(bucketedScoreMap, config);
  const failedIds = decodedScores.failedIds;

  // --- persist scores (skip chunks that failed to score) ---
  const relevanceMap: Record<string, number> = {};
  const rawRelevanceMap: Record<string, number> = {};
  for (const [id, raw] of rawScoreMap) rawRelevanceMap[id] = raw;
  const scoreEntries: { id: string; relevance: number; rawScore: number }[] = [];
  for (const [id, bucketed] of bucketedScoreMap) {
    if (failedIds.has(id)) continue;
    relevanceMap[id] = bucketed;
    scoreEntries.push({ id, relevance: bucketed, rawScore: rawRelevanceMap[id] ?? bucketed });
  }
  await ports.sink.saveScores(scoreEntries);
  tick('scores');
  emit('scores', scoreEntries);

  // --- impactful subset → reasons ---
  // Mirror scoring-pipeline: bucketed relevance > REASON_RELEVANCE_THRESHOLD and
  // raw >= REASON_MIN_RAW_SCORE, then buildReasonCallsForSubset re-filters on the
  // raw map against the same threshold.
  const impactfulIds = new Set(
    Object.keys(relevanceMap).filter(
      (id) =>
        relevanceMap[id] > config.reasonRelevanceThreshold &&
        (rawRelevanceMap[id] ?? 0) >= REASON_MIN_RAW_SCORE,
    ),
  );
  const survivors = scoreBundle.eligibleCandidates.filter((c) =>
    impactfulIds.has(c.id),
  );
  const reasonBundle = buildReasonCallsForSubset(
    survivors,
    rawRelevanceMap,
    config.reasonRelevanceThreshold,
    factStatements,
    config,
    logger,
  );
  const reasonResults =
    reasonBundle.calls.length > 0
      ? await ports.llm.batchComplete(reasonBundle.calls, { model: config.model })
      : [];
  const decodedReasons = decodeCloudBatchResults(
    {
      batchResults: reasonResults,
      promptsById: reasonBundle.promptsById,
      chunkIdToCandidates: reasonBundle.chunkIdToCandidates,
    },
    config,
    logger,
  );
  const reasonMap = decodedReasons.reasonMap;
  const reasonEntries = [...reasonMap.entries()].map(([id, reason]) => ({
    id,
    reason,
  }));
  await ports.sink.saveReasons(reasonEntries);
  tick('reasons');
  emit('reasons', reasonEntries);

  // --- assemble report ---
  const buckets: Record<ScoreBucketName, number> = {
    DISCARD: 0,
    LOW: 0,
    MEDIUM: 0,
    HIGH: 0,
    EMERGENCY: 0,
  };
  const scores: PipelineScoreRow[] = candidates.map((c) => {
    const failed = failedIds.has(c.id);
    const raw = rawScoreMap.has(c.id) ? (rawScoreMap.get(c.id) as number) : null;
    const bucketed = bucketedScoreMap.has(c.id)
      ? (bucketedScoreMap.get(c.id) as number)
      : null;
    const bucket = raw !== null ? bucketNameForRaw(raw, config) : null;
    if (bucket) buckets[bucket] += 1;
    const kept = !failed && raw !== null && raw >= config.discardFloor;
    return {
      id: c.id,
      titleEn: c.titleEn,
      rawScore: raw,
      bucketedScore: bucketed,
      bucket,
      kept,
      reason: reasonMap.get(c.id) ?? null,
      matchedTopics: c.userTopicIds,
      relatedFactIds: c.relatedFacts.map((f) => f.id),
      failed,
    };
  });

  const eligible = scoreBundle.eligibleCandidates.length;
  const scored = Object.keys(relevanceMap).length;
  const kept = scores.filter((s) => s.kept).length;
  const reasoned = reasonEntries.filter((r) => r.reason.length > 0).length;

  const report: PipelineReport = {
    counts: {
      facts: facts.length,
      topics: topics.length,
      articleIds: serverArticleIds.length,
      articles: articles.length,
      candidates: candidates.length,
      eligible,
      ineligible: candidates.length - eligible,
      scored,
      kept,
      discarded: scored - kept,
      reasoned,
      failed: failedIds.size,
    },
    buckets,
    failedIds: [...failedIds],
    timings: { totalMs: Date.now() - t0, stages },
    dailyLimitReached,
    resetAt: resetAt ?? null,
    topics,
    articleIdsByTopic,
    articles,
    candidates,
    scores,
    reasons: reasonEntries,
  };

  logger.info('[article-pipeline] done', {
    candidates: report.counts.candidates,
    scored: report.counts.scored,
    kept: report.counts.kept,
    reasoned: report.counts.reasoned,
    failed: report.counts.failed,
    dailyLimitReached,
  });
  emit('done', report);
  return report;
}
