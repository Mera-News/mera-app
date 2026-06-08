// SuggestionSyncService — scoring and store-refresh helpers.
// Full sync logic has moved to lib/scheduler/feed-sync/ (FeedSyncMachine).

import {
  loadSuggestions,
  getUnscoredSuggestionsWithFacts,
  saveScoringResult,
} from '@/lib/database/services/article-suggestion-service';
import logger from '@/lib/logger';
import { initBaseModel } from '@/lib/mera-protocol-toolkit';
import { processAllUnscored } from '@/lib/mera-protocol/scoring-service';
import { runBackgroundCycle } from '@/lib/background/run-inference-handler';
import { useForYouStore } from '@/lib/stores/for-you-store';
import { useMeraProtocolStore } from '@/lib/stores/mera-protocol-store';
import { ProcessingMode } from '@/lib/generated/graphql-types';
import { useOnDeviceBannerStore } from '@/lib/stores/on-device-banner-store';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';

const KEEP_AWAKE_TAG = 'mera-scoring-pass';

/**
 * Score every currently unscored article_suggestion row.
 * Called from FeedSyncMachine.stepScore and can be re-used by callers
 * that want to re-score without going through a full server sync.
 *
 * After every batch we reload the full suggestion list from the DB and push it
 * into the store so freshly-scored rows appear in the feed mid-run.
 */
export async function runScoringPass(batchSize = 20): Promise<number> {
  const onDevice =
    useMeraProtocolStore.getState().processingMode === ProcessingMode.OnDevice;

  if (!onDevice) {
    let result: Awaited<ReturnType<typeof runBackgroundCycle>>;
    try {
      result = await runBackgroundCycle('scoring-pass');
    } catch (err) {
      logger.captureException(err, {
        tags: { service: 'SuggestionSyncService', method: 'runScoringPass.cycle' },
      });
      throw err; // surface to FeedSyncMachine so the failed stage is recorded
    }

    if (result === 'skipped-no-token') {
      logger.captureMessage(
        '[runScoringPass] cloud scoring skipped — no Expo push token on userPersona; sync will complete, next trigger will retry',
        {
          level: 'warning',
          tags: { service: 'SuggestionSyncService', method: 'runScoringPass' },
        },
      );
      return 0;
    }

    if (result === 'error') {
      // Transient backend failure (network error, server down, expired endpoint).
      // Log it but let the sync complete so articles are at least persisted.
      // inference-recover will attempt scoring again on the next foreground.
      logger.captureMessage('[runScoringPass] cloud inference cycle returned error — transient, sync will complete', {
        level: 'warning',
        tags: { service: 'SuggestionSyncService', method: 'runScoringPass' },
      });
      return 0;
    }

    logger.info(`[runScoringPass] cloud cycle result: ${result}`);
    return 0;
  }

  await activateKeepAwakeAsync(KEEP_AWAKE_TAG);
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
    deactivateKeepAwake(KEEP_AWAKE_TAG);
  }
}

/** Exposed so the async reconciler can push fresh scores into the store. */
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
    unscoredCount,
    endCursor: null,
    hasNextPage: true,
  });
  // Preserve the server-provided articleCount set by FeedSyncMachine; only
  // update relevantArticleCount. Fall back to suggestions.length when there
  // is no server count yet (e.g. a standalone scoring pass after a fresh wipe).
  const { articleCount } = useForYouStore.getState();
  useForYouStore.getState().setCounts(articleCount || suggestions.length, relevantArticleCount);
}

function byRelevanceDesc(
  a: { relevance: number; relevanceGenerationCompleted: boolean },
  b: { relevance: number; relevanceGenerationCompleted: boolean },
): number {
  const av = a.relevanceGenerationCompleted ? a.relevance : -Infinity;
  const bv = b.relevanceGenerationCompleted ? b.relevance : -Infinity;
  return bv - av;
}
