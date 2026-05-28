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
  deleteExpiredSuggestions,
  getUnprocessedSyncedIds,
  loadSuggestions,
  persistAndLinkNewSuggestions,
  persistFeedMetadata,
  replaceSyncedIdSet,
} from '@/lib/database/services/article-suggestion-service';
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
    // Surface the noise-removal step in the header progress bar — the persist
    // call is where the noisy-id filter runs.
    useForYouStore.getState().setSyncStatus('filtering-noise');
    const { insertedCount, linkedCount, noisyDiscardedCount } =
      await persistAndLinkNewSuggestions(fetched);
    useForYouStore.getState().setNoisyDiscardedCount(noisyDiscardedCount);
    if (noisyDiscardedCount > 0) {
      logger.info(
        `[syncFeed] noise removal discarded ${noisyDiscardedCount} cluster(s)`,
      );
    }

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
