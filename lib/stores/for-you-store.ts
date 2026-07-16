import { create } from 'zustand';
import logger from '@/lib/logger';
import {
    loadSuggestions,
    persistFeedMetadata,
    loadFeedMetadata,
    clearSuggestions,
    pruneOrphanedSuggestions,
} from '@/lib/database/services/article-suggestion-service';
import type { SyncStatusMessage } from '@/lib/scheduler/feed-sync/feed-sync-types';
import {
    ArticleSuggestionStatus,
    type ArticleSuggestionStatus as ArticleSuggestionStatusType,
} from '@/lib/database/article-suggestion-status';
import type { ScoringErrorKind } from '@/lib/services/scoring-error';

/** Article-keyed feed row hydrated from local WatermelonDB. Populated by the
 *  sync service from articlesForTopicsByIds, with client-side scoring fields.
 *
 *  `status` is the pipeline state machine (see article-suggestion-status.ts):
 *  `unscored` (relevance not generated yet; relevance=0, reason=''),
 *  `reason_pending` (scored, reason generating — UI shows loading dots; failed
 *  reason attempts stay here and are retried, with persistent pipeline failures
 *  surfaced as a toast), and `complete` (terminal: reason text present, or
 *  deliberately skipped for a sub-threshold row).
 *
 *  `clusters` is the latest list of clusters the article belongs to, each with
 *  its HDBSCAN membership confidence (0.0–1.0), refreshed every sync
 *  (overwritten unconditionally, including when empty). An article can be in
 *  multiple clusters via `cluster-article-link`. The For-You feed collapses
 *  suggestions whose dense (high-confidence) cluster cores overlap into a
 *  single representative card. The detail screen's "related articles" panel
 *  still calls `relatedArticles(articleId)` for the authoritative live
 *  cluster siblings. */
export type ClusterMembership = {
    clusterId: string;
    confidence: number;
};

export type ForYouSuggestion = {
    _id: string;
    articleId: string;
    clusters: ClusterMembership[];
    relevance: number;
    reason: string;
    status: ArticleSuggestionStatusType;
    country_code: string | null;
    language_code: string | null;
    publication_name: string | null;
    title_en: string | null;
    title_original: string | null;
    description_en: string | null;
    article_url: string | null;
    image_url: string | null;
    userTopicIds: string[];
    createdAt: string;
    firstPubDate: string;
};

/** @deprecated Use syncStatusMessage instead */
export type SyncStatus =
    | 'idle'
    | 'syncing'
    | 'filtering-noise'
    | 'scoring'
    | 'error';

export type { SyncStatusMessage };

interface ForYouState {
    // Article data
    suggestions: ForYouSuggestion[];
    articleCount: number;
    relevantArticleCount: number;
    hasGeneratedTopics: boolean;

    // Pagination state
    endCursor: string | null;
    hasNextPage: boolean;

    // Mera Protocol — on-device processing
    unscoredCount: number;
    isDeviceProcessing: boolean;
    deviceProcessProgress: number; // 0–1
    deviceProcessedCount: number;
    deviceTotalCount: number;

    // Cloud async-inference pipeline — a coarse projection of the multi-batch
    // scoring pipeline onto the header's two-phase model. 'idle' = no run (or
    // every batch terminal). 'relevance' = at least one batch still owes a
    // relevance round. 'reasons' = every remaining non-terminal batch is past
    // relevance (only notes left). Individual batches interleave; this is the
    // union view the header renders. Written live by scoring-pipeline as batches
    // transition and rehydrated at boot from the persisted run. Decouples UI
    // from `isDeviceProcessing` which only covers on-device scoring.
    asyncJobPhase: 'idle' | 'relevance' | 'reasons';
    /** Candidates in terminal (done/failed) batches — the numerator of the
     *  "Sifting through X/Y" spinner text. 0 when `asyncJobPhase === 'idle'`. */
    asyncJobProcessedCount: number;
    /** Total candidates across every batch in the current run — the
     *  denominator of the spinner text. 0 when idle. */
    asyncJobTotalCount: number;

    // Sync status — set by FeedSyncMachine, read by UI
    syncStatusMessage: SyncStatusMessage | null;
    lastSyncAt: number | null;

    // Cloud scoring pipeline error — set on every failed scoring cycle, shown in
    // the For You header status row, cleared at the start of the next sync cycle.
    // null when the pipeline is healthy / idle.
    scoringError: ScoringErrorKind | null;

    // Daily delivery cap — epoch ms of the next reset (00:00 UTC) while the
    // user is over their daily article-delivery limit, else null. Sticky:
    // set when a sync is fully blocked by the cap, cleared when a sync
    // delivers new articles or once the reset time passes. Drives a persistent
    // "limit reached" banner that survives the transient fetch/diff statuses
    // each polling cycle publishes.
    dailyLimitResetAt: number | null;

    // Hydration progress — number of article-suggestion records fetched from
    // the server during a syncFeed pass. Drives a progress bar in the For You
    // header for users with large id sets (a 2000-id hydration takes 30+ s).
    // Both fields are 0 when no hydration is in flight.
    hydrationCompleted: number;
    hydrationTotal: number;

    // Timestamp (epoch ms) of the last successful end-to-end processing run
    // (cloud reconcile finished OR on-device scoring pass finished).
    // Survives reload via FeedMetadata persistence.
    lastProcessingRunFinishedAt: number | null;

    // Actions
    setSuggestions: (data: ForYouSuggestion[]) => void;
    appendSuggestions: (data: ForYouSuggestion[], endCursor: string | null, hasNextPage: boolean) => void;
    setPagination: (endCursor: string | null, hasNextPage: boolean) => void;
    setCounts: (total: number, relevant: number) => void;
    setHasGeneratedTopics: (value: boolean) => void;
    setUnscoredCount: (count: number) => void;
    removeSuggestion: (serverId: string) => void;
    startDeviceProcessing: (total: number) => void;
    updateDeviceProgress: (processed: number, total?: number) => void;
    finishDeviceProcessing: () => void;
    setAsyncJobPhase: (
        phase: 'idle' | 'relevance' | 'reasons',
        processedCount?: number,
        totalCount?: number,
    ) => void;
    setAsyncJobProgress: (processedCount: number, totalCount: number) => void;
    clearData: () => Promise<void>;
    pruneOrphanedData: () => Promise<void>;
    hydrateSuggestionsFromDb: () => Promise<void>;
    hydrateMetadataFromDb: () => Promise<void>;
    setSyncStatusMessage: (msg: SyncStatusMessage | null) => void;
    setLastSyncAt: (ts: number) => void;
    setScoringError: (kind: ScoringErrorKind | null) => void;
    setDailyLimitResetAt: (ts: number | null) => void;
    setHydrationProgress: (completed: number, total: number) => void;
    resetHydrationProgress: () => void;
    markProcessingRunFinished: () => void;
    feedNeedsRefresh: boolean;
    setFeedNeedsRefresh: (val: boolean) => void;
}

const initialState = {
    suggestions: [] as ForYouSuggestion[],
    articleCount: 0,
    relevantArticleCount: 0,
    hasGeneratedTopics: true,
    endCursor: null as string | null,
    hasNextPage: true,
    unscoredCount: 0,
    isDeviceProcessing: false,
    deviceProcessProgress: 0,
    deviceProcessedCount: 0,
    deviceTotalCount: 0,
    asyncJobPhase: 'idle' as 'idle' | 'relevance' | 'reasons',
    asyncJobProcessedCount: 0,
    asyncJobTotalCount: 0,
    syncStatusMessage: null as SyncStatusMessage | null,
    lastSyncAt: null as number | null,
    scoringError: null as ScoringErrorKind | null,
    dailyLimitResetAt: null as number | null,
    hydrationCompleted: 0,
    hydrationTotal: 0,
    lastProcessingRunFinishedAt: null as number | null,
    feedNeedsRefresh: false,
};

export const useForYouStore = create<ForYouState>()((set, get) => ({
    ...initialState,

    setSuggestions: (data) => {
        set({
            suggestions: data,
            endCursor: null,
            hasNextPage: true,
        });
    },

    appendSuggestions: (data, endCursor, hasNextPage) => {
        set((state) => ({
            suggestions: [...state.suggestions, ...data],
            endCursor,
            hasNextPage,
        }));
    },

    setPagination: (endCursor, hasNextPage) => set({ endCursor, hasNextPage }),

    setCounts: (total, relevant) => {
        set({
            articleCount: total,
            relevantArticleCount: relevant,
        });
        const state = get();
        persistFeedMetadata({
            articleCount: total,
            relevantArticleCount: relevant,
            hasGeneratedTopics: state.hasGeneratedTopics,
            lastProcessingRunFinishedAt: state.lastProcessingRunFinishedAt,
        }).catch((err) => logger.captureException(err, { tags: { store: 'for-you-store' } }));
    },

    setHasGeneratedTopics: (value) => {
        set({ hasGeneratedTopics: value });
        const state = get();
        persistFeedMetadata({
            articleCount: state.articleCount,
            relevantArticleCount: state.relevantArticleCount,
            hasGeneratedTopics: value,
            lastProcessingRunFinishedAt: state.lastProcessingRunFinishedAt,
        }).catch((err) => logger.captureException(err, { tags: { store: 'for-you-store' } }));
    },

    setUnscoredCount: (count) => set({ unscoredCount: count }),

    removeSuggestion: (serverId) => {
        const state = get();
        const target = state.suggestions.find((s) => s._id === serverId);
        if (!target) return;

        const nextSuggestions = state.suggestions.filter((s) => s._id !== serverId);
        const wasImpactful =
            target.status !== ArticleSuggestionStatus.Unscored && target.relevance > 0.3;
        const nextRelevantCount = wasImpactful
            ? Math.max(0, state.relevantArticleCount - 1)
            : state.relevantArticleCount;

        set({
            suggestions: nextSuggestions,
            relevantArticleCount: nextRelevantCount,
        });

        persistFeedMetadata({
            articleCount: state.articleCount,
            relevantArticleCount: nextRelevantCount,
            hasGeneratedTopics: state.hasGeneratedTopics,
            lastProcessingRunFinishedAt: state.lastProcessingRunFinishedAt,
        }).catch((err) => logger.captureException(err, { tags: { store: 'for-you-store' } }));
    },

    startDeviceProcessing: (total) => set({
        isDeviceProcessing: true,
        deviceProcessProgress: 0,
        deviceProcessedCount: 0,
        deviceTotalCount: total,
    }),

    updateDeviceProgress: (processed, total) => set((state) => {
        const nextTotal = Math.max(
            state.deviceTotalCount,
            total ?? 0,
            processed,
        );
        return {
            deviceProcessedCount: processed,
            deviceTotalCount: nextTotal,
            deviceProcessProgress: nextTotal > 0 ? processed / nextTotal : 0,
        };
    }),

    finishDeviceProcessing: () => set((state) => ({
        isDeviceProcessing: false,
        deviceProcessProgress: 1,
        deviceProcessedCount: state.deviceTotalCount,
    })),

    setAsyncJobPhase: (phase, processedCount, totalCount) => set((state) => ({
        asyncJobPhase: phase,
        asyncJobProcessedCount:
            phase === 'idle'
                ? 0
                : processedCount ?? state.asyncJobProcessedCount,
        asyncJobTotalCount:
            phase === 'idle' ? 0 : totalCount ?? state.asyncJobTotalCount,
    })),

    setAsyncJobProgress: (processedCount, totalCount) =>
        set({ asyncJobProcessedCount: processedCount, asyncJobTotalCount: totalCount }),

    setSyncStatusMessage: (msg) => set({ syncStatusMessage: msg }),

    setLastSyncAt: (ts) => set({ lastSyncAt: ts }),

    setScoringError: (kind) => set({ scoringError: kind }),

    setDailyLimitResetAt: (ts) => set({ dailyLimitResetAt: ts }),

    setHydrationProgress: (completed, total) =>
        set({ hydrationCompleted: completed, hydrationTotal: total }),

    resetHydrationProgress: () =>
        set({ hydrationCompleted: 0, hydrationTotal: 0 }),

    markProcessingRunFinished: () => {
        const ts = Date.now();
        set({ lastProcessingRunFinishedAt: ts });
        const state = get();
        persistFeedMetadata({
            articleCount: state.articleCount,
            relevantArticleCount: state.relevantArticleCount,
            hasGeneratedTopics: state.hasGeneratedTopics,
            lastProcessingRunFinishedAt: ts,
        }).catch((err) => logger.captureException(err, { tags: { store: 'for-you-store' } }));
    },

    setFeedNeedsRefresh: (val) => set({ feedNeedsRefresh: val }),

    clearData: async () => {
        // Reset all counts to zero — stale article counts from the previous
        // run are misleading while the DB is empty awaiting the next sync.
        // hasGeneratedTopics is preserved from the current session state
        // because clearing the feed cache does not remove the user's interests.
        const hasGeneratedTopics = get().hasGeneratedTopics;
        set({ ...initialState, hasGeneratedTopics });
        try {
            await clearSuggestions();
            await persistFeedMetadata({
                articleCount: 0,
                relevantArticleCount: 0,
                hasGeneratedTopics,
                lastProcessingRunFinishedAt: null,
            });
        } catch (err) {
            logger.captureException(err, { tags: { store: 'for-you-store' } });
        }
    },

    pruneOrphanedData: async () => {
        const deletedCount = await pruneOrphanedSuggestions();

        if (deletedCount === -1) {
            // No active topics — full clear
            const hasGeneratedTopics = get().hasGeneratedTopics;
            set({ ...initialState, hasGeneratedTopics });
            await persistFeedMetadata({
                articleCount: 0,
                relevantArticleCount: 0,
                hasGeneratedTopics,
                lastProcessingRunFinishedAt: null,
            }).catch((err) => logger.captureException(err, { tags: { store: 'for-you-store' } }));
            return;
        }

        if (deletedCount > 0) {
            const rows = await loadSuggestions();
            rows.sort(byRelevanceDesc);
            const relevantCount = rows.filter(
                (s) => s.status !== ArticleSuggestionStatus.Unscored && s.relevance > 0.3,
            ).length;
            const state = get();
            set({
                suggestions: rows,
                articleCount: rows.length,
                relevantArticleCount: relevantCount,
            });
            await persistFeedMetadata({
                articleCount: rows.length,
                relevantArticleCount: relevantCount,
                hasGeneratedTopics: state.hasGeneratedTopics,
                lastProcessingRunFinishedAt: state.lastProcessingRunFinishedAt,
            }).catch((err) => logger.captureException(err, { tags: { store: 'for-you-store' } }));
        }
    },

    hydrateSuggestionsFromDb: async () => {
        try {
            const rows = await loadSuggestions();
            rows.sort(byRelevanceDesc);
            const scoredCount = rows.filter(
                (s) => s.status !== ArticleSuggestionStatus.Unscored,
            ).length;
            set({
                suggestions: rows,
                unscoredCount: rows.length - scoredCount,
            });
        } catch (err) {
            // Hydration failed — leave suggestions empty, but surface the error.
            logger.captureException(err, {
                tags: { store: 'for-you-store', method: 'hydrateSuggestionsFromDb' },
            });
        }
    },

    hydrateMetadataFromDb: async () => {
        try {
            // Rehydrate the header's scoring phase/progress from the persisted
            // multi-batch pipeline run (replaces the legacy single-slot
            // getPendingAsyncJob read). idle when no run / all batches terminal.
            const { getPipelineUiState } = await import(
                '@/lib/services/scoring-pipeline'
            );

            const [meta, pipelineUi] = await Promise.all([
                loadFeedMetadata(),
                getPipelineUiState(),
            ]);

            const current = get().suggestions;
            const impactfulCount = current.filter(
                (s) => s.status !== ArticleSuggestionStatus.Unscored && s.relevance > 0.3,
            ).length;

            set({
                articleCount: meta?.articleCount ?? current.length,
                relevantArticleCount: meta?.relevantArticleCount ?? impactfulCount,
                hasGeneratedTopics: meta?.hasGeneratedTopics ?? true,
                lastProcessingRunFinishedAt: meta?.lastProcessingRunFinishedAt ?? null,
                asyncJobPhase: pipelineUi.phase,
                asyncJobProcessedCount:
                    pipelineUi.phase === 'idle' ? 0 : pipelineUi.processedCount,
                asyncJobTotalCount:
                    pipelineUi.phase === 'idle' ? 0 : pipelineUi.totalCount,
            });
        } catch (err) {
            // Metadata hydration failed — leave defaults in place, but surface the error.
            logger.captureException(err, {
                tags: { store: 'for-you-store', method: 'hydrateMetadataFromDb' },
            });
        }
    },
}));

function byRelevanceDesc(
    a: { relevance: number; status: ArticleSuggestionStatusType },
    b: { relevance: number; status: ArticleSuggestionStatusType },
): number {
    const av = a.status !== ArticleSuggestionStatus.Unscored ? a.relevance : -Infinity;
    const bv = b.status !== ArticleSuggestionStatus.Unscored ? b.relevance : -Infinity;
    return bv - av;
}
