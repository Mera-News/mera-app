// SuggestionSyncService — the single entry point for keeping the local feed
// aligned with the server's 24h window and scoring unscored rows.
//
// Flow (all idempotent):
//   1. Ask the server for the current set of suggestion ids for this persona.
//   2. Read the set of local suggestion ids.
//   3. Delete local rows whose ids are no longer in the server set.
//   4. Fetch full records for ids we don't have locally yet.
//   5. Persist new rows with relevance / reason = NULL.
//   6. Link each new row to matching local facts via article_suggestion_facts.
//   7. Score every unscored row in batches (article_suggestions.relevance IS NULL).
//   8. Refresh the Zustand store from DB so the feed re-renders.

import { ArticleService } from '@/lib/article-service';
import {
  deleteAgedOutSuggestions,
  deleteSuggestionsByServerIds,
  deleteExpiredSuggestions,
  getLocalSuggestionServerIds,
  getUnscoredSuggestionsWithFacts,
  getUnprocessedSyncedIds,
  loadSuggestions,
  persistAndLinkNewSuggestions,
  persistAndLinkV2Suggestions,
  persistFeedMetadata,
  replaceSyncedIdSet,
  saveScoringResult,
} from '@/lib/database/services/article-suggestion-service';
import database from '@/lib/database';
import { Q } from '@nozbe/watermelondb';
import type UserPersonaModel from '@/lib/database/models/UserPersona';
import type UserTopicModel from '@/lib/database/models/UserTopic';
import { getSetting, setSetting } from '@/lib/database/services/setting-service';
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

const FLOW_V2_SETTING_KEY = 'use_flow_v2';

/**
 * Top-level sync dispatcher. Reads the "Use Flow v2" toggle from local
 * settings and routes to either the stateless Flow v2 path (syncFeedV2) or
 * the original suggestion-pipeline path (syncFeed).
 */
export async function runSync(
  userPersonaId: string,
  opts: { force?: boolean } = {},
): Promise<SyncFeedResult | null> {
  const useV2 = (await getSetting(FLOW_V2_SETTING_KEY)) === 'true';
  if (useV2) return syncFeedV2(userPersonaId);
  return syncFeed(userPersonaId, opts);
}

const SYNCED_IDS_LAST_FETCHED_KEY = 'synced_ids_last_fetched_at';
// Short throttle: deletions on the server must propagate to the device on the
// next poll, not an hour later. The IDs query returns only string ids and is
// cheap; 60 s just coalesces rapid back-to-back sync calls.
const SYNCED_IDS_TTL_MS = 60 * 1000;

/**
 * Run the full sync flow. Returns null if another sync is already in progress
 * or the database hasn't finished bootstrapping (migration still running).
 *
 * `force: true` (Process button) bypasses the throttle on the
 * `unscoredArticleSuggestionIds` query. The silent push leaves it false;
 * the query then runs only if the cached set is older than the TTL
 * (`SYNCED_IDS_TTL_MS`, currently 60 s — short enough that server-side
 * deletions propagate on the next poll).
 */
export async function syncFeed(
  userPersonaId: string,
  opts: { force?: boolean } = {},
): Promise<SyncFeedResult | null> {
  const dbState = useDatabaseStore.getState();
  if (!dbState.ready) {
    logger.warn('[SuggestionSyncService] database not ready yet — skipping sync');
    return null;
  }
  if (dbState.syncInProgress) {
    logger.warn('[SuggestionSyncService] sync already in progress — skipping');
    return null;
  }
  useDatabaseStore.getState().setSyncInProgress(true);

  const store = useForYouStore.getState();
  store.setSyncStatus('syncing');
  await activateKeepAwakeAsync(KEEP_AWAKE_TAG);

  let deletedCount = 0;

  try {
    // 1. Refresh the server's id-set IF we're allowed to (cycle is idle, AND
    //    either Process forced it or the cached set is older than the TTL).
    //    Mutations
    //    to article_suggestions are gated on cycle == idle elsewhere too;
    //    `replaceSyncedIdSet` only writes to its own table so it's always
    //    safe even mid-cycle, but we tie both calls together for clarity.
    const cycleIdle = useForYouStore.getState().asyncJobPhase === 'idle';
    const lastFetchedRaw = await getSetting(SYNCED_IDS_LAST_FETCHED_KEY);
    const lastFetchedAt = lastFetchedRaw ? Number(lastFetchedRaw) : 0;
    const ageMs = Date.now() - lastFetchedAt;
    const shouldFetchIds =
      cycleIdle && (opts.force === true || ageMs >= SYNCED_IDS_TTL_MS);

    if (shouldFetchIds) {
      const rawCurrentIds = await withRetry(() =>
        ArticleService.getUnscoredArticleSuggestionIds(userPersonaId),
      );
      const dedupedIds = [...new Set(rawCurrentIds)];
      await replaceSyncedIdSet(dedupedIds);
      await setSetting(SYNCED_IDS_LAST_FETCHED_KEY, String(Date.now()));

      logger.info(
        `[syncFeed] server returned ${dedupedIds.length} ids (raw=${rawCurrentIds.length})`,
      );

      // Cleanup: drop local article_suggestions that the server no longer
      // owns. `unscoredArticleSuggestionIds` is the authoritative set for the
      // user's 24h window, so anything local-but-not-in-server is stale
      // (deleted server-side or aged out). Tapping a stale row would 404 on
      // detail open, so propagating deletes keeps the feed honest.
      // The TTL sweep is kept as a belt-and-braces guard for rows that
      // somehow escape the set-difference pass.
      // Safe here: gated on cycleIdle above, so the inference cycle isn't
      // touching article_suggestions concurrently.
      const agedOutCount = await deleteAgedOutSuggestions();
      const expiredCount = await deleteExpiredSuggestions();
      deletedCount = agedOutCount + expiredCount;
      if (deletedCount > 0) {
        logger.info(
          `[syncFeed] cleanup removed ${deletedCount} rows (server-diff=${agedOutCount}, ttl=${expiredCount})`,
        );
      }
    } else {
      const reason = !cycleIdle
        ? 'cycle in flight'
        : `cached ${Math.round(ageMs / 1000)}s ago`;
      logger.info(`[syncFeed] skipping IDs query — ${reason}`);
    }

    // 2. Hydrate every synced id we don't have locally — one shot, no cap.
    const idsToFetch = await getUnprocessedSyncedIds();
    logger.info(`[syncFeed] hydrating ${idsToFetch.length} unprocessed ids`);

    const fetched = idsToFetch.length
      ? await withRetry(() =>
          ArticleService.getUnscoredArticleSuggestionsByIds(
            userPersonaId,
            idsToFetch,
            (completed, total) =>
              useForYouStore.getState().setHydrationProgress(completed, total),
          ),
        )
      : [];
    useForYouStore.getState().resetHydrationProgress();
    logger.info(
      `[syncFeed] received ${fetched.length} full records from server`,
    );

    // 3 + 4. Persist new rows AND link facts in one atomic write.
    useForYouStore.getState().setSyncStatus('filtering-noise');
    const { insertedCount, linkedCount, noisyDiscardedCount } =
      await persistAndLinkNewSuggestions(fetched);
    // DEPRECATED: noise injection UI — see deprecate-article-suggestion-flow.md
    // useForYouStore.getState().setNoisyDiscardedCount(noisyDiscardedCount);
    // if (noisyDiscardedCount > 0) {
    //   logger.info(`[syncFeed] noise removal discarded ${noisyDiscardedCount} cluster(s)`);
    // }
    void noisyDiscardedCount;

    // 7. Score every unscored row (and sweep-retry any previously-scored
    //    rows whose reason step failed — folded into processAllUnscored).
    const scoredCount = await runScoringPass();

    // 8. Final authoritative refresh from DB (scoring may have finished
    //    partway through; this guarantees the last batch's writes are visible).
    //    Also persist feed_metadata so the next cold start renders sensible
    //    counts before its sync completes.
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

    return { deletedCount, insertedCount, linkedCount, scoredCount, noisyDiscardedCount };
  } catch (error) {
    logger.captureException(error, {
      tags: { service: 'SuggestionSyncService', method: 'syncFeed' },
    });

    // If the server says the persona no longer exists, clear the stale cached
    // persona so the next poll re-fetches a fresh one instead of looping on 404.
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
 * [Flow v2] Stateless sync — the app sends its topic texts directly; the
 * server returns matching article IDs (cached 30 min server-side) and the app
 * hydrates only the records it doesn't already have locally.
 *
 * Mirrors the two-step ID-diff + hydrate pattern of `syncFeed` but without
 * the `unscoredArticleSuggestionIds` / `synced_suggestion_ids` machinery.
 * Gated behind the "Use Flow v2" toggle in the Mera Protocol settings screen.
 */
export async function syncFeedV2(
  userPersonaId: string,
): Promise<SyncFeedResult | null> {
  const dbState = useDatabaseStore.getState();
  if (!dbState.ready) {
    logger.warn('[SuggestionSyncService] database not ready — skipping v2 sync');
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
    // Clear stale v1 synced-ids so async-job-reconciler doesn't warn about
    // 'unprocessed ids' left over from before the v2 switch.
    await replaceSyncedIdSet([]);

    // 1. Read local topic texts for this persona
    const topicTexts = await getLocalTopicTextsForPersona(userPersonaId);
    if (topicTexts.length === 0) {
      logger.info('[syncFeedV2] no local topics — skipping');
      useForYouStore.getState().setSyncStatus('idle');
      return { deletedCount: 0, insertedCount: 0, linkedCount: 0, scoredCount: 0, noisyDiscardedCount: 0 };
    }
    logger.info(`[syncFeedV2] syncing ${topicTexts.length} topics`);

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
    logger.info(`[syncFeedV2] server returned ${serverArticleIds.length} unique article ids`);

    // 3. Diff: delete stale local rows
    const localIds = await getLocalSuggestionServerIds();
    const serverIdSet = new Set(serverArticleIds);
    const toDeleteIds = localIds.filter((id) => !serverIdSet.has(id));
    const deletedCount = toDeleteIds.length
      ? await deleteSuggestionsByServerIds(toDeleteIds)
      : 0;
    if (deletedCount > 0) logger.info(`[syncFeedV2] deleted ${deletedCount} stale rows`);

    // 4. Fetch full records for IDs we don't have locally
    const localIdSet = new Set(localIds);
    const missingIds = serverArticleIds.filter((id) => !localIdSet.has(id));
    logger.info(`[syncFeedV2] fetching ${missingIds.length} missing records`);

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
    logger.info(`[syncFeedV2] received ${fetched.length} full records`);

    // 5. Persist and link facts
    useForYouStore.getState().setSyncStatus('filtering-noise');
    const { insertedCount, linkedCount } = await persistAndLinkV2Suggestions(
      fetched,
      articleToTopicTexts,
    );

    // 5b. Pre-score articles the scoring service would permanently skip.
    // isEligible requires titleEn && descriptionEn && relatedFacts.length > 0.
    // Articles missing a description or with no linked user facts will never pass
    // and would accumulate as stuck unscored rows. Mark them relevance=0 now.
    const ineligibleCount = await markIneligibleV2ArticlesAsScored();
    if (ineligibleCount > 0) {
      logger.info(`[syncFeedV2] pre-scored ${ineligibleCount} ineligible articles (no desc/facts)`);
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

    return { deletedCount, insertedCount, linkedCount, scoredCount, noisyDiscardedCount: 0 };
  } catch (error) {
    logger.captureException(error, {
      tags: { service: 'SuggestionSyncService', method: 'syncFeedV2' },
    });
    const msg = error instanceof Error ? error.message : String(error);
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
 * mid-sync, not just at the end. Relying on the store's `applyScoreUpdates`
 * patch path wouldn't work: it only mutates rows that are already in the
 * store, but the newly fetched rows from this sync aren't in the store until
 * refreshSuggestionsInStore() runs.
 */
export async function runScoringPass(batchSize = 20): Promise<number> {
  useForYouStore.getState().setSyncStatus('scoring');

  const onDevice =
    useMeraProtocolStore.getState().processingMode === ProcessingMode.OnDevice;

  // Cloud path — route through the unified inference handler. That way every
  // trigger (auto-poll tick, pull-to-refresh, mount sync) will RECONCILE a
  // pending async job before attempting a new submit. Plain
  // `submitInferenceJob` would just return 'skipped-pending' when there's an
  // open job and leave the feed stale.
  if (!onDevice) {
    try {
      await runBackgroundCycle('scoring-pass');
    } catch (err) {
      logger.captureException(err, {
        tags: { service: 'SuggestionSyncService', method: 'runScoringPass.async' },
      });
    }
    // 0 means "no rows scored *synchronously* in this call" — caller's return
    // contract stays. Rows will appear via the reconciler's store refresh.
    return 0;
  }

  // On-device path — foreground only. Show the warning banner while scoring.
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

/**
 * Reload suggestions from DB and derive the locally-owned counters:
 *   relevantArticleCount = count with relevanceGenerationCompleted && relevance > 0.3
 *   unscoredCount        = count with !relevanceGenerationCompleted
 *
 * `articleCount` (total articles system-wide today) comes from the server and
 * is set separately in syncFeed step 1 — not touched here. Called after every
 * scoring batch and at the end of sync so the ForYou page updates incrementally.
 */
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

/**
 * After v2 persist, mark articles that the scoring service would permanently
 * skip (no description or no linked facts) as pre-scored with relevance=0.
 * Mirrors the isEligible check in scoring-service.ts so they never appear as
 * stuck unscored candidates.
 */
async function markIneligibleV2ArticlesAsScored(): Promise<number> {
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
