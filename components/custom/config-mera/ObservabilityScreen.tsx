import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ScrollView, Share } from 'react-native';
import { Q } from '@nozbe/watermelondb';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useShallow } from 'zustand/react/shallow';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import database from '@/lib/database';
import type Setting from '@/lib/database/models/Setting';
import type { TaskProgress } from '@/lib/scheduler/scheduler-types';
import schema from '@/lib/database/schema';
import logger from '@/lib/logger';
import { formatTimeAgo } from '@/lib/utils/time-ago';
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
import { loadUserGeoLanguageContext } from '@/lib/user-context/user-geo-language-context';
import { useFeedCounts } from '@/lib/hooks/use-feed-counts';
import { Box } from '@/components/ui/box';
import { Text } from '@/components/ui/text';
import { HStack } from '@/components/ui/hstack';
import { Pressable } from '@/components/ui/pressable';
import { MaterialIcons } from '@expo/vector-icons';
import {
    Table,
    TableBody,
    TableData,
    TableHead,
    TableHeader,
    TableRow,
} from '@/components/ui/table';
import TableDetailScreen from './TableDetailScreen';
import {
    FEED_FUNNEL_LABELS,
    FIELD_LABELS,
    STATUS_LABELS,
    TABLE_LABELS,
    TASK_LABELS,
    humanizeKey,
    humanizeValue,
    statusLabel,
    tableLabel,
} from './observability-labels';

// ─── Types ───────────────────────────────────────────────────────────────────

type DbStats = {
    tableCounts: Record<string, number>;
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
    'user_personas',
] as const;

const SCHEDULER_STATUSES = [
    'pending', 'running', 'completed', 'failed', 'stale', 'cancelled', 'retrying',
] as const;

const INFERENCE_STATUSES = ['pending', 'running', 'done', 'failed'] as const;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function relativeTime(ms: number | null | undefined, t: TFunction): string {
    return formatTimeAgo(t, ms, { emptyLabel: t('observability.never') });
}

function statusDotColor(status: string | null | undefined): string {
    if (!status) return '#6b7280';
    if (status === 'completed') return '#10b981';
    if (status === 'failed' || status === 'stale') return '#ef4444';
    if (status === 'running' || status === 'pending' || status === 'retrying') return '#f59e0b';
    return '#6b7280';
}

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

    const settingRows = await database.get<Setting>('settings').query().fetch();
    const settings = settingRows.map((s) => ({ key: s.key, value: s.value }));

    return { tableCounts, schedulerJobsByStatus, inferenceJobsByStatus, settings };
}

// Feed-funnel rows, ordered by the stage an article passes through: stored →
// gated → grouped → laid out → read. Every nullable field is rendered as '—'
// rather than the literal "null".
function feedFunnelRows(r: FeedFunnelReport, t: TFunction): KVRow[] {
    const L = FEED_FUNNEL_LABELS;
    const rows: KVRow[] = [];

    // A false self-check (or an unattributed drop) means the DIAGNOSTIC is stale
    // — a gate was added without a matching sub-predicate — not that the feed is
    // broken. Say so first so nothing below is read at face value.
    const broken: string[] = [];
    if (!r.sumsCheck.visibilityAttributionSums) broken.push('gate totals');
    if (!r.sumsCheck.memberSumMatchesVisible) broken.push('story members');
    if (!r.sumsCheck.orderReasonsSum) broken.push('order reasons');
    if (r.dropped.unknownGate > 0) broken.push(`${r.dropped.unknownGate} unexplained`);
    if (broken.length > 0) rows.push([L.inconsistent, broken.join(' · ')]);

    rows.push(
        [L.rows, String(r.totals.rows)],
        [L.statusUnscored, String(r.totals.status.unscored)],
        [L.statusReasonPending, String(r.totals.status.reasonPending)],
        [L.statusComplete, String(r.totals.status.complete)],
        // Labels are literal here rather than in observability-labels.ts so the
        // two "not interested" rows stay next to the report fields they read.
        [
            'Filtered out — you said not interested',
            String(r.totals.status.excluded),
            'funnel-row-status-excluded',
        ],
        [L.headerRelevant, String(r.header.relevantCount)],
        [L.visible, String(r.visibleCount)],
        [
            'Held back — a “not interested” filter',
            String(r.dropped.excluded),
            'funnel-row-dropped-excluded',
        ],
        [L.droppedNotComplete, String(r.dropped.notComplete)],
        [L.droppedBelowGate, String(r.dropped.belowRelevanceGate)],
        [L.droppedOutsideWindow, String(r.dropped.outsideWindow)],
    );
    if (r.dropped.unknownGate > 0) rows.push([L.droppedUnknownGate, String(r.dropped.unknownGate)]);

    rows.push(
        [L.groups, String(r.groups.count)],
        [L.collapseRatio, String(r.groups.collapseRatio)],
        [L.largestGroup, String(r.groups.largestSize)],
        [L.candidates, String(r.candidates.count)],
        [L.orderBuiltAt, relativeTime(r.orderStage.builtAtMs, t)],
        [L.orderLength, String(r.orderStage.length)],
        [L.rendered, String(r.orderStage.renderedCount)],
        [L.orphans, String(r.orderStage.orphanCount)],
        [L.aboveDivider, r.orderStage.aboveDividerCount?.toString() ?? '—'],
        [L.belowDivider, r.orderStage.belowDividerCount?.toString() ?? '—'],
        [L.skipped, String(r.cardStates.skipped)],
        [L.viewed, String(r.cardStates.viewed)],
        [L.unviewed, String(r.cardStates.unviewed)],
        [L.staleCardStates, String(r.cardStates.staleEntries)],
        [L.missingFromOrder, String(r.candidatesNotInOrder.absent)],
    );

    // One sub-row per reason that actually fired — a table of four permanent
    // zeroes would bury the one that matters.
    for (const [reason, count] of Object.entries(r.candidatesNotInOrder.byReason)) {
        if (count > 0) rows.push([L[reason] ?? humanizeKey(reason), String(count)]);
    }

    const st = r.opened.stats;
    rows.push(
        [L.wouldBeBlockedByClusterGate, String(r.wouldBeBlockedByClusterGate)],
        [
            L.openedSet,
            st
                ? `${r.opened.unionSetSize} · ${st.unionSize} = ${st.articleIdCount} + ${st.clusterIdCount}`
                : `${r.opened.unionSetSize} · —`,
        ],
        [L.openedOlderThan7d, st ? String(st.ageBuckets.d7to30) : '—'],
        [L.orderHydrated, humanizeValue(String(r.hydrated.order))],
        // Called out because a `No` here makes the four opened-set rows above
        // read as legitimate zeroes: this screen opens from Settings without the
        // Feed tab ever mounting, which is exactly when that flag is false.
        [L.openedHydrated, humanizeValue(String(r.hydrated.opened))],
        [L.launchWipeSuspected, humanizeValue(String(r.launchWipeSuspected))],
    );

    return rows;
}

// ─── Shared table styles ──────────────────────────────────────────────────────

const TH_CLS = 'bg-gray-950 px-3 py-2 border-b border-gray-800';
const TD_CLS = 'px-3 py-2 border-b border-gray-800';
const ROW_EVEN = 'bg-black';
const ROW_ODD = 'bg-gray-950';

// ─── Sub-components ──────────────────────────────────────────────────────────

const SectionHeader = ({ title }: { title: string }) => (
    <Box className="pt-5 pb-1.5 border-b border-gray-800 mb-2">
        <Text size="xs" className="text-gray-500 uppercase tracking-widest font-semibold">
            {title}
        </Text>
    </Box>
);

const MetricCard = ({ title, value, subtitle }: { title: string; value: string; subtitle?: string }) => (
    <Box className="flex-1 bg-gray-900 rounded-xl p-3 border border-gray-800">
        <Text size="xs" className="text-gray-500 mb-0.5" numberOfLines={1}>{title}</Text>
        <Text className="text-white font-bold text-2xl leading-8">{value}</Text>
        {subtitle ? <Text size="xs" className="text-gray-500 mt-0.5">{subtitle}</Text> : null}
    </Box>
);

// 2-column key/value table used by Feed, Protocol, System, Settings
/** [label, value] — plus an OPTIONAL testID so a harness run can assert on a
 *  specific row without matching its (freely reworded) label. */
type KVRow = [label: string, value: string, testID?: string];

const KVTable = ({ rows }: { rows: KVRow[] }) => (
    <Box className="rounded-xl overflow-hidden border border-gray-800">
        <Table className="w-full">
            <TableBody>
                {rows.map(([k, v, testID], i) => (
                    <TableRow key={k} className={i % 2 === 0 ? ROW_EVEN : ROW_ODD}>
                        <TableData useRNView className={TD_CLS} style={{ flex: 1 }}>
                            <Text size="xs" className="text-gray-400">{k}</Text>
                        </TableData>
                        <TableData useRNView testID={testID} className={TD_CLS} style={{ flex: 1 }}>
                            <Text size="xs" className="text-white text-right" numberOfLines={1}>{v}</Text>
                        </TableData>
                    </TableRow>
                ))}
            </TableBody>
        </Table>
    </Box>
);

// ─── Screen ──────────────────────────────────────────────────────────────────

interface ObservabilityScreenProps {
    onBack?: () => void;
}

const ObservabilityScreen: React.FC<ObservabilityScreenProps> = ({ onBack }) => {
    const { t } = useTranslation();
    const insets = useSafeAreaInsets();

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
            const [breakdown, userCtx] = await Promise.all([
                getOpenedSeenBreakdown().catch(() => null),
                loadUserGeoLanguageContext(),
            ]);
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
                    userCtx,
                    nowMs: Date.now(),
                }),
            );
        } catch (err) {
            logger.warn('[ObservabilityScreen] feed funnel failed', { error: String(err) });
        }
    }, []);

    useEffect(() => { if (dbReady) void refresh(); }, [refresh, dbReady]);

    const [copied, setCopied] = useState(false);

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

    const schedulerStatusSub =
        runningCount > 0
            ? t('observability.running', { count: runningCount })
            : failedCount > 0
                ? t('observability.failed', { count: failedCount })
                : pendingCount > 0
                    ? t('observability.pending', { count: pendingCount })
                    : undefined;

    if (selectedTable) {
        return (
            <TableDetailScreen
                tableName={selectedTable}
                onBack={() => setSelectedTable(null)}
            />
        );
    }

    return (
        <Box className="flex-1 bg-black" style={{ paddingTop: insets.top }}>
            <HStack className="px-4 py-3 items-center justify-between">
                <Pressable onPress={onBack} className="bg-gray-900 rounded-full p-2" hitSlop={8}>
                    <MaterialIcons name="arrow-back" size={20} color="#ffffff" />
                </Pressable>
                <Text className="text-white font-semibold text-base">{t('observability.title')}</Text>
                <HStack space="sm" className="items-center">
                    <Pressable
                        onPress={() => void refresh()}
                        className="bg-gray-900 rounded-full p-2"
                        hitSlop={8}
                        disabled={loadingDb}
                    >
                        <MaterialIcons
                            name="refresh"
                            size={20}
                            color={loadingDb ? '#6b7280' : '#ffffff'}
                        />
                    </Pressable>
                    <Pressable
                        onPress={() => void handleCopy()}
                        className="bg-gray-900 rounded-full p-2"
                        hitSlop={8}
                    >
                        <MaterialIcons
                            name={copied ? 'check' : 'share'}
                            size={20}
                            color={copied ? '#10b981' : '#ffffff'}
                        />
                    </Pressable>
                </HStack>
            </HStack>

            <ScrollView
                className="flex-1"
                contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: insets.bottom + 24 }}
                showsVerticalScrollIndicator={false}
            >
                {/* Top metric cards */}
                <HStack space="sm" className="mb-2">
                    <MetricCard title={t('observability.articles')} value={String(articleCount)} />
                    <MetricCard
                        title={t('observability.relevant')}
                        value={String(relevantArticleCount)}
                        subtitle={`${relevantPct}%`}
                    />
                </HStack>
                <HStack space="sm">
                    <MetricCard title={t('observability.unscored')} value={String(unscoredCount)} />
                    <MetricCard
                        title={t('observability.scheduler')}
                        value={schedulerStatus}
                        subtitle={schedulerStatusSub}
                    />
                </HStack>

                {/* DB Tables */}
                <SectionHeader title={t('observability.dbTables')} />
                {dbStats ? (
                    <Box className="rounded-xl overflow-hidden border border-gray-800">
                        <Table className="w-full">
                            <TableHeader>
                                <TableRow>
                                    <TableHead useRNView className={TH_CLS} style={{ flex: 1 }}>
                                        <Text size="xs" className="text-gray-500 font-semibold uppercase">{t('observability.table')}</Text>
                                    </TableHead>
                                    <TableHead useRNView className={`${TH_CLS} items-end`} style={{ width: 90 }}>
                                        <Text size="xs" className="text-gray-500 font-semibold uppercase">{t('observability.rowsStatus')}</Text>
                                    </TableHead>
                                </TableRow>
                            </TableHeader>
                            <TableBody>
                                {dbTableRows.map(({ name, count, subtitle }, i) => (
                                    <TableRow key={name} className={i % 2 === 0 ? ROW_EVEN : ROW_ODD}>
                                        <TableData useRNView className="p-0" style={{ flex: 1 }}>
                                            <Pressable
                                                onPress={() => setSelectedTable(name)}
                                                className="flex-row items-center px-3 py-2.5"
                                            >
                                                <Box className="flex-1">
                                                    <Text size="xs" className="text-white">{tableLabel(name)}</Text>
                                                    {subtitle ? (
                                                        <Text size="xs" className="text-gray-500 mt-0.5">{subtitle}</Text>
                                                    ) : null}
                                                </Box>
                                                <MaterialIcons name="chevron-right" size={13} color="#4b5563" />
                                            </Pressable>
                                        </TableData>
                                        <TableData useRNView className={TD_CLS} style={{ width: 90 }}>
                                            <Text size="xs" className="text-white text-right">{count}</Text>
                                        </TableData>
                                    </TableRow>
                                ))}
                            </TableBody>
                        </Table>
                    </Box>
                ) : (
                    <Text size="sm" className="text-gray-600 py-2">
                        {loadingDb ? t('common.loading') : t('observability.notLoaded')}
                    </Text>
                )}

                {/* Scheduler Tasks */}
                <SectionHeader title={t('observability.schedulerTasks')} />
                {taskNames.length === 0 ? (
                    <Text size="sm" className="text-gray-600 py-2">{t('observability.noTasksYet')}</Text>
                ) : (
                    <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                        <Box className="rounded-xl overflow-hidden border border-gray-800">
                            <Table>
                                <TableHeader>
                                    <TableRow>
                                        <TableHead useRNView className={TH_CLS} style={{ width: 200 }}>
                                            <Text size="xs" className="text-gray-500 font-semibold uppercase">{t('observability.task')}</Text>
                                        </TableHead>
                                        <TableHead useRNView className={TH_CLS} style={{ width: 100 }}>
                                            <Text size="xs" className="text-gray-500 font-semibold uppercase">{t('observability.status')}</Text>
                                        </TableHead>
                                        <TableHead useRNView className={TH_CLS} style={{ width: 90 }}>
                                            <Text size="xs" className="text-gray-500 font-semibold uppercase">{t('observability.lastRun')}</Text>
                                        </TableHead>
                                        <TableHead useRNView className={TH_CLS} style={{ width: 90 }}>
                                            <Text size="xs" className="text-gray-500 font-semibold uppercase">{t('observability.progress')}</Text>
                                        </TableHead>
                                    </TableRow>
                                </TableHeader>
                                <TableBody>
                                    {taskNames.map((name, i) => {
                                        const status = taskCurrentStatus[name] ?? null;
                                        const progress: TaskProgress | null | undefined = taskProgress[name];
                                        const error = getTaskError(name);
                                        const rowCls = i % 2 === 0 ? ROW_EVEN : ROW_ODD;
                                        return (
                                            <React.Fragment key={name}>
                                                <TableRow className={rowCls}>
                                                    <TableData useRNView className={TD_CLS} style={{ width: 200 }}>
                                                        <Text size="xs" className="text-white" numberOfLines={1}>{TASK_LABELS[name] ?? humanizeKey(name)}</Text>
                                                    </TableData>
                                                    <TableData useRNView className={TD_CLS} style={{ width: 100 }}>
                                                        <HStack space="xs" className="items-center">
                                                            <Box
                                                                style={{
                                                                    width: 6,
                                                                    height: 6,
                                                                    borderRadius: 3,
                                                                    backgroundColor: statusDotColor(status),
                                                                    flexShrink: 0,
                                                                }}
                                                            />
                                                            <Text size="xs" className="text-gray-300">{statusLabel(status)}</Text>
                                                        </HStack>
                                                    </TableData>
                                                    <TableData useRNView className={TD_CLS} style={{ width: 90 }}>
                                                        <Text size="xs" className="text-gray-300">
                                                            {relativeTime(taskLastRun[name], t)}
                                                        </Text>
                                                    </TableData>
                                                    <TableData useRNView className={TD_CLS} style={{ width: 90 }}>
                                                        <Text size="xs" className="text-gray-300">
                                                            {progress?.current != null && progress?.total != null
                                                                ? `${progress.current}/${progress.total}`
                                                                : '—'}
                                                        </Text>
                                                    </TableData>
                                                </TableRow>
                                                {error ? (
                                                    <TableRow className={rowCls}>
                                                        <TableData
                                                            useRNView
                                                            className="px-3 py-1.5 border-b border-gray-800"
                                                            style={{ width: 480 }}
                                                        >
                                                            <Text size="xs" className="text-red-400" numberOfLines={2}>{error}</Text>
                                                        </TableData>
                                                    </TableRow>
                                                ) : null}
                                            </React.Fragment>
                                        );
                                    })}
                                </TableBody>
                            </Table>
                        </Box>
                    </ScrollView>
                )}

                {/* Feed */}
                <SectionHeader title={t('observability.feed')} />
                <KVTable rows={[
                    [FIELD_LABELS.articleCount, String(articleCount)],
                    [FIELD_LABELS.relevantArticleCount, String(relevantArticleCount)],
                    [FIELD_LABELS.unscoredCount, String(unscoredCount)],
                    [FIELD_LABELS.lastSyncAt, relativeTime(lastSyncAt, t)],
                ]} />

                {/* Feed funnel — why the feed shows N cards. Recomputed only by
                    `refresh` (mount + the header button), never on render. */}
                <SectionHeader title={t('observability.feedFunnel')} />
                {funnel ? (
                    <KVTable rows={feedFunnelRows(funnel, t)} />
                ) : (
                    <Text size="sm" className="text-gray-600 py-2">
                        {loadingDb ? t('common.loading') : t('observability.notLoaded')}
                    </Text>
                )}

                {/* Protocol */}
                <SectionHeader title={t('observability.protocol')} />
                <KVTable rows={[
                    [FIELD_LABELS.processingMode, humanizeValue(String(processingMode))],
                    [FIELD_LABELS.downloadProgress, `${downloadProgress}%`],
                    [FIELD_LABELS.isProcessing, humanizeValue(String(isProcessing))],
                ]} />

                {/* System */}
                <SectionHeader title={t('observability.system')} />
                <KVTable rows={[
                    [FIELD_LABELS.network, humanizeValue(isConnected ? 'connected' : 'offline')],
                    [FIELD_LABELS.db, humanizeValue(dbReady ? 'ready' : 'not ready')],
                ]} />

                {/* Settings */}
                <SectionHeader title={t('observability.settings')} />
                {dbStats ? (
                    dbStats.settings.length === 0 ? (
                        <Text size="sm" className="text-gray-600 py-2">{t('observability.noSettings')}</Text>
                    ) : (
                        <KVTable rows={dbStats.settings.map(({ key, value }) => [humanizeKey(key), value])} />
                    )
                ) : (
                    <Text size="sm" className="text-gray-600 py-2">
                        {loadingDb ? t('common.loading') : t('observability.notLoaded')}
                    </Text>
                )}
            </ScrollView>
        </Box>
    );
};

export default ObservabilityScreen;
