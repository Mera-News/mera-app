import { Box } from '@/components/ui/box';
import { HStack } from '@/components/ui/hstack';
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import { SCORING_ERROR_I18N_KEYS } from '@/lib/services/scoring-error';
import type { PipelineFactStage } from '@/lib/stores/for-you-store';
import {
    useForYouAsyncJobPhase,
    useForYouAsyncJobProcessedCount,
    useForYouAsyncJobTotalCount,
    useForYouDailyLimitResetAt,
    useForYouDeviceProcessing,
    useForYouFactStages,
    useForYouScoringError,
    useForYouSyncStatusMessage,
} from '@/lib/stores/selectors';
import { MaterialIcons } from '@expo/vector-icons';
import React from 'react';
import { useTranslation } from 'react-i18next';

const ACCENT = 'rgb(231, 138, 83)'; // primary-400

export interface FeedStatusDetailsProps {
    /** Articles pulled this cycle (store `articleCount`). */
    readonly processedCount: number;
    /** Scored + in-window rows. */
    readonly analysedCount: number;
    /** Analysed rows above the render gate. */
    readonly relevantCount: number;
    /** Decoy clusters dropped by the noise-removal step. */
    readonly noiseRemovedCount: number;
    /** Whether the inject-noise beta setting is on (gates the noise row). */
    readonly injectNoiseEnabled: boolean;
    /** Human relative label for the last finished processing run, or null. */
    readonly lastProcessedLabel: string | null;
}

function StatRow({ label, value }: { label: string; value: string | number }) {
    return (
        <HStack className="items-center justify-between py-1">
            <Text size="sm" className="text-typography-400">
                {label}
            </Text>
            <Text size="sm" className="text-white font-semibold">
                {value}
            </Text>
        </HStack>
    );
}

const FACT_PHASE_ICON: Record<PipelineFactStage['phase'], { name: React.ComponentProps<typeof MaterialIcons>['name']; color: string }> = {
    done: { name: 'check-circle', color: '#34d399' },
    working: { name: 'sync', color: ACCENT },
    queued: { name: 'schedule', color: '#6b7280' },
};

function FactStageRow({ stage, fallbackLabel }: { stage: PipelineFactStage; fallbackLabel: string }) {
    const icon = FACT_PHASE_ICON[stage.phase];
    const label = stage.statement ?? fallbackLabel;
    return (
        <HStack className="items-center" space="sm">
            <MaterialIcons name={icon.name} size={14} color={icon.color} />
            <Text size="xs" className="text-typography-400 flex-1" numberOfLines={1}>
                {label}
            </Text>
        </HStack>
    );
}

/**
 * The shared feed-status detail body. This is the single source of truth for the
 * copy + selectors the four legacy header banners used to show — current pipeline
 * stage, cloud/device progress, the processed/analysed/relevant/noise counts,
 * last-processed time, the daily-limit notice, and any scoring error. It is
 * rendered in TWO places: inside the FeedStatusSheet modal body, and inline in
 * the FeedStatusShimmer expand accordion — so the copy is never duplicated.
 */
const FeedStatusDetails: React.FC<FeedStatusDetailsProps> = ({
    processedCount,
    analysedCount,
    relevantCount,
    noiseRemovedCount,
    injectNoiseEnabled,
    lastProcessedLabel,
}) => {
    const { t } = useTranslation();
    const tAny = t as any;

    const syncStatusMessage = useForYouSyncStatusMessage();
    const asyncJobPhase = useForYouAsyncJobPhase();
    const asyncJobProcessedCount = useForYouAsyncJobProcessedCount();
    const asyncJobTotalCount = useForYouAsyncJobTotalCount();
    const { isDeviceProcessing, deviceProcessedCount, deviceTotalCount } = useForYouDeviceProcessing();
    const scoringError = useForYouScoringError();
    const dailyLimitResetAt = useForYouDailyLimitResetAt();
    const factStages = useForYouFactStages();

    const isSyncActive =
        syncStatusMessage !== null &&
        syncStatusMessage.state !== 'idle' &&
        syncStatusMessage.state !== 'done' &&
        syncStatusMessage.state !== 'failed' &&
        syncStatusMessage.state !== 'paused-offline';

    const otherStoriesLabel = t('feed.factStages.otherStories');

    // The first not-yet-done fact stage — a 'working' stage takes precedence
    // over the next 'queued' one, so the headline narrates whichever fact the
    // pipeline is actively on.
    const activeStage =
        factStages.find((stage) => stage.phase === 'working') ??
        factStages.find((stage) => stage.phase === 'queued');

    // Current stage headline — cloud/device phases take precedence over the raw
    // sync-machine state, mirroring the old SyncProgressForYouBanner labelling.
    // When a fact-pipelined run is active, narrate the specific fact being
    // worked on instead of the generic relevance/reasons title.
    const stageMessage =
        activeStage && (asyncJobPhase === 'relevance' || asyncJobPhase === 'reasons')
            ? tAny(asyncJobPhase === 'reasons' ? 'feed.factStages.writing' : 'feed.factStages.reading', {
                  fact: activeStage.statement ?? otherStoriesLabel,
              })
            : asyncJobPhase === 'relevance'
                ? tAny('feed.syncToast.relevanceTitle')
                : asyncJobPhase === 'reasons'
                    ? tAny('feed.syncToast.reasonsTitle')
                    : isDeviceProcessing
                        ? tAny('feed.syncToast.onDeviceTitle')
                        : isSyncActive && syncStatusMessage?.headlineKey
                            ? tAny(syncStatusMessage.headlineKey)
                            : t('feedStatus.idle');

    const isDailyLimited = dailyLimitResetAt != null && Date.now() < dailyLimitResetAt;
    const dailyResetTime = dailyLimitResetAt
        ? new Date(dailyLimitResetAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
        : '';

    const showNoise = injectNoiseEnabled && noiseRemovedCount > 0;
    const showCloudProgress = asyncJobTotalCount > 0;
    const showDeviceProgress = deviceTotalCount > 0;

    const errorKeys = scoringError ? SCORING_ERROR_I18N_KEYS[scoringError] : null;

    return (
        <VStack space="md" className="py-1">
            {/* Current stage */}
            <HStack className="items-center" space="sm">
                <MaterialIcons name="sync" size={18} color={ACCENT} />
                <Text size="sm" className="text-white font-semibold flex-1">
                    {stageMessage}
                </Text>
            </HStack>

            {(showCloudProgress || showDeviceProgress) && (
                <VStack space="xs">
                    {showCloudProgress && (
                        <StatRow
                            label={t('feedStatus.cloudProgress')}
                            value={`${asyncJobProcessedCount} / ${asyncJobTotalCount}`}
                        />
                    )}
                    {showDeviceProgress && (
                        <StatRow
                            label={t('feedStatus.deviceProgress')}
                            value={`${deviceProcessedCount} / ${deviceTotalCount}`}
                        />
                    )}
                </VStack>
            )}

            {factStages.length > 0 && (
                <VStack space="xs">
                    {factStages.map((stage, index) => (
                        <FactStageRow
                            key={stage.factId ?? `other-${index}`}
                            stage={stage}
                            fallbackLabel={otherStoriesLabel}
                        />
                    ))}
                </VStack>
            )}

            <Box style={{ height: 1, backgroundColor: '#1f2937' }} />

            {/* Counts */}
            <VStack>
                <StatRow label={t('feedStatus.processed')} value={processedCount} />
                <StatRow label={t('feedStatus.analysed')} value={analysedCount} />
                <StatRow label={t('feedStatus.relevant')} value={relevantCount} />
                {showNoise && (
                    <StatRow label={t('feedStatus.noiseRemoved')} value={noiseRemovedCount} />
                )}
            </VStack>

            {lastProcessedLabel && (
                <StatRow label={t('feedStatus.lastProcessed')} value={lastProcessedLabel} />
            )}

            {/* Daily limit */}
            {isDailyLimited && (
                <Box className="bg-warning-900 rounded-lg px-3 py-2">
                    <Text size="sm" className="text-warning-400 font-semibold">
                        {t('feed.dailyLimit.title')}
                    </Text>
                    <Text size="xs" className="text-typography-300 leading-4 mt-1">
                        {t('feed.dailyLimit.bodyWithTime', { time: dailyResetTime })}
                    </Text>
                </Box>
            )}

            {/* Scoring error */}
            {errorKeys && (
                <Box className="bg-error-950 border border-error-900 rounded-lg px-3 py-2">
                    <Text size="sm" className="text-red-400 font-semibold">
                        {t('feedStatus.errorTitle')}
                    </Text>
                    <Text size="xs" className="text-typography-300 leading-4 mt-1">
                        {t(errorKeys.message)}
                    </Text>
                </Box>
            )}
        </VStack>
    );
};

export default FeedStatusDetails;
