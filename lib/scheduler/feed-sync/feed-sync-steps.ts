// Individual steps of the feed sync flow, extracted from SuggestionSyncService.
// Each step is a pure async function that can be aborted via AbortSignal.

import { ArticleService } from '@/lib/article-service';
import {
  batchMarkAsScoredByIds,
  getLocalSuggestionServerIds,
  getUnscoredSuggestionsWithFacts,
  persistAndLinkV2Suggestions,
} from '@/lib/database/services/article-suggestion-service';
import { getFacts } from '@/lib/database/services/fact-service';
import logger from '@/lib/logger';
import { withRetry } from '@/lib/utils/retry';
import type { TaskContext } from '../scheduler-types';

export interface FetchTopicIdsResult {
  articleToTopicTexts: Map<string, string[]>;
  serverArticleIds: string[];
}

export interface DiffResult {
  serverArticleIds: string[];
  articleToTopicTexts: Map<string, string[]>;
  missingIds: string[];
}

export interface HydrateResult {
  fetched: Awaited<
    ReturnType<typeof ArticleService.getArticlesForTopicsByIds>
  >['articles'];
  articleToTopicTexts: Map<string, string[]>;
}

export interface PersistResult {
  insertedCount: number;
  linkedCount: number;
}

export async function stepFetchTopicIds(
  _userPersonaId: string,
  ctx: TaskContext,
): Promise<FetchTopicIdsResult> {
  if (ctx.signal.aborted) throw new Error('aborted');

  const topicTexts = await getLocalTopicTextsForPersona();
  if (topicTexts.length === 0) {
    throw Object.assign(new Error('no-topics-configured'), { code: 'no-topics-configured' });
  }
  ctx.log(`fetching ids for ${topicTexts.length} topics`);
  logger.info(`[feed-sync-steps] calling getArticleIdsForTopics with ${topicTexts.length} topics`);

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

  const { serverArticleIds, articleToTopicTexts } = result;
  const localIds = await getLocalSuggestionServerIds();
  const localIdSet = new Set(localIds);
  const missingIds = serverArticleIds.filter((id) => !localIdSet.has(id));
  ctx.log(`${missingIds.length} missing ids to hydrate`);

  return { serverArticleIds, articleToTopicTexts, missingIds };
}

export async function stepHydrate(
  diffResult: DiffResult,
  ctx: TaskContext,
  onProgress: (completed: number, total: number) => void,
): Promise<HydrateResult> {
  if (ctx.signal.aborted) throw new Error('aborted');

  const { missingIds, articleToTopicTexts } = diffResult;
  const response = missingIds.length
    ? await withRetry(
        () => ArticleService.getArticlesForTopicsByIds(missingIds, onProgress),
        ctx.signal,
      )
    : { articles: [], dailyLimitReached: false as boolean, resetAt: undefined };
  const fetched = response.articles;

  // Daily delivery cap: the server charges the cap here (the delivery point)
  // and clips the response to what's left of the user's quota. If the cap left
  // nothing to deliver, surface a terminal "daily limit reached" notice
  // (resumes at the server's resetAt). A partial clip (some articles still
  // delivered) proceeds normally — those were counted server-side, so we must
  // persist them; the notice surfaces on the next sync once the cap is dry.
  if (response.dailyLimitReached && fetched.length === 0) {
    logger.info('[feed-sync-steps] daily article-delivery limit reached');
    throw Object.assign(new Error('daily-limit'), {
      code: 'daily-limit',
      resetAt: response.resetAt ? Date.parse(response.resetAt) : undefined,
    });
  }

  ctx.log(`received ${fetched.length} full records`);
  return { fetched, articleToTopicTexts };
}

export async function stepPersist(
  hydrateResult: HydrateResult,
  ctx: TaskContext,
): Promise<PersistResult> {
  if (ctx.signal.aborted) throw new Error('aborted');

  const { fetched, articleToTopicTexts } = hydrateResult;
  const { insertedCount, linkedCount } = await persistAndLinkV2Suggestions(
    fetched,
    articleToTopicTexts,
  );

  const ineligibleCount = await markIneligibleArticlesAsScored();
  if (ineligibleCount > 0) {
    ctx.log(`pre-scored ${ineligibleCount} ineligible articles`);
  }

  return { insertedCount, linkedCount };
}

export async function stepScore(ctx: TaskContext): Promise<number> {
  if (ctx.signal.aborted) throw new Error('aborted');
  const { runScoringPass } = await import('@/lib/services/SuggestionSyncService');
  return runScoringPass();
}

// --- Internal helpers ---

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

async function markIneligibleArticlesAsScored(): Promise<number> {
  const candidates = await getUnscoredSuggestionsWithFacts();
  const ineligible = candidates.filter(
    (c) => !c.titleEn || !c.descriptionEn || c.relatedFacts.length === 0,
  );
  if (ineligible.length === 0) return 0;
  await batchMarkAsScoredByIds(ineligible.map((c) => c.id));
  return ineligible.length;
}

