// Individual steps of the feed sync flow, extracted from SuggestionSyncService.
// Each step is a pure async function that can be aborted via AbortSignal.

import { ArticleService } from '@/lib/article-service';
import {
  batchMarkAsScoredByIds,
  getLocalSuggestionServerIds,
  getUnscoredSuggestionsWithFacts,
  persistAndLinkV2Suggestions,
  getFactWeightById,
  type PersonaPersistMeta,
  type MatchedTopicMeta,
} from '@/lib/database/services/article-suggestion-service';
import { getFacts } from '@/lib/database/services/fact-service';
import { getActive as getActiveTopics } from '@/lib/database/services/topic-service';
import { getAll as getAllLocations } from '@/lib/database/services/location-service';
import { buildRetrievalProfile } from '@/lib/news-harness/scoring-engine';
import { HeadlineScope, type PersonaQueryInput } from '@/lib/generated/graphql-types';
import { gateUnscoredForScoring } from '@/lib/feed-grouping/score-propagation';
import logger from '@/lib/logger';
import { withRetry } from '@/lib/utils/retry';
import { yieldToEventLoop } from '../idle';
import type { TaskContext } from '../scheduler-types';
import { reconcileTrackedStories } from './tracked-story-reconcile';

/** Number of missing ids hydrated + persisted + enqueued per iteration. Kept at
 *  25 so each `getArticlesForTopicsByIds` call is a single server query (its
 *  internal chunk size is 50) and each enqueued batch is exactly one scoring
 *  batch (`BATCH_SIZE = 25` in scoring-pipeline). */
export const HYDRATE_CHUNK_SIZE = 25;

/** Round-4 B: hydrate up to this many chunks concurrently. WatermelonDB
 *  serializes writes internally, so per-chunk persists are safe to interleave;
 *  the gate+enqueue step is separately serialized behind a promise chain. */
export const HYDRATE_CONCURRENCY = 3;

export interface FetchTopicIdsResult {
  articleToTopicTexts: Map<string, string[]>;
  serverArticleIds: string[];
  /** Persona-v3 metadata (present on the persona path; absent on the empty-
   *  topics-table fallback, which routes persist + scoring to the legacy path). */
  personaMeta?: PersonaPersistMeta;
}

export interface DiffResult {
  serverArticleIds: string[];
  articleToTopicTexts: Map<string, string[]>;
  missingIds: string[];
  personaMeta?: PersonaPersistMeta;
}

/** Result of the merged hydrate + persist + enqueue step. */
export interface HydratePersistEnqueueResult {
  /** Total suggestion rows inserted across all chunks. */
  insertedCount: number;
  /** Total eligible ids handed to the scoring pipeline across all chunks. */
  enqueuedCount: number;
  /** True when the daily delivery cap clipped this run (partial or full). On a
   *  partial clip we still deliver what landed; the machine surfaces the limit
   *  banner immediately. A full clip with NOTHING delivered throws `daily-limit`
   *  instead. */
  dailyLimitReached: boolean;
  /** ISO reset timestamp, set only when `dailyLimitReached`. */
  resetAt?: string;
}

export interface HydratePersistEnqueueOptions {
  /** Reports cumulative completed-ids progress over the whole missingIds set. */
  onProgress: (completed: number) => void;
  /** Blocks between chunks while the machine is paused offline (hydrating is a
   *  NETWORK_DEPENDENT_STATE). Resolves immediately when not paused. */
  awaitResumeIfPaused: () => Promise<void>;
  /** Refreshes the For You store so freshly-persisted (still-unscored) articles
   *  render progressively, one chunk at a time. */
  refreshStore: () => Promise<void>;
}

export async function stepFetchTopicIds(
  _userPersonaId: string,
  ctx: TaskContext,
): Promise<FetchTopicIdsResult> {
  if (ctx.signal.aborted) throw new Error('aborted');

  // Self-gating cutover: once the persona-v3 `topics` table is populated (the
  // one-time silent migration ran), use the privacy-lean persona retrieval;
  // until then fall back end-to-end to the legacy metadata.topics path so the
  // feed degrades gracefully on devices that haven't migrated yet.
  const activeTopics = await getActiveTopics();
  if (activeTopics.length === 0) {
    return fetchTopicIdsLegacy(ctx);
  }
  return fetchTopicIdsPersona(activeTopics, ctx);
}

/** Persona-v3 privacy-lean retrieval: build the retrieval profile from weighted
 *  topics + locations, call articleIdsForPersona, and invert the per-topic
 *  matchMeta + headline results into the persist metadata. */
async function fetchTopicIdsPersona(
  activeTopics: Awaited<ReturnType<typeof getActiveTopics>>,
  ctx: TaskContext,
): Promise<FetchTopicIdsResult> {
  const [factWeights, locations] = await Promise.all([
    getFactWeightById(),
    getAllLocations(),
  ]);

  const profile = buildRetrievalProfile({
    topics: activeTopics.map((t) => ({
      topicId: t.id,
      text: t.text,
      weight: t.weight,
      highPriority: t.highPriority,
      factWeight: t.factId ? factWeights.get(t.factId) ?? 1 : 1,
    })),
    locations: locations.map((l) => ({
      countryCode: l.countryCode,
      role: l.role,
      weight: l.weight,
      validUntilMs: l.validUntil ?? undefined,
    })),
  });

  if (profile.topics.length === 0) {
    // Topics exist but none has a positive effective weight → nothing to
    // retrieve (all negative/suppressed). Terminal, same as no-topics.
    throw Object.assign(new Error('no-topics-configured'), { code: 'no-topics-configured' });
  }

  const textToTopicId = new Map<string, string>();
  for (const t of profile.topics) {
    if (!textToTopicId.has(t.text)) textToTopicId.set(t.text, t.topicId);
  }

  const query: PersonaQueryInput = {
    topics: profile.topics.map((t) => ({ text: t.text, limit: t.limit })),
    limitPerTopic: 20,
    topHeadlines: {
      scopes: profile.headlineScopes.map((s) => ({
        scope: s.scope === 'COUNTRY' ? HeadlineScope.Country : HeadlineScope.Global,
        countryCode: s.countryCode ?? null,
      })),
      limitPerScope: profile.headlineLimitPerScope,
    },
  };

  ctx.log(`fetching persona ids for ${profile.topics.length} topics + ${profile.headlineScopes.length} scopes`);
  logger.info(
    `[feed-sync-steps] calling articleIdsForPersona: ${profile.topics.length} topics, ${profile.headlineScopes.length} headline scopes`,
  );

  const res = await withRetry(() => ArticleService.getArticleIdsForPersona(query), ctx.signal);

  const articleToTopicTexts = new Map<string, string[]>();
  const matchedTopics = new Map<string, MatchedTopicMeta[]>();
  const headlineScope = new Map<string, string>();
  const stableClusterId = new Map<string, string>();

  const pushMatched = (articleId: string, entry: MatchedTopicMeta) => {
    const bucket = matchedTopics.get(articleId) ?? [];
    bucket.push(entry);
    matchedTopics.set(articleId, bucket);
    const texts = articleToTopicTexts.get(articleId) ?? [];
    if (entry.text && !texts.includes(entry.text)) texts.push(entry.text);
    articleToTopicTexts.set(articleId, texts);
  };

  // Invert per-topic results → per-article matched topics.
  for (const tr of res.topicResults ?? []) {
    const topicId = textToTopicId.get(tr.topicText) ?? null;
    const metaByArticle = new Map(
      (tr.matchMeta ?? []).map((m) => [m.articleId, m]),
    );
    for (const articleId of tr.articleIds ?? []) {
      const mm = metaByArticle.get(articleId);
      pushMatched(articleId, {
        topicId,
        text: tr.topicText,
        vectorScore: mm?.vectorScore ?? null,
        stableClusterId: mm?.stableClusterId ?? null,
      });
      if (mm?.stableClusterId && !stableClusterId.has(articleId)) {
        stableClusterId.set(articleId, mm.stableClusterId);
      }
    }
  }

  // Headline injection: synthetic matched-topic (topicId null) + headline_scope.
  for (const hr of res.headlineResults ?? []) {
    const scopeLabel = hr.scope === HeadlineScope.Country ? 'COUNTRY' : 'GLOBAL';
    const label = `top headline · ${scopeLabel.toLowerCase()}`;
    const ids = hr.articleIds ?? [];
    const stableIds = hr.stableClusterIds ?? [];
    ids.forEach((articleId, i) => {
      pushMatched(articleId, { topicId: null, text: label, vectorScore: null, stableClusterId: stableIds[i] ?? null });
      // Topic-retrieved match wins over a headline scope when both apply.
      if (!headlineScope.has(articleId)) headlineScope.set(articleId, scopeLabel);
      const sid = stableIds[i];
      if (sid && !stableClusterId.has(articleId)) stableClusterId.set(articleId, sid);
    });
  }

  const serverArticleIds = [...matchedTopics.keys()];
  logger.info(`[feed-sync-steps] articleIdsForPersona returned ${serverArticleIds.length} article ids`);
  ctx.log(`server returned ${serverArticleIds.length} article ids (persona path)`);

  return {
    articleToTopicTexts,
    serverArticleIds,
    personaMeta: { matchedTopics, headlineScope, stableClusterId },
  };
}

/** Legacy fallback: the pre-persona metadata.topics retrieval path, used until
 *  the persona-v3 migration has populated the `topics` table on this device. */
async function fetchTopicIdsLegacy(ctx: TaskContext): Promise<FetchTopicIdsResult> {
  const topicTexts = await getLocalTopicTextsForPersona();
  if (topicTexts.length === 0) {
    throw Object.assign(new Error('no-topics-configured'), { code: 'no-topics-configured' });
  }
  ctx.log(`fetching ids for ${topicTexts.length} topics (legacy path)`);
  logger.info(`[feed-sync-steps] calling getArticleIdsForTopics with ${topicTexts.length} topics (legacy)`);

  const idsResponse = await withRetry(
    () =>
      ArticleService.getArticleIdsForTopics(
        topicTexts.map((text) => ({ topicText: text })),
        { limitPerTopic: 20 },
      ),
    ctx.signal,
  );

  const articleToTopicTexts = new Map<string, string[]>();
  for (const result of idsResponse.results) {
    for (const id of result.articleIds) {
      const existing = articleToTopicTexts.get(id) ?? [];
      existing.push(result.topicText);
      articleToTopicTexts.set(id, existing);
    }
  }
  const serverArticleIds = [...articleToTopicTexts.keys()];

  logger.info(`[feed-sync-steps] getArticleIdsForTopics returned ${serverArticleIds.length} article ids`);
  ctx.log(`server returned ${serverArticleIds.length} article ids`);
  return { articleToTopicTexts, serverArticleIds };
}

export async function stepDiff(
  result: FetchTopicIdsResult,
  ctx: TaskContext,
): Promise<DiffResult> {
  if (ctx.signal.aborted) throw new Error('aborted');

  const { serverArticleIds, articleToTopicTexts, personaMeta } = result;
  const localIds = await getLocalSuggestionServerIds();
  const localIdSet = new Set(localIds);
  const missingIds = serverArticleIds.filter((id) => !localIdSet.has(id));
  ctx.log(`${missingIds.length} missing ids to hydrate`);

  return { serverArticleIds, articleToTopicTexts, missingIds, personaMeta };
}

/**
 * Merged hydrate + persist + enqueue step (runs under the `hydrating` state).
 *
 * Round-4 B: chunks are hydrated with concurrency `HYDRATE_CONCURRENCY` (a
 * simple promise pool, no new deps). For each chunk a worker downloads the full
 * records (one server query), persists + links them, marks ineligible rows
 * scored, refreshes the store for progressive rendering, and — if the chunk
 * produced eligible ids — runs the gate + enqueue step so full 25-article quanta
 * dispatch MID-hydration (greedy overlap) instead of only once at the end. The
 * gate+enqueue invocations are serialized behind a promise chain so they never
 * run concurrently (the gate re-derives its candidates from ALL unscored,
 * not-in-flight rows, and enqueueCandidates applies the strict quantum gate).
 *
 * Daily-limit semantics: the server charges the delivery cap here and clips the
 * response. If the cap leaves NOTHING to deliver on the whole run, throw a
 * terminal `daily-limit` error (decided AFTER the pool drains so a parallel dry
 * chunk can't pre-empt a sibling that did deliver). If it hits after some chunks
 * already landed, stop launching new chunks and keep what landed.
 */
export async function stepHydratePersistEnqueue(
  diffResult: DiffResult,
  ctx: TaskContext,
  opts: HydratePersistEnqueueOptions,
): Promise<HydratePersistEnqueueResult> {
  if (ctx.signal.aborted) throw new Error('aborted');

  const { missingIds, articleToTopicTexts, personaMeta } = diffResult;
  const chunks = chunkArray(missingIds, HYDRATE_CHUNK_SIZE);

  let completedIds = 0;
  let insertedCount = 0;
  let deliveredAny = false;
  let dailyLimitReached = false;
  let resetAt: string | undefined;
  let enqueuedCount = 0;
  // Set once a chunk hits the cap dry (0 articles) or a mid-run abort/pause
  // ends — stops the pool from launching further chunks.
  let stopLaunching = false;

  // Lazy require (not a static import) breaks the module-load cycle
  // feed-sync-steps → scoring-pipeline → SuggestionSyncService → run-inference-
  // handler → feed-sync-steps. Same pattern as lib/database/hydrate-stores.ts.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const scoringPipeline = require('@/lib/services/scoring-pipeline') as typeof import('@/lib/services/scoring-pipeline');
  const { enqueueCandidates, getNonTerminalCandidateIds } = scoringPipeline;

  // Serialize gate+enqueue: the gate scans ALL unscored rows and enqueueCandidates
  // dispatches quanta, so two concurrent invocations could double-count. A simple
  // promise chain guarantees one-at-a-time execution across the parallel workers.
  let gateChain: Promise<void> = Promise.resolve();
  const runGateSerialized = (fn: () => Promise<void>): Promise<void> => {
    const next = gateChain.then(fn, fn);
    // Keep the chain alive even if fn rejects, so one failure doesn't wedge the
    // rest. Individual failures still surface via the awaited `next`.
    gateChain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };

  // The gate re-derives its candidates from ALL unscored, not-in-flight rows —
  // not just this chunk's eligible ids — so any sibling held back or missed by a
  // failed batch on a prior chunk/sync is re-considered. Self-healing with no
  // persisted held-back state: a held-back sibling is either propagated (its rep
  // scored) or re-enqueued next pass.
  const gateAndEnqueue = async (): Promise<void> => {
    const inFlight = await getNonTerminalCandidateIds();
    const gate = await gateUnscoredForScoring(inFlight);
    if (gate.propagatedCount > 0) {
      // Propagated rows are now terminal `Complete` — surface them immediately.
      await opts.refreshStore();
    }
    if (gate.enqueueIds.length > 0) {
      await enqueueCandidates(gate.enqueueIds);
    }
    enqueuedCount += gate.enqueueIds.length;
    ctx.log(
      `gate: propagated ${gate.propagatedCount}, held back ${gate.heldBackCount}, enqueued ${gate.enqueueIds.length}`,
    );
    logger.info(
      `[feed-sync-steps] gate: propagated ${gate.propagatedCount}, held back ${gate.heldBackCount}, enqueued ${gate.enqueueIds.length}`,
    );
  };

  let nextChunk = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      if (stopLaunching) return;
      // Cooperative points: pause while offline, bail on abort.
      await opts.awaitResumeIfPaused();
      if (ctx.signal.aborted) {
        stopLaunching = true;
        return;
      }
      const i = nextChunk++;
      if (i >= chunks.length) return;
      const chunk = chunks[i];

      const response = await withRetry(
        () =>
          ArticleService.getArticlesForTopicsByIds(chunk, (chunkCompleted) => {
            opts.onProgress(completedIds + chunkCompleted);
          }),
        ctx.signal,
      );
      const chunkArticles = response.articles;
      if (response.dailyLimitReached) {
        dailyLimitReached = true;
        resetAt = resetAt ?? response.resetAt;
      }

      if (chunkArticles.length > 0) {
        deliveredAny = true;
        const { insertedCount: chunkInserted } =
          await persistAndLinkV2Suggestions(
            chunkArticles,
            articleToTopicTexts,
            personaMeta,
          );
        insertedCount += chunkInserted;

        const chunkIdSet = new Set(chunkArticles.map((a) => a._id));
        const { ineligibleCount, eligibleIds } =
          await markIneligibleAndCollectEligible(chunkIdSet);
        if (ineligibleCount > 0) {
          ctx.log(`pre-scored ${ineligibleCount} ineligible articles`);
        }

        // Progressive rendering: newly-persisted (unscored) articles appear now.
        await opts.refreshStore();
        // A6: yield the JS thread so the just-rendered chunk can paint.
        await yieldToEventLoop();

        // Greedy overlap: if this chunk produced eligible ids, run the
        // gate+enqueue now (serialized) so accumulated full quanta dispatch
        // mid-hydration instead of only once at the end.
        if (eligibleIds.length > 0) {
          await runGateSerialized(gateAndEnqueue);
        }
      }

      completedIds += chunk.length;
      opts.onProgress(completedIds);
      ctx.log(`chunk ${i + 1}/${chunks.length}: persisted ${chunkArticles.length}`);
      logger.info(
        `[feed-sync-steps] chunk ${i + 1}/${chunks.length}: persisted ${chunkArticles.length}`,
      );

      // Daily cap ran dry for this chunk (nothing delivered) — stop launching
      // further chunks. The throw-vs-keep decision is made AFTER the pool drains.
      if (dailyLimitReached && chunkArticles.length === 0) {
        stopLaunching = true;
        logger.info(
          '[feed-sync-steps] daily limit hit — stopping the hydration pool',
        );
        return;
      }
    }
  };

  const poolSize = Math.min(HYDRATE_CONCURRENCY, Math.max(1, chunks.length));
  await Promise.all(Array.from({ length: poolSize }, () => worker()));
  // Drain any still-pending serialized gate invocation before deciding the
  // outcome / returning.
  await gateChain;

  // Daily-limit outcome: throw ONLY if the cap blocked the entire run.
  if (dailyLimitReached && !deliveredAny) {
    logger.info('[feed-sync-steps] daily article-delivery limit reached');
    throw Object.assign(new Error('daily-limit'), {
      code: 'daily-limit',
      resetAt: resetAt ? Date.parse(resetAt) : undefined,
    });
  }

  ctx.log(`hydrated+persisted ${insertedCount} records, enqueued ${enqueuedCount}`);

  // Fire-and-forget: grow followed stories from whatever this run just
  // persisted (article_suggestions.stable_cluster_id). Runs after every
  // persist attempt — including a partial/daily-limit-clipped one, since
  // whatever landed is still a valid reconcile source — but must never fail
  // or delay the sync itself.
  reconcileTrackedStories().catch((err) => {
    logger.captureException(err, {
      tags: { component: 'feed-sync-steps', method: 'reconcileTrackedStories' },
    });
  });

  return {
    insertedCount,
    enqueuedCount,
    dailyLimitReached,
    resetAt,
  };
}

export async function stepScore(ctx: TaskContext): Promise<number> {
  if (ctx.signal.aborted) throw new Error('aborted');
  const { runScoringPass } = await import('@/lib/services/SuggestionSyncService');
  return runScoringPass();
}

// --- Internal helpers ---

function chunkArray<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

async function getLocalTopicTextsForPersona(): Promise<string[]> {
  const facts = await getFacts();
  const texts = new Set<string>();
  for (const fact of facts) {
    for (const topic of fact.metadata?.topics ?? []) {
      if (topic.length > 0) texts.add(topic);
    }
  }
  logger.info(`[feed-sync-steps] found ${texts.size} topic texts from facts`);
  return Array.from(texts);
}

/**
 * Partition the currently-unscored suggestions: mark the ineligible ones
 * (missing English title/description or with no linked facts) as scored so they
 * never enter scoring, and return the eligible ids that belong to THIS chunk so
 * they can be enqueued. Global scan (like the pre-merge `markIneligible…`), but
 * the returned eligible set is scoped to the chunk just persisted.
 */
async function markIneligibleAndCollectEligible(
  chunkIds: Set<string>,
): Promise<{ ineligibleCount: number; eligibleIds: string[] }> {
  const candidates = await getUnscoredSuggestionsWithFacts();
  const ineligible = candidates.filter(
    (c) => !c.titleEn || !c.descriptionEn || c.relatedFacts.length === 0,
  );
  if (ineligible.length > 0) {
    await batchMarkAsScoredByIds(ineligible.map((c) => c.id));
  }
  const eligibleIds = candidates
    .filter((c) => c.titleEn && c.descriptionEn && c.relatedFacts.length > 0)
    .filter((c) => chunkIds.has(c.id))
    .map((c) => c.id);
  return { ineligibleCount: ineligible.length, eligibleIds };
}
