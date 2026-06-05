// SuggestionSyncService — the single entry point for keeping the local feed
// aligned with the server's 24h window and scoring unscored rows.
//
// Flow:
//   1. Read local topic texts for this persona.
//   2. Fetch article IDs from server (cached 30 min server-side).
//   3. Diff against local DB — delete stale rows, hydrate missing records.
//   4. Persist new rows with relevance / reason = NULL.
//   5. Link each new row to matching local facts via article_suggestion_facts.
//   6. Score every unscored row (or submit to cloud inference job).
//   7. Refresh the Zustand store from DB so the feed re-renders.

import { ArticleService } from '@/lib/article-service';
import {
  deleteSuggestionsByServerIds,
  deleteExpiredSuggestions,
  getLocalSuggestionServerIds,
  getUnscoredSuggestionsWithFacts,
  loadSuggestions,
  persistAndLinkV2Suggestions,
  persistFeedMetadata,
  saveScoringResult,
} from '@/lib/database/services/article-suggestion-service';
import database from '@/lib/database';
import { Q } from '@nozbe/watermelondb';
import type UserPersonaModel from '@/lib/database/models/UserPersona';
import type UserTopicModel from '@/lib/database/models/UserTopic';
import logger from '@/lib/logger';
import { initBaseModel } from '@/lib/mera-protocol-toolkit';
import { processAllUnscored } from '@/lib/mera-protocol/scoring-service';
import { runBackgroundCycle } from '@/lib/background/run-inference-handler';
import { useDatabaseStore } from '@/lib/stores/database-store';
import { useForYouStore } from '@/lib/stores/for-you-store';
import { useMeraProtocolStore } from '@/lib/stores/mera-protocol-store';
import { ProcessingMode } from '@/lib/generated/graphql-types';
import { useOnDeviceBannerStore } from '@/lib/stores/on-device-banner-store';
import { useUserStore } from '@/lib/stores/user-store';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';

const KEEP_AWAKE_TAG = 'mera-scoring-pass';

export interface SyncFeedResult {
  deletedCount: number;
  insertedCount: number;
  linkedCount: number;
  scoredCount: number;
  noisyDiscardedCount: number;
}

/**
 * Single-flight guard — true while a sync is running. Lives in memory via
 * useDatabaseStore so a mid-sync crash can't leave a stuck lock: the Zustand
 * store is zeroed on every cold start.
 */
export function isSyncInProgress(): boolean {
  return useDatabaseStore.getState().syncInProgress;
}

/**
 * Top-level sync entry point. Sends local topic texts to the server and
 * fetches matching article IDs (server caches results for 30 min), then
 * hydrates only the records not yet in the local DB.
 */
export async function runSync(
  userPersonaId: string,
): Promise<SyncFeedResult | null> {
  return syncFeed(userPersonaId);
}

/**
 * Sync the feed for the given persona. Sends topic texts to the server,
 * diffs against the local DB, hydrates missing records, and scores unscored rows.
 */
export async function syncFeed(
  userPersonaId: string,
): Promise<SyncFeedResult | null> {
  const dbState = useDatabaseStore.getState();
  if (!dbState.ready) {
    logger.warn('[SuggestionSyncService] database not ready — skipping sync');
    return null;
  }
  if (dbState.syncInProgress) {
    logger.warn('[SuggestionSyncService] sync already in progress — skipping');
    return null;
  }
  useDatabaseStore.getState().setSyncInProgress(true);

  useForYouStore.getState().setSyncStatus('syncing');
  await activateKeepAwakeAsync(KEEP_AWAKE_TAG);

  try {
    // 1. Read local topic texts for this persona
    const topicTexts = await getLocalTopicTextsForPersona(userPersonaId);
    if (topicTexts.length === 0) {
      logger.info('[syncFeed] no local topics — skipping');
      useForYouStore.getState().setSyncStatus('idle');
      return { deletedCount: 0, insertedCount: 0, linkedCount: 0, scoredCount: 0, noisyDiscardedCount: 0 };
    }
    logger.info(`[syncFeed] syncing ${topicTexts.length} topics`);

    // 2. Fetch article IDs from server (first page per topic, no cursor)
    const idsResponse = await withRetry(() =>
      ArticleService.getArticleIdsForTopics(
        topicTexts.map((text) => ({ topicText: text })),
        { limitPerTopic: 20 },
      ),
    );

    // Build topicText → articleIds and reverse map articleId → topicTexts[]
    const articleToTopicTexts = new Map<string, string[]>();
    for (const result of idsResponse.results) {
      for (const id of result.articleIds) {
        const existing = articleToTopicTexts.get(id) ?? [];
        existing.push(result.topicText);
        articleToTopicTexts.set(id, existing);
      }
    }
    const serverArticleIds = [...articleToTopicTexts.keys()];
    logger.info(`[syncFeed] server returned ${serverArticleIds.length} unique article ids`);

    // 3. Diff: delete stale local rows
    const localIds = await getLocalSuggestionServerIds();
    const serverIdSet = new Set(serverArticleIds);
    const toDeleteIds = localIds.filter((id) => !serverIdSet.has(id));
    const deletedCount = toDeleteIds.length
      ? await deleteSuggestionsByServerIds(toDeleteIds)
      : 0;

    // Also run TTL sweep
    const expiredCount = await deleteExpiredSuggestions();
    if (deletedCount + expiredCount > 0) {
      logger.info(`[syncFeed] deleted ${deletedCount + expiredCount} stale rows`);
    }

    // 4. Fetch full records for IDs we don't have locally
    const localIdSet = new Set(localIds);
    const missingIds = serverArticleIds.filter((id) => !localIdSet.has(id));
    logger.info(`[syncFeed] fetching ${missingIds.length} missing records`);

    const fetched = missingIds.length
      ? await withRetry(() =>
          ArticleService.getArticlesForTopicsByIds(
            missingIds,
            (completed, total) =>
              useForYouStore.getState().setHydrationProgress(completed, total),
          ),
        )
      : [];
    useForYouStore.getState().resetHydrationProgress();
    logger.info(`[syncFeed] received ${fetched.length} full records`);

    // 5. Persist and link facts
    useForYouStore.getState().setSyncStatus('filtering-noise');
    const { insertedCount, linkedCount } = await persistAndLinkV2Suggestions(
      fetched,
      articleToTopicTexts,
    );

    // 5b. Pre-score articles the scoring service would permanently skip.
    const ineligibleCount = await markIneligibleArticlesAsScored();
    if (ineligibleCount > 0) {
      logger.info(`[syncFeed] pre-scored ${ineligibleCount} ineligible articles (no desc/facts)`);
    }

    // 6. Score every unscored row
    const scoredCount = await runScoringPass();

    // 7. Refresh store and persist metadata
    await refreshSuggestionsInStore();
    const afterStore = useForYouStore.getState();
    persistFeedMetadata({
      articleCount: afterStore.articleCount,
      relevantArticleCount: afterStore.relevantArticleCount,
      hasGeneratedTopics: afterStore.hasGeneratedTopics,
    }).catch((err: unknown) =>
      logger.captureException(err, { tags: { service: 'SuggestionSyncService' } }),
    );

    useForYouStore.getState().setSyncStatus('idle');
    useForYouStore.getState().setLastSyncAt(Date.now());

    return { deletedCount: deletedCount + expiredCount, insertedCount, linkedCount, scoredCount, noisyDiscardedCount: 0 };
  } catch (error) {
    logger.captureException(error, {
      tags: { service: 'SuggestionSyncService', method: 'syncFeed' },
    });

    const msg = error instanceof Error ? error.message : String(error);
    if (msg.includes('UserPersona not found')) {
      useUserStore.getState().setUserPersona(null);
    }

    useForYouStore.getState().setSyncStatus('error', msg);
    return null;
  } finally {
    useForYouStore.getState().resetHydrationProgress();
    deactivateKeepAwake(KEEP_AWAKE_TAG);
    useDatabaseStore.getState().setSyncInProgress(false);
  }
}

/**
 * Score every currently unscored cluster_suggestion row. Safe to call on its
 * own — invoked by syncFeed after persistence, and can be used by callers that
 * want to re-score without going through a full server sync.
 *
 * After every batch we reload the full suggestion list from the DB and push it
 * into the store. This way freshly-fetched-and-scored rows appear in the feed
 * mid-sync, not just at the end.
 */
export async function runScoringPass(batchSize = 20): Promise<number> {
  useForYouStore.getState().setSyncStatus('scoring');

  const onDevice =
    useMeraProtocolStore.getState().processingMode === ProcessingMode.OnDevice;

  if (!onDevice) {
    try {
      await runBackgroundCycle('scoring-pass');
    } catch (err) {
      logger.captureException(err, {
        tags: { service: 'SuggestionSyncService', method: 'runScoringPass.async' },
      });
    }
    return 0;
  }

  useForYouStore.getState().startDeviceProcessing(0);
  useOnDeviceBannerStore.getState().show();
  try {
    if (useMeraProtocolStore.getState().modelState !== 'ready') {
      useMeraProtocolStore.getState().setModelState('loading');
      await initBaseModel();
      useMeraProtocolStore.getState().setModelState('ready');
    }

    const onBatchComplete = () => {
      refreshSuggestionsInStore().catch((err: unknown) =>
        logger.captureException(err, {
          tags: { service: 'SuggestionSyncService', method: 'runScoringPass.refresh' },
        }),
      );
    };

    const onProgress = (completed: number, total: number) => {
      useForYouStore.getState().updateDeviceProgress(completed, total);
    };

    const scored = await processAllUnscored(onProgress, batchSize, onBatchComplete);
    useForYouStore.getState().markProcessingRunFinished();
    return scored;
  } catch (error) {
    logger.captureException(error, {
      tags: { service: 'SuggestionSyncService', method: 'runScoringPass' },
    });
    throw error;
  } finally {
    useForYouStore.getState().finishDeviceProcessing();
    useOnDeviceBannerStore.getState().hide();
  }
}

/** Exposed so the async reconciler can push fresh scores into the store
 *  without reaching into private module state. */
export async function refreshSuggestionsInStoreUnsafe(): Promise<void> {
  return refreshSuggestionsInStore();
}

// --- Internal helpers ---

const RELEVANCE_DISPLAY_THRESHOLD = 0.3;

async function refreshSuggestionsInStore(): Promise<void> {
  const suggestions = await loadSuggestions();
  suggestions.sort(byRelevanceDesc);

  let relevantArticleCount = 0;
  let unscoredCount = 0;
  for (const s of suggestions) {
    if (!s.relevanceGenerationCompleted) {
      unscoredCount++;
    } else if (s.relevance > RELEVANCE_DISPLAY_THRESHOLD) {
      relevantArticleCount++;
    }
  }

  useForYouStore.setState({
    suggestions,
    relevantArticleCount,
    unscoredCount,
    endCursor: null,
    hasNextPage: true,
  });
}

function byRelevanceDesc(
  a: { relevance: number; relevanceGenerationCompleted: boolean },
  b: { relevance: number; relevanceGenerationCompleted: boolean },
): number {
  const av = a.relevanceGenerationCompleted ? a.relevance : -Infinity;
  const bv = b.relevanceGenerationCompleted ? b.relevance : -Infinity;
  return bv - av;
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

async function getLocalTopicTextsForPersona(serverPersonaId: string): Promise<string[]> {
  const personasCol = database.get<UserPersonaModel>('user_personas');
  const personas = await personasCol
    .query(Q.where('server_id', serverPersonaId))
    .fetch();
  if (personas.length === 0) return [];

  const localPersonaId = personas[0].id;
  const topicsCol = database.get<UserTopicModel>('user_topics');
  const topics = await topicsCol
    .query(Q.where('user_persona_id', localPersonaId))
    .fetch();

  return topics
    .map((t) => t.newsTopicText)
    .filter((text): text is string => typeof text === 'string' && text.length > 0);
}

async function withRetry<T>(op: () => Promise<T>, maxRetries = 3): Promise<T> {
  let delay = 100;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await op();
    } catch (err) {
      if (attempt === maxRetries) throw err;
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay *= 2;
    }
  }
  throw new Error('[SuggestionSyncService] withRetry: unexpected exit');
}
