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
// RENDER_GATE (relevance v3: 0.4, inclusive) — the single source of truth the
// pre-filter below is kept in lockstep with, rather than a second hardcoded
// copy of the cutoff. Only a type import flows the other way (fact-rows-selector
// takes `ForYouSuggestion` as a type), so this is not a runtime cycle.
import { effectiveRenderGate } from '@/lib/stores/fact-rows-selector';

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
 *  suggestions into a single representative card via union-find over two edge
 *  types (see `lib/feed-grouping/story-grouping.ts`): a shared high-confidence
 *  cluster, OR a high title-token Jaccard (the latter bridges the same story
 *  across the server's per-run clustering generations). The detail screen's
 *  "related articles" panel still calls `relatedArticles(articleId)` for the
 *  authoritative live cluster siblings. */
export type ClusterMembership = {
    clusterId: string;
    confidence: number;
    /** Cross-run stable story id (UUID) assigned by the server to multi-member
     *  clusters and carried ACROSS clustering runs. Null/absent for singletons,
     *  unclustered articles, and rows persisted before this field existed. When
     *  present it is the authoritative same-story key (see story-grouping.ts);
     *  the per-run `clusterId` + title heuristics are fallbacks for items lacking
     *  it. May rarely RESET (crashed clustering generation) → treated as a new
     *  story, never a crash. */
    stableClusterId?: string | null;
};

/** One matched topic on a suggestion (parsed from `matched_topics_json`).
 *  `topicId` is null for synthetic headline matches. Consumed by the
 *  fact-sectioned feed selector (`selectSections`). */
export type MatchedTopicRef = {
    topicId: string | null;
    text: string;
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
    // ── Persona v3 (schema v37) fields for the fact-sectioned feed selector ──
    // Absent/null on legacy rows (pre-migration) → the screen falls back to the
    // priority-bucket layout. All nullable so old rows hydrate cleanly.
    /** Final post-judge raw score (article_suggestions.raw_score); null unscored. */
    rawScore: number | null;
    /** Controlled event-type value (breaking extraction + section/card icons).
     *  Also the equality guard on story-grouping's entity-overlap edge. */
    eventType: string | null;
    /** Server-tagged named entities (≤8, persisted as `entities_json`). Feeds
     *  story-grouping's entity-overlap DISPLAY edge, which is the only signal
     *  that collapses translated/rewritten coverage of one story whose titles
     *  share no tokens and whose server clusters disagree. Optional so the many
     *  existing suggestion fixtures keep compiling; `loadSuggestions` always
     *  populates it (`?? []` at the read sites). */
    entities?: string[];
    /** null = topic-retrieved; else the top-headline injection scope. */
    headlineScope: 'CITY' | 'COUNTRY' | 'GLOBAL' | null;
    /** ISO alpha-2 country of the scope that injected this row — only ever set
     *  alongside `headlineScope === 'COUNTRY'` (a country on a GLOBAL row would
     *  be incoherent). Persisted as `article_suggestions.headline_country_code`
     *  (schema v48). Optional: rows persisted before v48, and every non-headline
     *  row, carry none. The Dashboard's per-country headline sections key on it;
     *  a COUNTRY row with no country belongs to NO country section. */
    headlineCountryCode?: string | null;
    /** Inverted per-topic matchMeta — resolves the owning fact/section. */
    matchedTopics: MatchedTopicRef[];
    // ── Round-3 (schema v41) fact-rows fields ──────────────────────────────
    // Optional so the many existing suggestion fixtures/snapshots keep compiling;
    // `loadSuggestions` (the live path) always populates both. Consumers read
    // them with `?? []` / `?? null`.
    /** Fact ids this suggestion is linked to (from `article_suggestion_facts`).
     *  Empty for orphan/headline rows. Feeds the fact-rows selector's ownership +
     *  the per-fact feed. */
    factIds?: string[];
    /** Epoch ms the row was scored (`article_suggestions.scored_at`); null when
     *  unscored or on legacy rows. The fact-rows selector uses `scoredAt ??
     *  createdAt` as the row's "added" time for newest-first ordering. */
    scoredAt?: number | null;
};

/** Honest article-scoring progress for the current cloud run (Round-4 B) —
 *  `done` articles analysed of `total`. Drives the shimmer's "Analysing X of Y
 *  articles" line + the status accordion's progress row. null when no run is
 *  active. */
export type PipelineBatchProgress = {
    done: number;
    total: number;
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

    // Honest cloud batch/article progress (Round-4 B). Written live by
    // scoring-pipeline as batches transition (pushUiProgress) and rehydrated at
    // boot from the persisted run. null when no run / all terminal. Drives the
    // shimmer's "Analysing X of Y articles" line + the status accordion.
    batchProgress: PipelineBatchProgress | null;

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

    // UTC date string (`YYYY-MM-DD`) of the last daily-limit NOTICE (toast +
    // notification-center row) shown to the user, or null if never shown.
    // Distinct from `dailyLimitResetAt` (which drives the persistent banner
    // and is intentionally NOT persisted): this field gates the repeating
    // toast to once per UTC day and IS persisted via FeedMetadata so a
    // restart doesn't re-fire it. Set by FeedSyncMachine's `daily-limit`
    // branch; a new UTC day naturally re-arms the notice.
    dailyLimitNoticeDay: string | null;

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
    setBatchProgress: (progress: PipelineBatchProgress | null) => void;
    clearData: () => Promise<void>;
    pruneOrphanedData: () => Promise<void>;
    hydrateSuggestionsFromDb: () => Promise<void>;
    hydrateMetadataFromDb: () => Promise<void>;
    setSyncStatusMessage: (msg: SyncStatusMessage | null) => void;
    setLastSyncAt: (ts: number) => void;
    setScoringError: (kind: ScoringErrorKind | null) => void;
    setDailyLimitResetAt: (ts: number | null) => void;
    setDailyLimitNoticeDay: (day: string | null) => void;
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
    batchProgress: null as PipelineBatchProgress | null,
    syncStatusMessage: null as SyncStatusMessage | null,
    lastSyncAt: null as number | null,
    scoringError: null as ScoringErrorKind | null,
    dailyLimitResetAt: null as number | null,
    dailyLimitNoticeDay: null as string | null,
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
            dailyLimitNoticeDay: state.dailyLimitNoticeDay,
        }).catch((err) => logger.captureException(err, {
            tags: { store: 'for-you-store', method: 'setCounts' },
        }));
    },

    setHasGeneratedTopics: (value) => {
        set({ hasGeneratedTopics: value });
        const state = get();
        persistFeedMetadata({
            articleCount: state.articleCount,
            relevantArticleCount: state.relevantArticleCount,
            hasGeneratedTopics: value,
            lastProcessingRunFinishedAt: state.lastProcessingRunFinishedAt,
            dailyLimitNoticeDay: state.dailyLimitNoticeDay,
        }).catch((err) => logger.captureException(err, {
            tags: { store: 'for-you-store', method: 'setHasGeneratedTopics' },
        }));
    },

    setUnscoredCount: (count) => set({ unscoredCount: count }),

    removeSuggestion: (serverId) => {
        const state = get();
        const target = state.suggestions.find((s) => s._id === serverId);
        if (!target) return;

        const nextSuggestions = state.suggestions.filter((s) => s._id !== serverId);
        const wasImpactful =
            target.status !== ArticleSuggestionStatus.Unscored && target.relevance >= effectiveRenderGate();
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
            dailyLimitNoticeDay: state.dailyLimitNoticeDay,
        }).catch((err) => logger.captureException(err, {
            // Sentry MERA-APP-4W was titled "removeSuggestion", but
            // `removeSuggestion` itself is pure state math and can't throw —
            // the actual failure is always this trailing persistFeedMetadata
            // (WatermelonDB setSetting) write. This tag is what makes that
            // visible instead of merging with every other bare
            // `{ store: 'for-you-store' }` capture in this file into one
            // indistinguishable Sentry issue.
            tags: { store: 'for-you-store', method: 'removeSuggestion' },
        }));
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

    setBatchProgress: (progress) => set({ batchProgress: progress }),

    setSyncStatusMessage: (msg) => set({ syncStatusMessage: msg }),

    setLastSyncAt: (ts) => set({ lastSyncAt: ts }),

    setScoringError: (kind) => set({ scoringError: kind }),

    setDailyLimitResetAt: (ts) => set({ dailyLimitResetAt: ts }),

    setDailyLimitNoticeDay: (day) => {
        set({ dailyLimitNoticeDay: day });
        const state = get();
        persistFeedMetadata({
            articleCount: state.articleCount,
            relevantArticleCount: state.relevantArticleCount,
            hasGeneratedTopics: state.hasGeneratedTopics,
            lastProcessingRunFinishedAt: state.lastProcessingRunFinishedAt,
            dailyLimitNoticeDay: day,
        }).catch((err) => logger.captureException(err, {
            tags: { store: 'for-you-store', method: 'setDailyLimitNoticeDay' },
        }));
    },

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
            dailyLimitNoticeDay: state.dailyLimitNoticeDay,
        }).catch((err) => logger.captureException(err, {
            tags: { store: 'for-you-store', method: 'markProcessingRunFinished' },
        }));
    },

    setFeedNeedsRefresh: (val) => set({ feedNeedsRefresh: val }),

    clearData: async () => {
        // Reset all counts to zero — stale article counts from the previous
        // run are misleading while the DB is empty awaiting the next sync.
        // hasGeneratedTopics is preserved from the current session state
        // because clearing the feed cache does not remove the user's interests.
        // dailyLimitNoticeDay is likewise preserved — clearing the feed cache
        // has nothing to do with whether today's daily-limit notice already
        // fired, and resetting it would let the notice repeat within the day.
        const hasGeneratedTopics = get().hasGeneratedTopics;
        const dailyLimitNoticeDay = get().dailyLimitNoticeDay;
        set({ ...initialState, hasGeneratedTopics, dailyLimitNoticeDay });
        try {
            await clearSuggestions();
            await persistFeedMetadata({
                articleCount: 0,
                relevantArticleCount: 0,
                hasGeneratedTopics,
                lastProcessingRunFinishedAt: null,
                dailyLimitNoticeDay,
            });
        } catch (err) {
            logger.captureException(err, {
                tags: { store: 'for-you-store', method: 'clearData' },
            });
        }
    },

    pruneOrphanedData: async () => {
        const deletedCount = await pruneOrphanedSuggestions();

        if (deletedCount === -1) {
            // No active topics — full clear. dailyLimitNoticeDay is preserved
            // for the same reason as clearData: this is unrelated to whether
            // today's notice already fired.
            const hasGeneratedTopics = get().hasGeneratedTopics;
            const dailyLimitNoticeDay = get().dailyLimitNoticeDay;
            set({ ...initialState, hasGeneratedTopics, dailyLimitNoticeDay });
            await persistFeedMetadata({
                articleCount: 0,
                relevantArticleCount: 0,
                hasGeneratedTopics,
                lastProcessingRunFinishedAt: null,
                dailyLimitNoticeDay,
            }).catch((err) => logger.captureException(err, {
                tags: { store: 'for-you-store', method: 'pruneOrphanedData:fullClear' },
            }));
            return;
        }

        if (deletedCount > 0) {
            const rows = await loadSuggestions();
            rows.sort(byRelevanceDesc);
            const relevantCount = rows.filter(
                (s) => s.status !== ArticleSuggestionStatus.Unscored && s.relevance >= effectiveRenderGate(),
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
                dailyLimitNoticeDay: state.dailyLimitNoticeDay,
            }).catch((err) => logger.captureException(err, {
                tags: { store: 'for-you-store', method: 'pruneOrphanedData:reload' },
            }));
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
            const { getPipelineUiState, getPipelineBatchProgress } = await import(
                '@/lib/services/scoring-pipeline'
            );

            const [meta, pipelineUi, batchProgress] = await Promise.all([
                loadFeedMetadata(),
                getPipelineUiState(),
                getPipelineBatchProgress(),
            ]);

            const current = get().suggestions;
            const impactfulCount = current.filter(
                (s) => s.status !== ArticleSuggestionStatus.Unscored && s.relevance >= effectiveRenderGate(),
            ).length;

            set({
                articleCount: meta?.articleCount ?? current.length,
                relevantArticleCount: meta?.relevantArticleCount ?? impactfulCount,
                hasGeneratedTopics: meta?.hasGeneratedTopics ?? true,
                lastProcessingRunFinishedAt: meta?.lastProcessingRunFinishedAt ?? null,
                dailyLimitNoticeDay: meta?.dailyLimitNoticeDay ?? null,
                asyncJobPhase: pipelineUi.phase,
                asyncJobProcessedCount:
                    pipelineUi.phase === 'idle' ? 0 : pipelineUi.processedCount,
                asyncJobTotalCount:
                    pipelineUi.phase === 'idle' ? 0 : pipelineUi.totalCount,
                batchProgress: pipelineUi.phase === 'idle' ? null : batchProgress,
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

