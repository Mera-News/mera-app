import { Box } from '@/components/ui/box';
import { Button, ButtonText } from '@/components/ui/button';
import { Heading } from '@/components/ui/heading';
import { HStack } from '@/components/ui/hstack';
import {
    Modal,
    ModalBackdrop,
    ModalBody,
    ModalContent,
    ModalFooter,
    ModalHeader,
} from '@/components/ui/modal';
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import { SCORING_ERROR_I18N_KEYS } from '@/lib/services/scoring-error';
import {
    useForYouAsyncJobPhase,
    useForYouAsyncJobProcessedCount,
    useForYouAsyncJobTotalCount,
    useForYouDailyLimitResetAt,
    useForYouDeviceProcessing,
    useForYouScoringError,
    useForYouSyncStatusMessage,
} from '@/lib/stores/selectors';
import { MaterialIcons } from '@expo/vector-icons';
import React from 'react';
import { useTranslation } from 'react-i18next';

const ACCENT = 'rgb(231, 138, 83)'; // primary-400

interface FeedStatusSheetProps {
    readonly isOpen: boolean;
    readonly onClose: () => void;
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

/**
 * The feed-status detail sheet (Gluestack Modal), opened from the header status
 * line or the status shimmer. It consolidates everything the four legacy
 * header banners used to show — current pipeline stage, cloud/device progress,
 * the processed/analysed/relevant/noise counts, last-processed time, the
 * daily-limit notice, and any scoring error — into one on-demand surface.
 */
const FeedStatusSheet: React.FC<FeedStatusSheetProps> = ({
    isOpen,
    onClose,
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

    const isSyncActive =
        syncStatusMessage !== null &&
        syncStatusMessage.state !== 'idle' &&
        syncStatusMessage.state !== 'done' &&
        syncStatusMessage.state !== 'failed' &&
        syncStatusMessage.state !== 'paused-offline';

    // Current stage headline — cloud/device phases take precedence over the raw
    // sync-machine state, mirroring the old SyncProgressForYouBanner labelling.
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
        <Modal isOpen={isOpen} onClose={onClose} size="md">
            <ModalBackdrop />
            <ModalContent className="bg-gray-950 border border-gray-800">
                <ModalHeader>
                    <Heading size="lg" className="text-white">
                        {t('feedStatus.title')}
                    </Heading>
                </ModalHeader>
                <ModalBody>
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
                </ModalBody>
                <ModalFooter>
                    <Button className="flex-1 bg-primary-400" onPress={onClose}>
                        <ButtonText>{t('feedStatus.close')}</ButtonText>
                    </Button>
                </ModalFooter>
            </ModalContent>
        </Modal>
    );
};

export default FeedStatusSheet;
