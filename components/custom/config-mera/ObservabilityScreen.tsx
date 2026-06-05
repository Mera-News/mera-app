import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ScrollView, Share } from 'react-native';
import { Q } from '@nozbe/watermelondb';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useShallow } from 'zustand/react/shallow';
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
import { VStack } from '@/components/ui/vstack';
import { Pressable } from '@/components/ui/pressable';
import { MaterialIcons } from '@expo/vector-icons';

// ─── Types ───────────────────────────────────────────────────────────────────

type DbStats = {
    tableCounts: Record<string, number>;
    schedulerJobsByStatus: Record<string, number>;
    inferenceJobsByStatus: Record<string, number>;
    settings: Array<{ key: string; value: string }>;
};

// ─── Constants ───────────────────────────────────────────────────────────────

const COUNT_TABLES = [
    'article_suggestions',
    'article_suggestion_facts',
    'publication_visits',
    'facts',
    'fact_topic_links',
    'user_topics',
    'noisy_user_topics',
    'user_personas',
] as const;

const SCHEDULER_STATUSES = [
    'pending', 'running', 'completed', 'failed', 'stale', 'cancelled', 'retrying',
] as const;

const INFERENCE_STATUSES = ['pending', 'running', 'done', 'failed'] as const;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function relativeTime(ms: number | null | undefined): string {
    if (!ms) return 'never';
    const diff = Date.now() - ms;
    if (diff < 60_000) return 'just now';
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
    if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
    return `${Math.floor(diff / 86_400_000)}d ago`;
}

function statusDotColor(status: string | null | undefined): string {
    if (!status) return '#6b7280';
    if (status === 'completed') return '#10b981';
    if (status === 'failed' || status === 'stale') return '#ef4444';
    if (status === 'running' || status === 'pending' || status === 'retrying') return '#f59e0b';
    return '#6b7280';
}

function formatStatusCounts(byStatus: Record<string, number>, statuses: readonly string[]): string {
    return statuses.map((s) => `${byStatus[s] ?? 0}${s[0]}`).join(' ');
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

// ─── Sub-components ──────────────────────────────────────────────────────────

const SectionHeader = ({ title }: { title: string }) => (
    <Box className="pt-5 pb-1.5 border-b border-gray-800 mb-1">
        <Text size="xs" className="text-gray-500 uppercase tracking-widest font-semibold">
            {title}
        </Text>
    </Box>
);

const Row = ({ label, value }: { label: string; value: string }) => (
    <HStack className="justify-between items-center py-1.5 border-b border-gray-900">
        <Text size="sm" className="text-gray-500 flex-1">{label}</Text>
        <Text size="sm" className="text-white ml-2 text-right" numberOfLines={1} style={{ maxWidth: '55%' }}>
            {value}
        </Text>
    </HStack>
);

const SettingsRow = ({ keyStr, value }: { keyStr: string; value: string }) => (
    <VStack className="py-1.5 border-b border-gray-900">
        <Text size="xs" className="text-gray-500">{keyStr}</Text>
        <Text size="xs" className="text-white mt-0.5 pl-2" numberOfLines={1}>→ {value}</Text>
    </VStack>
);

const MetricCard = ({ title, value, subtitle }: { title: string; value: string; subtitle?: string }) => (
    <Box className="flex-1 bg-gray-900 rounded-xl p-3 border border-gray-800">
        <Text size="xs" className="text-gray-500 mb-0.5" numberOfLines={1}>{title}</Text>
        <Text className="text-white font-bold text-2xl leading-8">{value}</Text>
        {subtitle ? <Text size="xs" className="text-gray-500 mt-0.5">{subtitle}</Text> : null}
    </Box>
);

const TaskCard = ({
    name,
    status,
    lastRun,
    progress,
    errorMessage,
}: {
    name: string;
    status: string | null;
    lastRun: number | null | undefined;
    progress: TaskProgress | null | undefined;
    errorMessage?: string;
}) => (
    <Box className="border border-gray-800 rounded-xl p-3 mb-2 bg-gray-900">
        <HStack className="justify-between items-center mb-1.5">
            <Text className="text-white font-semibold text-sm flex-1 mr-2" numberOfLines={1}>
                {name}
            </Text>
            <HStack className="items-center" space="xs">
                <Box
                    style={{
                        width: 8,
                        height: 8,
                        borderRadius: 4,
                        backgroundColor: statusDotColor(status),
                    }}
                />
                <Text size="xs" className="text-gray-400">{status ?? 'idle'}</Text>
            </HStack>
        </HStack>
        <Row label="last run" value={relativeTime(lastRun)} />
        {progress?.current != null && progress?.total != null ? (
            <Row label="progress" value={`${progress.current}/${progress.total}`} />
        ) : null}
        {errorMessage ? (
            <Text size="xs" className="text-red-400 mt-1.5" numberOfLines={2}>
                {errorMessage}
            </Text>
        ) : null}
    </Box>
);

// ─── Screen ──────────────────────────────────────────────────────────────────

interface ObservabilityScreenProps {
    onBack?: () => void;
}

const ObservabilityScreen: React.FC<ObservabilityScreenProps> = ({ onBack }) => {
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
        noisyDiscardedCount,
        asyncJobPhase,
        lastSyncAt,
        syncStatusMessage,
    } = useForYouStore(
        useShallow((s) => ({
            articleCount: s.articleCount,
            relevantArticleCount: s.relevantArticleCount,
            unscoredCount: s.unscoredCount,
            noisyDiscardedCount: s.noisyDiscardedCount,
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
                noisyDiscardedCount,
                asyncJobPhase,
                lastSyncAt,
                syncState: syncStatusMessage?.state ?? 'idle',
            },
            protocol: { processingMode, modelState, downloadProgress, isProcessing },
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
        pendingCount, articleCount, relevantArticleCount, unscoredCount, noisyDiscardedCount,
        asyncJobPhase, lastSyncAt, syncStatusMessage, processingMode, modelState,
        downloadProgress, isProcessing, isConnected, dbReady, userId,
    ]);

    const relevantPct = articleCount > 0 ? Math.round((relevantArticleCount / articleCount) * 100) : 0;

    const taskNames = useMemo(
        () =>
            Array.from(new Set([...Object.keys(taskCurrentStatus), ...Object.keys(taskLastRun)])).sort(),
        [taskCurrentStatus, taskLastRun],
    );

    const getTaskError = useCallback(
        (taskName: string): string | undefined =>
            Object.values(jobs).find(
                (j) => j.taskName === taskName && (j.status === 'failed' || j.status === 'stale'),
            )?.errorMessage ?? undefined,
        [jobs],
    );

    const schedulerStatusSub =
        runningCount > 0
            ? `${runningCount} running`
            : failedCount > 0
                ? `${failedCount} failed`
                : pendingCount > 0
                    ? `${pendingCount} pending`
                    : undefined;

    return (
        <Box className="flex-1 bg-black" style={{ paddingTop: insets.top }}>
            <HStack className="px-4 py-3 items-center justify-between">
                <Pressable
                    onPress={onBack}
                    className="bg-gray-900 rounded-full p-2"
                    hitSlop={8}
                >
                    <MaterialIcons name="arrow-back" size={20} color="#ffffff" />
                </Pressable>
                <Text className="text-white font-semibold text-base">Observability</Text>
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
                            name={copied ? 'check' : 'content-copy'}
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
                    <MetricCard title="Articles" value={String(articleCount)} />
                    <MetricCard
                        title="Relevant"
                        value={String(relevantArticleCount)}
                        subtitle={`${relevantPct}%`}
                    />
                </HStack>
                <HStack space="sm">
                    <MetricCard title="Unscored" value={String(unscoredCount)} />
                    <MetricCard
                        title="Scheduler"
                        value={schedulerStatus}
                        subtitle={schedulerStatusSub}
                    />
                </HStack>

                {/* Scheduler tasks */}
                <SectionHeader title="Scheduler Tasks" />
                {taskNames.length === 0 ? (
                    <Text size="sm" className="text-gray-600 py-2">No tasks registered yet</Text>
                ) : (
                    taskNames.map((name) => (
                        <TaskCard
                            key={name}
                            name={name}
                            status={taskCurrentStatus[name] ?? null}
                            lastRun={taskLastRun[name]}
                            progress={taskProgress[name] ?? null}
                            errorMessage={getTaskError(name)}
                        />
                    ))
                )}

                {/* Feed */}
                <SectionHeader title="Feed" />
                <Row label="articleCount" value={String(articleCount)} />
                <Row label="relevantArticleCount" value={String(relevantArticleCount)} />
                <Row label="unscoredCount" value={String(unscoredCount)} />
                <Row label="noisyDiscardedCount" value={String(noisyDiscardedCount)} />
                <Row label="asyncJobPhase" value={asyncJobPhase} />
                <Row label="lastSyncAt" value={relativeTime(lastSyncAt)} />
                <Row label="syncState" value={syncStatusMessage?.state ?? 'idle'} />

                {/* Protocol */}
                <SectionHeader title="Protocol" />
                <Row label="processingMode" value={String(processingMode)} />
                <Row label="modelState" value={modelState} />
                <Row label="downloadProgress" value={`${downloadProgress}%`} />
                <Row label="isProcessing" value={String(isProcessing)} />

                {/* System */}
                <SectionHeader title="System" />
                <Row label="network" value={isConnected ? 'connected' : 'offline'} />
                <Row label="db" value={dbReady ? 'ready' : 'not ready'} />
                <Row label="schemaVersion" value={String(schema.version)} />
                <Row label="userId" value={userId ? `${userId.slice(0, 8)}…` : 'null'} />

                {/* DB Tables */}
                <SectionHeader title="DB Tables" />
                {dbStats ? (
                    <>
                        {COUNT_TABLES.map((name) => (
                            <Row key={name} label={name} value={String(dbStats.tableCounts[name] ?? '…')} />
                        ))}
                        <Row
                            label="scheduler_jobs"
                            value={formatStatusCounts(dbStats.schedulerJobsByStatus, SCHEDULER_STATUSES)}
                        />
                        <Row
                            label="inference_jobs"
                            value={formatStatusCounts(dbStats.inferenceJobsByStatus, INFERENCE_STATUSES)}
                        />
                    </>
                ) : (
                    <Text size="sm" className="text-gray-600 py-2">
                        {loadingDb ? 'Loading…' : 'Not loaded'}
                    </Text>
                )}

                {/* Settings */}
                <SectionHeader title="Settings" />
                {dbStats ? (
                    dbStats.settings.length === 0 ? (
                        <Text size="sm" className="text-gray-600 py-2">No settings</Text>
                    ) : (
                        dbStats.settings.map(({ key, value }) => (
                            <SettingsRow key={key} keyStr={key} value={value} />
                        ))
                    )
                ) : (
                    <Text size="sm" className="text-gray-600 py-2">
                        {loadingDb ? 'Loading…' : 'Not loaded'}
                    </Text>
                )}
            </ScrollView>
        </Box>
    );
};

export default ObservabilityScreen;
