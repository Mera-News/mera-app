import { Box } from '@/components/ui/box';
import { HStack } from '@/components/ui/hstack';
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import { useFeedCounts } from '@/lib/hooks/use-feed-counts';
import { SCORING_ERROR_I18N_KEYS } from '@/lib/services/scoring-error';
import { useAppLanguage } from '@/lib/stores/app-language-store';
import {
    useForYouAsyncJobPhase,
    useForYouAsyncJobProcessedCount,
    useForYouAsyncJobTotalCount,
    useForYouBatchProgress,
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
import { pickScoringProgress, STATUS_INK } from './status-ink';

const ACCENT = 'rgb(231, 138, 83)'; // primary-400

export interface FeedStatusDetailsProps {
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
            <Text size="sm" style={{ color: STATUS_INK.secondary }}>
                {label}
            </Text>
            <Text size="sm" className="font-semibold" style={{ color: STATUS_INK.primary }}>
                {value}
            </Text>
        </HStack>
    );
}

/**
 * The shared feed-status detail body. This is the single source of truth for the
 * copy + selectors the four legacy header banners used to show — current pipeline
 * stage, cloud/device progress, the processed/analysed/relevant counts,
 * last-processed time, the daily-limit notice, and any scoring error. It is
 * rendered in TWO places: inside the FeedStatusSheet modal body, and inline in
 * the FeedStatusShimmer expand accordion — so the copy is never duplicated.
 */
const FeedStatusDetails: React.FC<FeedStatusDetailsProps> = ({
    lastProcessedLabel,
    onBeforeNavigate,
}) => {
    const { t } = useTranslation();
    const tAny = t as any;
    const appLanguage = useAppLanguage();
    const router = useRouter();
    // Read here rather than passed in, from the shared minute-clock hook, so the
    // panel, the sheet and the header sentence cannot show different numbers.
    const { articleCount: processedCount, analysedCount, relevantCount } = useFeedCounts();
    const batchProgress = useForYouBatchProgress();

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
    // Formatted in the DEVICE's timezone from an absolute instant, which is what
    // keeps this correct west of UTC. The cap resets at 00:00 UTC, which is 5pm
    // the SAME DAY in Los Angeles, so any copy saying "tomorrow" would be false
    // for a large share of users. There is deliberately no untimed branch:
    // `FeedSyncMachine` falls back to `nextUtcMidnightMs()` whenever the server
    // omits `resetAt`, so a reset instant always exists. The untimed
    // `feed.dailyLimit.body` string still exists in all 20 dictionaries and has
    // NO consumer — do not wire it up.
    const dailyResetTime = dailyLimitResetAt
        ? new Date(dailyLimitResetAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
        : '';

    // ONE figure for scoring progress, shared with the panel's "Analysing X of
    // Y" line; the cloud sweep's synced-id counter used to sit beside it with a
    // different total.
    const cloudProgress = pickScoringProgress(batchProgress, asyncJobProcessedCount, asyncJobTotalCount);
    const showCloudProgress = cloudProgress !== null;
    const showDeviceProgress = deviceTotalCount > 0;

    const errorKeys = scoringError ? SCORING_ERROR_I18N_KEYS[scoringError] : null;

    return (
        <VStack space="md" className="py-1">
            {/* Current stage */}
            <HStack className="items-center" space="sm">
                <MaterialIcons name="sync" size={18} color={ACCENT} />
                <Text size="sm" className="font-semibold flex-1" style={{ color: STATUS_INK.primary }}>
                    {stageMessage}
                </Text>
            </HStack>

            {(showCloudProgress || showDeviceProgress) && (
                <VStack space="xs">
                    {cloudProgress && (
                        <StatRow
                            label={t('feedStatus.cloudProgress')}
                            value={`${formatCount(cloudProgress.done, appLanguage)} / ${formatCount(cloudProgress.total, appLanguage)}`}
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

            <Box style={{ height: 1, backgroundColor: STATUS_INK.divider }} />

            {/* Counts */}
            <VStack>
                <StatRow label={t('feedStatus.published')} value={formatCount(processedCount, appLanguage)} />
                <StatRow label={t('feedStatus.analysed')} value={formatCount(analysedCount, appLanguage)} />
                <StatRow label={t('feedStatus.relevant')} value={formatCount(relevantCount, appLanguage)} />
            </VStack>

            {lastProcessedLabel && (
                <StatRow label={t('feedStatus.lastProcessed')} value={lastProcessedLabel} />
            )}

            {/* Daily limit. The cap is PER-TIER: 250 Starter, which is what every
                unpaid account now gets, then 1000 Individual and 10000
                Professional. There is no separate free number because free and
                Starter are the same thing. Every plan can reach this. */}
            {isDailyLimited && (
                <Box testID="feed-status-daily-limit" className="bg-warning-900 rounded-lg px-3 py-2">
                    <Text size="sm" className="text-warning-400 font-semibold">
                        {t('feed.dailyLimit.title')}
                    </Text>
                    <Text size="xs" className="mt-1" style={{ color: STATUS_INK.secondary }}>
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
                            accessibilityLabel={t('subscription.managePlan')}
                            testID="feed-status-manage-subscription"
                            className="bg-primary-500 rounded-full px-2.5 py-1"
                        >
                            <HStack className="items-center" space="xs">
                                <MaterialIcons name="credit-card" size={12} color="#ffffff" />
                                <Text size="xs" className="text-white font-semibold">
                                    {t('subscription.managePlan')}
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
                    <Text size="xs" className="mt-1" style={{ color: STATUS_INK.secondary }}>
                        {t(errorKeys.message)}
                    </Text>
                </Box>
            )}
        </VStack>
    );
};

export default FeedStatusDetails;
