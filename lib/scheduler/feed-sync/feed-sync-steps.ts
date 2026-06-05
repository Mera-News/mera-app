// Individual steps of the feed sync flow, extracted from SuggestionSyncService.
// Each step is a pure async function that can be aborted via AbortSignal.

import { ArticleService } from '@/lib/article-service';
import {
  deleteSuggestionsByServerIds,
  deleteExpiredSuggestions,
  getLocalSuggestionServerIds,
  getUnscoredSuggestionsWithFacts,
  persistAndLinkV2Suggestions,
  saveScoringResult,
} from '@/lib/database/services/article-suggestion-service';
import database from '@/lib/database';
import { Q } from '@nozbe/watermelondb';
import type UserPersonaModel from '@/lib/database/models/UserPersona';
import type UserTopicModel from '@/lib/database/models/UserTopic';
import logger from '@/lib/logger';
import type { TaskContext } from '../scheduler-types';

export interface FetchTopicIdsResult {
  articleToTopicTexts: Map<string, string[]>;
  serverArticleIds: string[];
}

export interface DiffResult {
  serverArticleIds: string[];
  articleToTopicTexts: Map<string, string[]>;
  missingIds: string[];
  deletedCount: number;
}

export interface HydrateResult {
  fetched: Awaited<ReturnType<typeof ArticleService.getArticlesForTopicsByIds>>;
  articleToTopicTexts: Map<string, string[]>;
}

export interface PersistResult {
  insertedCount: number;
  linkedCount: number;
}

export async function stepFetchTopicIds(
  userPersonaId: string,
  ctx: TaskContext,
): Promise<FetchTopicIdsResult> {
  if (ctx.signal.aborted) throw new Error('aborted');

  const topicTexts = await getLocalTopicTextsForPersona(userPersonaId);
  if (topicTexts.length === 0) {
    throw Object.assign(new Error('no-topics-configured'), { code: 'no-topics-configured' });
  }
  ctx.log(`fetching ids for ${topicTexts.length} topics`);

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
  const serverIdSet = new Set(serverArticleIds);
  const toDeleteIds = localIds.filter((id) => !serverIdSet.has(id));

  const deletedStale = toDeleteIds.length
    ? await deleteSuggestionsByServerIds(toDeleteIds)
    : 0;
  const deletedExpired = await deleteExpiredSuggestions();
  const deletedCount = deletedStale + deletedExpired;
  if (deletedCount > 0) {
    ctx.log(`deleted ${deletedCount} stale rows`);
  }

  const localIdSet = new Set(localIds);
  const missingIds = serverArticleIds.filter((id) => !localIdSet.has(id));
  ctx.log(`${missingIds.length} missing ids to hydrate`);

  return { serverArticleIds, articleToTopicTexts, missingIds, deletedCount };
}

export async function stepHydrate(
  diffResult: DiffResult,
  ctx: TaskContext,
  onProgress: (completed: number, total: number) => void,
): Promise<HydrateResult> {
  if (ctx.signal.aborted) throw new Error('aborted');

  const { missingIds, articleToTopicTexts } = diffResult;
  const fetched = missingIds.length
    ? await withRetry(
        () => ArticleService.getArticlesForTopicsByIds(missingIds, onProgress),
        ctx.signal,
      )
    : [];
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

async function getLocalTopicTextsForPersona(serverPersonaId: string): Promise<string[]> {
  const personasCol = database.get<UserPersonaModel>('user_personas');
  const personas = await personasCol.query(Q.where('server_id', serverPersonaId)).fetch();
  if (personas.length === 0) return [];

  const localPersonaId = personas[0].id;
  const topicsCol = database.get<UserTopicModel>('user_topics');
  const topics = await topicsCol.query(Q.where('user_persona_id', localPersonaId)).fetch();

  return topics
    .map((t) => t.newsTopicText)
    .filter((text): text is string => typeof text === 'string' && text.length > 0);
}

async function markIneligibleArticlesAsScored(): Promise<number> {
  const candidates = await getUnscoredSuggestionsWithFacts();
  const ineligible = candidates.filter(
    (c) => !c.titleEn || !c.descriptionEn || c.relatedFacts.length === 0,
  );
  if (ineligible.length === 0) return 0;
  await Promise.all(
    ineligible.map((c) =>
      saveScoringResult(c.id, { relevance: 0, reason: '', reasonSkipped: true }),
    ),
  );
  return ineligible.length;
}

async function withRetry<T>(
  op: () => Promise<T>,
  signal: AbortSignal,
  maxRetries = 3,
): Promise<T> {
  let delay = 100;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (signal.aborted) throw new Error('aborted');
    try {
      return await op();
    } catch (err) {
      if (signal.aborted) throw new Error('aborted');
      if (attempt === maxRetries) throw err;
      logger.warn(`[feed-sync-steps] retry ${attempt + 1}/${maxRetries}`);
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay *= 2;
    }
  }
  throw new Error('[feed-sync-steps] withRetry: unexpected exit');
}
