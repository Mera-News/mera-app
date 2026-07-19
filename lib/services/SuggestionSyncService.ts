// SuggestionSyncService — scoring and store-refresh helpers.
// Full sync logic has moved to lib/scheduler/feed-sync/ (FeedSyncMachine).

import {
  loadSuggestions,
} from '@/lib/database/services/article-suggestion-service';
import { ArticleSuggestionStatus } from '@/lib/database/article-suggestion-status';
import type {
  ForYouSuggestion,
  ClusterMembership,
  MatchedTopicRef,
} from '@/lib/stores/for-you-store';
import { classifyScoringError } from '@/lib/services/scoring-error';
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
    const setScoringError = useForYouStore.getState().setScoringError;

    let result: Awaited<ReturnType<typeof runBackgroundCycle>>;
    try {
      result = await runBackgroundCycle('scoring-pass');
    } catch (err) {
      logger.captureException(err, {
        tags: { service: 'SuggestionSyncService', method: 'runScoringPass.cycle' },
      });
      // Surface the failure in the header status row immediately (every failure,
      // no waiting). Cleared when the next sync cycle starts.
      setScoringError(classifyScoringError());
      throw err; // surface to FeedSyncMachine so the failed stage is recorded
    }

    if (result === 'error') {
      // Transient backend failure (network error, server down, expired endpoint).
      // Log it but let the sync complete so articles are at least persisted.
      // inference-recover will attempt scoring again on the next foreground.
      // Surface it in the header status row so the user knows the pipeline stalled.
      logger.captureMessage('[runScoringPass] cloud inference cycle returned error — transient, sync will complete', {
        level: 'warning',
        tags: { service: 'SuggestionSyncService', method: 'runScoringPass' },
      });
      setScoringError(classifyScoringError());
      return 0;
    }

    // `running` (batches enqueued / in flight) and `idle` (nothing left to
    // score) both mean the pipeline accepted the pass without a hard failure —
    // clear the header error. Set on hard failure, cleared on success/progress.
    setScoringError(null);
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

    // Progressive rendering during scoring: coalesce the per-batch refreshes so
    // rapid batches don't each rebuild + replace the whole suggestion array on
    // the JS thread. The trailing flush below guarantees the final batch lands.
    const onBatchComplete = () => {
      void requestSuggestionsRefresh();
    };

    const onProgress = (completed: number, total: number) => {
      useForYouStore.getState().updateDeviceProgress(completed, total);
    };

    const scored = await processAllUnscored(onProgress, batchSize, onBatchComplete);
    // Terminal exactness: cancel any pending throttled refresh and reflect the
    // final DB state before the run is marked finished.
    await flushSuggestionsRefresh();
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

// --- A1: coalesced store-refresh (leading + trailing throttle) ---
//
// Feed-sync hydrates in 25-item chunks and the on-device scorer completes many
// batches in quick succession — each previously triggered a full reload + sort
// + whole-array replace on the JS thread. `requestSuggestionsRefresh` coalesces
// those bursts: the first call in an idle window runs immediately (so the first
// hydrated chunk paints instantly), calls within the window collapse into a
// single trailing execution, and a trailing timer guarantees the final chunk
// always lands. Overlapping executions are serialized (never concurrent) so two
// reloads can't interleave their store writes.

export const REFRESH_MIN_INTERVAL_MS = 1500;

/** Wall-clock ms when the most recent refresh execution STARTED. */
let lastRefreshStart = 0;
/** Pending trailing execution timer, or null when none is scheduled. */
let trailingTimer: ReturnType<typeof setTimeout> | null = null;
/** In-flight refresh execution (serialization guard), or null when idle. */
let refreshInFlight: Promise<void> | null = null;
/** A refresh was requested while one was already running — coalesce into one
 *  extra pass so the latest DB state is always reflected. */
let rerunRequested = false;

/** Run one store refresh, swallowing + logging errors so throttle callers never
 *  see a rejection (progressive rendering is fire-and-forget). */
async function executeRefreshOnce(): Promise<void> {
  try {
    await refreshSuggestionsInStore();
  } catch (err) {
    logger.captureException(err, {
      tags: { service: 'SuggestionSyncService', method: 'requestSuggestionsRefresh' },
    });
  }
}

/** Execute a refresh, serializing against any in-flight one. If a refresh is
 *  already running, mark a re-run and join it rather than running concurrently. */
function runRefreshSerialized(): Promise<void> {
  if (refreshInFlight) {
    rerunRequested = true;
    return refreshInFlight;
  }
  lastRefreshStart = Date.now();
  refreshInFlight = (async () => {
    try {
      await executeRefreshOnce();
      // Coalesce requests that arrived mid-flight into exactly one more pass.
      while (rerunRequested) {
        rerunRequested = false;
        lastRefreshStart = Date.now();
        await executeRefreshOnce();
      }
    } finally {
      refreshInFlight = null;
    }
  })();
  return refreshInFlight;
}

/**
 * Coalesced, identity-preserving store refresh. Leading call in an idle window
 * runs immediately; calls within `REFRESH_MIN_INTERVAL_MS` collapse into one
 * trailing execution. Never rejects.
 */
export function requestSuggestionsRefresh(): Promise<void> {
  const elapsed = Date.now() - lastRefreshStart;
  if (elapsed >= REFRESH_MIN_INTERVAL_MS && !refreshInFlight) {
    // Leading edge — run now so the first chunk appears instantly.
    if (trailingTimer) {
      clearTimeout(trailingTimer);
      trailingTimer = null;
    }
    return runRefreshSerialized();
  }
  // Inside the window (or a refresh is running) — ensure a single trailing
  // execution is scheduled so the final coalesced state always lands.
  if (!trailingTimer) {
    const delay = Math.max(REFRESH_MIN_INTERVAL_MS - elapsed, 0);
    trailingTimer = setTimeout(() => {
      trailingTimer = null;
      void runRefreshSerialized();
    }, delay);
  }
  return Promise.resolve();
}

/**
 * Cancel any pending trailing refresh and reflect the final DB state now, so a
 * terminal state (hydrate/scoring done, abort, error) is always exact. When
 * nothing is pending and nothing is in flight the last refresh already reflects
 * current state, so this is a no-op. Never rejects.
 */
export function flushSuggestionsRefresh(): Promise<void> {
  const hadPending = trailingTimer !== null;
  if (trailingTimer) {
    clearTimeout(trailingTimer);
    trailingTimer = null;
  }
  if (hadPending || refreshInFlight) {
    return runRefreshSerialized();
  }
  return Promise.resolve();
}

/** Test-only: reset the throttle module state between specs. @internal */
export function __resetSuggestionsRefreshThrottleForTests(): void {
  if (trailingTimer) clearTimeout(trailingTimer);
  trailingTimer = null;
  refreshInFlight = null;
  rerunRequested = false;
  lastRefreshStart = 0;
}

// --- Internal helpers ---

const RELEVANCE_DISPLAY_THRESHOLD = 0.3;

async function refreshSuggestionsInStore(): Promise<void> {
  const suggestions = await loadSuggestions();
  suggestions.sort(byRelevanceDesc);

  // A1 identity-preserving merge: reuse the previous object reference for any
  // row whose display-relevant fields are all unchanged, so ArticleCard's memo
  // skips re-rendering untouched cards. Sorting + derived counts still recompute
  // from the fresh values below (identical, since the merge only swaps refs).
  const prev = useForYouStore.getState().suggestions as ForYouSuggestion[] | undefined;
  const merged =
    prev && prev.length > 0 ? mergePreservingIdentity(prev, suggestions) : suggestions;

  let relevantArticleCount = 0;
  let unscoredCount = 0;
  for (const s of merged) {
    if (s.status === ArticleSuggestionStatus.Unscored) {
      unscoredCount++;
    } else if (s.relevance > RELEVANCE_DISPLAY_THRESHOLD) {
      relevantArticleCount++;
    }
  }

  useForYouStore.setState({
    suggestions: merged,
    unscoredCount,
    endCursor: null,
    hasNextPage: true,
  });
  // Preserve the server-provided articleCount set by FeedSyncMachine; only
  // update relevantArticleCount. Fall back to suggestions.length when there
  // is no server count yet (e.g. a standalone scoring pass after a fresh wipe).
  const { articleCount } = useForYouStore.getState();
  useForYouStore.getState().setCounts(articleCount || merged.length, relevantArticleCount);
}

/**
 * Reuse the previous ForYouSuggestion object reference whenever every field a
 * consumer reads is unchanged. Because reusing the reference reverts the whole
 * object to its prior values, `suggestionsDisplayEqual` MUST cover EVERY field
 * (missing one = stale UI). Rows without a stable `_id` (e.g. test fixtures) are
 * always treated as new.
 */
function mergePreservingIdentity(
  prev: ForYouSuggestion[],
  next: ForYouSuggestion[],
): ForYouSuggestion[] {
  const prevById = new Map<string, ForYouSuggestion>();
  for (const p of prev) {
    if (p && p._id) prevById.set(p._id, p);
  }
  return next.map((n) => {
    if (!n._id) return n;
    const p = prevById.get(n._id);
    return p && suggestionsDisplayEqual(p, n) ? p : n;
  });
}

function clustersSig(clusters: ClusterMembership[] | undefined): string {
  if (!clusters || clusters.length === 0) return '';
  return clusters
    .map((c) => `${c.clusterId}:${c.confidence}:${c.stableClusterId ?? ''}`)
    .join(',');
}

function topicIdsSig(ids: string[] | undefined): string {
  return ids && ids.length > 0 ? ids.join(',') : '';
}

function matchedTopicsSig(matched: MatchedTopicRef[] | undefined): string {
  if (!matched || matched.length === 0) return '';
  return matched.map((m) => `${m.topicId ?? ''}:${m.text}`).join('|');
}

/** True when a and b are equal across every field any consumer (ArticleCard,
 *  ArticleSuggestionContainer, ArticleMetaRow, and the fact-sectioned feed
 *  selector) reads. Deliberately exhaustive over ForYouSuggestion. */
function suggestionsDisplayEqual(a: ForYouSuggestion, b: ForYouSuggestion): boolean {
  return (
    a.articleId === b.articleId &&
    a.status === b.status &&
    a.relevance === b.relevance &&
    a.reason === b.reason &&
    a.title_en === b.title_en &&
    a.title_original === b.title_original &&
    a.description_en === b.description_en &&
    a.article_url === b.article_url &&
    a.image_url === b.image_url &&
    a.publication_name === b.publication_name &&
    a.country_code === b.country_code &&
    a.language_code === b.language_code &&
    a.createdAt === b.createdAt &&
    a.firstPubDate === b.firstPubDate &&
    a.rawScore === b.rawScore &&
    a.eventType === b.eventType &&
    a.headlineScope === b.headlineScope &&
    clustersSig(a.clusters) === clustersSig(b.clusters) &&
    topicIdsSig(a.userTopicIds) === topicIdsSig(b.userTopicIds) &&
    matchedTopicsSig(a.matchedTopics) === matchedTopicsSig(b.matchedTopics)
  );
}

function byRelevanceDesc(
  a: { relevance: number; status: ArticleSuggestionStatus },
  b: { relevance: number; status: ArticleSuggestionStatus },
): number {
  const av = a.status !== ArticleSuggestionStatus.Unscored ? a.relevance : -Infinity;
  const bv = b.status !== ArticleSuggestionStatus.Unscored ? b.relevance : -Infinity;
  return bv - av;
}
