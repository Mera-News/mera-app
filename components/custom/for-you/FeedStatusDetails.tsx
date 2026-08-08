import { Box } from '@/components/ui/box';
import { HStack } from '@/components/ui/hstack';
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import { SCORING_ERROR_I18N_KEYS } from '@/lib/services/scoring-error';
import { useAppLanguage } from '@/lib/stores/app-language-store';
import {
    useForYouAsyncJobPhase,
    useForYouAsyncJobProcessedCount,
    useForYouAsyncJobTotalCount,
    useForYouDailyLimitResetAt,
    useForYouDeviceProcessing,
    useForYouScoringError,
    useForYouSyncStatusMessage,
} from '@/lib/stores/selectors';
import { formatCount } from '@/lib/utils/format-count';
import { MaterialIcons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import React from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable } from '@/components/ui/pressable';

const ACCENT = 'rgb(231, 138, 83)'; // primary-400

export interface FeedStatusDetailsProps {
    /** Articles published across the app's sources this cycle (store `articleCount`) —
     *  NOT a device download count. Rendered against `feedStatus.published`. */
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
    /**
     * Called right before the daily-limit "Manage" pill navigates. The sheet
     * passes its `onClose` here: the body renders inside an RN Modal, and a
     * `router.push` out of an open modal leaves the pushed screen stranded
     * behind the backdrop. The inline shimmer accordion is not a modal, so it
     * passes nothing.
     */
    readonly onBeforeNavigate?: () => void;
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
    onBeforeNavigate,
}) => {
    const { t } = useTranslation();
    const tAny = t as any;
    const appLanguage = useAppLanguage();
    const router = useRouter();

    const syncStatusMessage = useForYouSyncStatusMessage();
    const asyncJobPhase = useForYouAsyncJobPhase();
    const asyncJobProcessedCount = useForYouAsyncJobProcessedCount();
    const asyncJobTotalCount = useForYouAsyncJobTotalCount();
    const { isDeviceProcessing, deviceProcessedCount, deviceTotalCount } = useForYouDeviceProcessing();
    const scoringError = useForYouScoringError();
    const dailyLimitResetAt = useForYouDailyLimitResetAt();

    const isSyncActive =
        syncStatusMessage !== null &&
        syncStatusMessage.state !== 'idle' &&
        syncStatusMessage.state !== 'done' &&
        syncStatusMessage.state !== 'failed' &&
        syncStatusMessage.state !== 'paused-offline';

    // Current stage headline — cloud/device phases take precedence over the raw
    // sync-machine state, mirroring the old SyncProgressForYouBanner labelling.
    // (Round-4 B removed the per-fact narration — batches are generic quanta.)
    const stageMessage =
        asyncJobPhase === 'relevance'
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
                            value={`${formatCount(asyncJobProcessedCount, appLanguage)} / ${formatCount(asyncJobTotalCount, appLanguage)}`}
                        />
                    )}
                    {showDeviceProgress && (
                        <StatRow
                            label={t('feedStatus.deviceProgress')}
                            value={`${formatCount(deviceProcessedCount, appLanguage)} / ${formatCount(deviceTotalCount, appLanguage)}`}
                        />
                    )}
                </VStack>
            )}

            <Box style={{ height: 1, backgroundColor: '#1f2937' }} />

            {/* Counts */}
            <VStack>
                <StatRow label={t('feedStatus.published')} value={formatCount(processedCount, appLanguage)} />
                <StatRow label={t('feedStatus.analysed')} value={formatCount(analysedCount, appLanguage)} />
                <StatRow label={t('feedStatus.relevant')} value={formatCount(relevantCount, appLanguage)} />
                {showNoise && (
                    <StatRow label={t('feedStatus.noiseRemoved')} value={formatCount(noiseRemovedCount, appLanguage)} />
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
                    <Text size="xs" className="text-typography-300 mt-1">
                        {t('feed.dailyLimit.bodyWithTime', { time: dailyResetTime })}
                    </Text>
                    {/* Same pill as the Profile usage card, and the same
                        destination — the cap is a plan limit, so management (which
                        is where Upgrade lives) is the one useful action here. */}
                    <HStack className="justify-end mt-2">
                        <Pressable
                            onPress={() => {
                                onBeforeNavigate?.();
                                router.push('/logged-in/preferences/manage-subscription' as any);
                            }}
                            hitSlop={8}
                            accessibilityRole="button"
                            accessibilityLabel={t('subscription.manageBadge')}
                            testID="feed-status-manage-subscription"
                            className="bg-primary-500 rounded-full px-2.5 py-1"
                        >
                            <HStack className="items-center" space="xs">
                                <MaterialIcons name="credit-card" size={12} color="#ffffff" />
                                <Text size="xs" className="text-white font-semibold">
                                    {t('subscription.manageBadge')}
                                </Text>
                            </HStack>
                        </Pressable>
                    </HStack>
                </Box>
            )}

            {/* Scoring error */}
            {errorKeys && (
                <Box className="bg-error-950 border border-error-900 rounded-lg px-3 py-2">
                    <Text size="sm" className="text-red-400 font-semibold">
                        {t('feedStatus.errorTitle')}
                    </Text>
                    <Text size="xs" className="text-typography-300 mt-1">
                        {t(errorKeys.message)}
                    </Text>
                </Box>
            )}
        </VStack>
    );
};

export default FeedStatusDetails;
