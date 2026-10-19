import { useEffect, useCallback, useMemo, useRef, useState } from 'react';
import { Share } from 'react-native';
import { Q } from '@nozbe/watermelondb';
import { useShallow } from 'zustand/react/shallow';
import database from '@/lib/database';
import { ArticleSuggestionStatus } from '@/lib/database/article-suggestion-status';
import type Setting from '@/lib/database/models/Setting';
import schema from '@/lib/database/schema';
import logger from '@/lib/logger';
import { useExportHistory } from './use-export-history';
import { clearFeedCacheAndResync } from './clear-feed-cache';
import { showDialog } from '@/lib/dialog';
import { toastManager } from '@/lib/toast-manager';
import { useSchedulerStore } from '@/lib/scheduler/scheduler-store';
import { useForYouStore } from '@/lib/stores/for-you-store';
import { useMeraProtocolStore } from '@/lib/stores/mera-protocol-store';
import { useNetworkStore } from '@/lib/stores/network-store';
import { useDatabaseStore } from '@/lib/stores/database-store';
import { useUserStore } from '@/lib/stores/user-store';
import { useFeedOrderStore } from '@/lib/stores/feed-order-store';
import { useOpenedStoriesStore } from '@/lib/stores/opened-stories-store';
import { computeFeedFunnel, type FeedFunnelReport } from '@/lib/stores/feed-diagnostics';
import { getOpenedSeenBreakdown } from '@/lib/database/services/story-impression-service';
import {
  getScoringModeBreakdown,
  getSharedNoteBreakdown,
} from '@/lib/database/services/article-suggestion-diagnostics';
import { loadUserGeoLanguageContext } from '@/lib/user-context/user-geo-language-context';
import { useFeedCounts } from '@/lib/hooks/use-feed-counts';
import { runBlobPrimitivesProbe, type ProbeReport } from '@/lib/backup/dev-probe';
import { STATUS_LABELS, TABLE_LABELS } from './observability-labels';

// ─── Types ───────────────────────────────────────────────────────────────────

type DbStats = {
    tableCounts: Record<string, number>;
    factsByTopicStatus: Record<string, number>;
    schedulerJobsByStatus: Record<string, number>;
    inferenceJobsByStatus: Record<string, number>;
    settings: { key: string; value: string }[];
};

// ─── Constants ───────────────────────────────────────────────────────────────

const COUNT_TABLES = [
    'article_suggestions',
    'article_suggestion_facts',
    'publication_visits',
    'facts',
    // TOPICS ARE WHAT FETCH ARTICLES, so their absence is the first thing to
    // check when a feed is thin, and this list did not carry them: a dump
    // could show nine facts and no way to tell whether any of them had a
    // single topic behind it. `facts` alone answers "were my facts saved";
    // only this answers "is anything retrieving for them".
    'topics',
    'user_personas',
] as const;

/** `facts.topics_status`, so a dump distinguishes "generation never ran" from
 *  "it ran and failed" from "it worked". A fact stuck on `error` contributes
 *  no topics and therefore no articles, and looks identical on the Profile to
 *  one that simply has nothing to say. */
const TOPIC_STATUSES = ['pending', 'done', 'error'] as const;

const SCHEDULER_STATUSES = [
    'pending', 'running', 'completed', 'failed', 'stale', 'cancelled', 'retrying',
] as const;

const INFERENCE_STATUSES = ['pending', 'running', 'done', 'failed'] as const;

function sumStatusCounts(byStatus: Record<string, number>): number {
    return Object.values(byStatus).reduce((acc, n) => acc + (n ?? 0), 0);
}

// Friendly breakdown of only the non-zero statuses, e.g. "12 done · 3 waiting".
function formatStatusBreakdown(byStatus: Record<string, number>, statuses: readonly string[]): string {
    return statuses
        .filter((s) => (byStatus[s] ?? 0) > 0)
        .map((s) => `${byStatus[s]} ${(STATUS_LABELS[s] ?? s).toLowerCase()}`)
        .join(' · ');
}

async function loadDbStats(): Promise<DbStats> {
    const tableCounts: Record<string, number> = {};
    await Promise.all(
        COUNT_TABLES.map(async (name) => {
            tableCounts[name] = await database.get(name).query().fetchCount();
        }),
    );

    const schedulerJobsByStatus: Record<string, number> = {};
    await Promise.all(
        SCHEDULER_STATUSES.map(async (s) => {
            schedulerJobsByStatus[s] = await database
                .get('scheduler_jobs')
                .query(Q.where('status', s))
                .fetchCount();
        }),
    );

    const inferenceJobsByStatus: Record<string, number> = {};
    await Promise.all(
        INFERENCE_STATUSES.map(async (s) => {
            inferenceJobsByStatus[s] = await database
                .get('inference_jobs')
                .query(Q.where('status', s))
                .fetchCount();
        }),
    );

    const factsByTopicStatus: Record<string, number> = {};
    await Promise.all(
        TOPIC_STATUSES.map(async (st) => {
            factsByTopicStatus[st] = await database
                .get('facts')
                .query(Q.where('topics_status', st))
                .fetchCount();
        }),
    );
    // NULL reads as done everywhere else, so it is counted separately rather
    // than folded in: a null column means generation was never asked for,
    // which is a different problem from one that ran.
    factsByTopicStatus.unset = await database
        .get('facts')
        .query(Q.where('topics_status', null))
        .fetchCount();

    const settingRows = await database.get<Setting>('settings').query().fetch();
    const settings = settingRows.map((s) => ({ key: s.key, value: s.value }));

    return {
        tableCounts,
        schedulerJobsByStatus,
        inferenceJobsByStatus,
        factsByTopicStatus,
        settings,
    };
}

export function useObservabilityScreen() {
    const {
        status: schedulerStatus,
        runningCount,
        failedCount,
        pendingCount,
        taskCurrentStatus,
        taskLastRun,
        taskProgress,
        jobs,
    } = useSchedulerStore(
        useShallow((s) => ({
            status: s.status,
            runningCount: s.runningCount,
            failedCount: s.failedCount,
            pendingCount: s.pendingCount,
            taskCurrentStatus: s.taskCurrentStatus,
            taskLastRun: s.taskLastRun,
            taskProgress: s.taskProgress,
            jobs: s.jobs,
        })),
    );

    const {
        articleCount,
        relevantArticleCount,
        unscoredCount,
        asyncJobPhase,
        lastSyncAt,
        syncStatusMessage,
    } = useForYouStore(
        useShallow((s) => ({
            articleCount: s.articleCount,
            relevantArticleCount: s.relevantArticleCount,
            unscoredCount: s.unscoredCount,
            asyncJobPhase: s.asyncJobPhase,
            lastSyncAt: s.lastSyncAt,
            syncStatusMessage: s.syncStatusMessage,
        })),
    );

    const { processingMode, modelState, downloadProgress, isProcessing } = useMeraProtocolStore(
        useShallow((s) => ({
            processingMode: s.processingMode,
            modelState: s.modelState,
            downloadProgress: s.downloadProgress,
            isProcessing: s.isProcessing,
        })),
    );

    const isConnected = useNetworkStore((s) => s.isConnected);
    const dbReady = useDatabaseStore((s) => s.ready);
    const userId = useUserStore((s) => s.userId);

    const [dbStats, setDbStats] = useState<DbStats | null>(null);
    const [loadingDb, setLoadingDb] = useState(false);
    const [selectedTable, setSelectedTable] = useState<string | null>(null);
    const [funnel, setFunnel] = useState<FeedFunnelReport | null>(null);
    // Terminal `already_read` rows — the pre-scoring already-read gate's output.
    // `null` until counted (or when the count query failed) → rendered '—'.
    const [alreadyReadCount, setAlreadyReadCount] = useState<number | null>(null);

    // The header numbers the funnel reconciles against, held in a ref so
    // `refresh` can read them without a dependency (it must stay `[]` — a new
    // identity on every count change would re-run the whole diagnostic).
    const feedCounts = useFeedCounts();
    const feedCountsRef = useRef(feedCounts);
    // Declared ABOVE the refresh effect on purpose: effects fire in declaration
    // order, so the mount run reads live counts rather than stale zeroes.
    useEffect(() => { feedCountsRef.current = feedCounts; }, [feedCounts]);

    const refresh = useCallback(async () => {
        setLoadingDb(true);
        try {
            setDbStats(await loadDbStats());
        } catch (err) {
            logger.warn('[ObservabilityScreen] loadDbStats failed', { error: String(err) });
        } finally {
            setLoadingDb(false);
        }

        // Feed funnel — ON DEMAND ONLY (this mount + the header refresh button).
        // It is strictly read-only: it snapshots store state via `getState()` and
        // never hydrates, ingests, or marks anything. Its own try/catch so a
        // diagnostic failure can never take the rest of the screen down.
        try {
            const [
                breakdown,
                userCtx,
                scoringModes,
                alreadyRead,
                sharedNotes,
            ] = await Promise.all([
                getOpenedSeenBreakdown().catch(() => null),
                loadUserGeoLanguageContext(),
                // Its own catch: this walks every scored row's audit JSON, and a
                // parse/read failure must degrade to "—" on two rows, not take
                // the whole funnel down.
                getScoringModeBreakdown().catch(() => null),
                // Counted here rather than in `loadDbStats` so it lands in the
                // same pass as the rest of the funnel. Own catch → '—'.
                database
                    .get('article_suggestions')
                    .query(Q.where('status', ArticleSuggestionStatus.AlreadyRead))
                    .fetchCount()
                    .catch(() => null),
                // Fetches every row carrying a note, so it belongs here with the
                // other on-demand reads rather than anywhere near render. Own
                // catch → the shared-notes row renders '—' instead of a zero
                // that would read as "nothing is shared".
                getSharedNoteBreakdown().catch(() => null),
            ]);
            setAlreadyReadCount(alreadyRead);
            const fo = useFeedOrderStore.getState();
            const os = useOpenedStoriesStore.getState();
            const counts = feedCountsRef.current;
            setFunnel(
                computeFeedFunnel({
                    suggestions: useForYouStore.getState().suggestions,
                    openedArticleIds: os.articleIds,
                    openedUnionIds: os.ids,
                    order: fo.order,
                    itemsById: fo.itemsById,
                    cardStates: fo.cardStates,
                    builtAt: fo.builtAt,
                    orderHydrated: fo.hydrated,
                    openedHydrated: os.hydrated,
                    hydrateStats: fo.hydrateStats,
                    headerAnalysedCount: counts.analysedCount,
                    headerRelevantCount: counts.relevantCount,
                    openedStats: breakdown?.stats ?? null,
                    scoringModes,
                    sharedNotes,
                    userCtx,
                    nowMs: Date.now(),
                }),
            );
        } catch (err) {
            logger.warn('[ObservabilityScreen] feed funnel failed', { error: String(err) });
        }
    }, []);

    useEffect(() => { if (dbReady) void refresh(); }, [refresh, dbReady]);

    const { exporting: isExportingHistory, exportHistory: handleExportHistory } = useExportHistory('ObservabilityScreen');

    // Developer tool: wipes every downloaded article, score and note, then re-syncs so the
    // whole feed is fetched and scored again (e.g. after switching the on-device engine).
    const [isClearingFeed, setIsClearingFeed] = useState(false);
    const handleClearFeedCache = useCallback(async () => {
        const confirmed = await showDialog({
            title: 'Clear feed cache?',
            body: 'This deletes every downloaded article, score and note on this phone, then fetches and scores your news again. Your facts and topics stay.',
            confirmLabel: 'Clear',
            cancelLabel: 'Cancel',
            destructive: true,
        });
        if (!confirmed) return;
        setIsClearingFeed(true);
        try {
            await clearFeedCacheAndResync();
            toastManager.showSuccess('Feed cache cleared', 'Mera is fetching and scoring your news again.');
            void refresh();
        } catch (err) {
            logger.captureException(err, { tags: { component: 'ObservabilityScreen', method: 'clearFeedCache' } });
            toastManager.showError('Could not clear the feed cache', 'Try again.');
        } finally {
            setIsClearingFeed(false);
        }
    }, [refresh]);

    const [copied, setCopied] = useState(false);

    // Backup blob probe — __DEV__ only, see the section at the bottom of the render.
    const [probe, setProbe] = useState<ProbeReport | null>(null);
    const [probeRunning, setProbeRunning] = useState(false);

    const handleRunProbe = useCallback(async () => {
        setProbeRunning(true);
        setProbe(null);
        try {
            setProbe(await runBlobPrimitivesProbe());
        } finally {
            setProbeRunning(false);
        }
    }, []);

    const handleCopy = useCallback(async () => {
        const allTaskNames = new Set([...Object.keys(taskCurrentStatus), ...Object.keys(taskLastRun)]);
        const tasks: Record<string, { status: string | null; lastRun: number | null }> = {};
        for (const name of allTaskNames) {
            tasks[name] = { status: taskCurrentStatus[name] ?? null, lastRun: taskLastRun[name] ?? null };
        }

        const settingsMap: Record<string, string> = {};
        if (dbStats) {
            for (const { key, value } of dbStats.settings) settingsMap[key] = value;
        }

        const payload = {
            scheduler: { status: schedulerStatus, runningCount, failedCount, pendingCount, tasks },
            feed: {
                articleCount,
                relevantArticleCount,
                unscoredCount,
                alreadyReadCount,
                asyncJobPhase,
                lastSyncAt,
                syncState: syncStatusMessage?.state ?? 'idle',
            },
            // The FULL report, samples included. The OS share sheet neither caps
            // nor truncates, so the per-article rows ride out intact. Never route
            // this to Sentry: `capStringValues` skips arrays, so sample titles
            // would bypass the 200-char PII redaction.
            feed_funnel: funnel,
            protocol: { processingMode, modelState, downloadProgress, isProcessing, hasPushToken: useUserStore.getState().userPersona?.expoPushToken != null },
            system: {
                network: isConnected,
                dbReady,
                schemaVersion: schema.version,
                userId,
            },
            db_counts: dbStats
                ? {
                    ...dbStats.tableCounts,
                    scheduler_jobs: dbStats.schedulerJobsByStatus,
                    inference_jobs: dbStats.inferenceJobsByStatus,
                    facts_by_topic_status: dbStats.factsByTopicStatus,
                }
                : null,
            settings: settingsMap,
        };

        await Share.share({ message: JSON.stringify(payload, null, 2) });
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
    }, [
        taskCurrentStatus, taskLastRun, dbStats, schedulerStatus, runningCount, failedCount,
        pendingCount, articleCount, relevantArticleCount, unscoredCount,
        asyncJobPhase, lastSyncAt, syncStatusMessage, processingMode, modelState,
        downloadProgress, isProcessing, isConnected, dbReady, userId, funnel,
        alreadyReadCount,
    ]);

    const relevantPct = articleCount > 0 ? Math.round((relevantArticleCount / articleCount) * 100) : 0;

    const taskNames = useMemo(
        () =>
            Array.from(new Set([...Object.keys(taskCurrentStatus), ...Object.keys(taskLastRun)])).sort(),
        [taskCurrentStatus, taskLastRun],
    );

    // Unified DB-table rows: plain counts for the content tables, plus job
    // tables where the count is the total and the subtitle breaks down statuses.
    const dbTableRows = useMemo(() => {
        if (!dbStats) return [];
        const rows: { name: string; count: string; subtitle?: string }[] = COUNT_TABLES.map((name) => ({
            name,
            count: String(dbStats.tableCounts[name] ?? '…'),
            subtitle: TABLE_LABELS[name]?.description,
        }));
        rows.push({
            name: 'scheduler_jobs',
            count: String(sumStatusCounts(dbStats.schedulerJobsByStatus)),
            subtitle:
                formatStatusBreakdown(dbStats.schedulerJobsByStatus, SCHEDULER_STATUSES) ||
                TABLE_LABELS.scheduler_jobs?.description,
        });
        rows.push({
            name: 'inference_jobs',
            count: String(sumStatusCounts(dbStats.inferenceJobsByStatus)),
            subtitle:
                formatStatusBreakdown(dbStats.inferenceJobsByStatus, INFERENCE_STATUSES) ||
                TABLE_LABELS.inference_jobs?.description,
        });
        return rows;
    }, [dbStats]);

    const getTaskError = useCallback(
        (taskName: string): string | undefined =>
            Object.values(jobs).find(
                (j) => j.taskName === taskName && (j.status === 'failed' || j.status === 'stale'),
            )?.errorMessage ?? undefined,
        [jobs],
    );

    return {
        refresh,
        loadingDb,
        handleCopy,
        copied,
        isExportingHistory,
        handleExportHistory,
        isClearingFeed,
        handleClearFeedCache,
        articleCount,
        relevantArticleCount,
        relevantPct,
        unscoredCount,
        schedulerStatus,
        runningCount,
        failedCount,
        pendingCount,
        dbStats,
        dbTableRows,
        selectedTable,
        setSelectedTable,
        taskNames,
        taskCurrentStatus,
        taskProgress,
        taskLastRun,
        getTaskError,
        lastSyncAt,
        funnel,
        alreadyReadCount,
        processingMode,
        downloadProgress,
        isProcessing,
        isConnected,
        dbReady,
        probe,
        probeRunning,
        handleRunProbe,
    };
}
