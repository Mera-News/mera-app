import React, { useCallback, useEffect, useMemo, useState } from 'react';
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
import { useSchedulerStore } from '@/lib/scheduler/scheduler-store';
import { useForYouStore } from '@/lib/stores/for-you-store';
import { useMeraProtocolStore } from '@/lib/stores/mera-protocol-store';
import { useNetworkStore } from '@/lib/stores/network-store';
import { useDatabaseStore } from '@/lib/stores/database-store';
import { useUserStore } from '@/lib/stores/user-store';
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
    if (!ms) return t('observability.never');
    const diff = Date.now() - ms;
    if (diff < 60_000) return t('feed.justNow');
    if (diff < 3_600_000) return t('feed.minutesAgo', { count: Math.floor(diff / 60_000) });
    if (diff < 86_400_000) return t('feed.hoursAgo', { count: Math.floor(diff / 3_600_000) });
    return t('feed.daysAgo', { count: Math.floor(diff / 86_400_000) });
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
const KVTable = ({ rows }: { rows: [string, string][] }) => (
    <Box className="rounded-xl overflow-hidden border border-gray-800">
        <Table className="w-full">
            <TableBody>
                {rows.map(([k, v], i) => (
                    <TableRow key={k} className={i % 2 === 0 ? ROW_EVEN : ROW_ODD}>
                        <TableData useRNView className={TD_CLS} style={{ flex: 1 }}>
                            <Text size="xs" className="text-gray-400">{k}</Text>
                        </TableData>
                        <TableData useRNView className={TD_CLS} style={{ flex: 1 }}>
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

    const refresh = useCallback(async () => {
        setLoadingDb(true);
        try {
            setDbStats(await loadDbStats());
        } catch (err) {
            logger.warn('[ObservabilityScreen] loadDbStats failed', { error: String(err) });
        } finally {
            setLoadingDb(false);
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
        downloadProgress, isProcessing, isConnected, dbReady, userId,
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
