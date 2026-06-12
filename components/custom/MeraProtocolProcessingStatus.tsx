import { HStack } from '@/components/ui/hstack';
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import { MaterialIcons } from '@expo/vector-icons';
import type { SyncStatusMessage } from '@/lib/scheduler/feed-sync/feed-sync-types';
import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated';

export type ProcessingStage =
    | 'idle'
    | 'sending'
    | 'hydrating'
    | 'noiseRemoval'
    | 'cloudRelevance'
    | 'cloudReasons'
    | 'onDevice'
    | 'done'
    | 'error';

interface MeraProtocolProcessingStatusProps {
    syncStatusMessage?: SyncStatusMessage | null;
    // Legacy stage props — used when syncStatusMessage is null (async job phases)
    stage?: ProcessingStage;
    processedCount?: number;
    totalCount?: number;
    asyncJobTotalCount?: number;
    hydrationCompleted?: number;
    hydrationTotal?: number;
    errorMessage?: string | null;
}

const HEADLINE_CYCLE_MS = 5000;

/** Maps FeedSyncState to the legacy ProcessingStage used by i18n keys. */
function syncStateToLegacyStage(
    message: SyncStatusMessage,
    isDeviceProcessing: boolean,
    asyncJobPhase: 'idle' | 'relevance' | 'reasons',
): ProcessingStage {
    switch (message.state) {
        case 'fetching-topic-ids': return 'sending';
        case 'diffing': return 'noiseRemoval';
        case 'hydrating': return 'hydrating';
        case 'persisting': return 'noiseRemoval';
        case 'scoring':
            if (asyncJobPhase === 'relevance') return 'cloudRelevance';
            if (asyncJobPhase === 'reasons') return 'cloudReasons';
            if (isDeviceProcessing) return 'onDevice';
            return 'sending';
        case 'done': return 'done';
        case 'paused-offline': return 'error';
        case 'failed': return 'error';
        default: return 'idle';
    }
}

/** Kept for backwards compatibility — ForYouScreen can pass the derived stage
 *  directly when asyncJobPhase drives the display (after FeedSyncMachine is done). */
export function deriveProcessingStage(
    isOnDeviceProcessing: boolean,
    asyncJobPhase: 'idle' | 'relevance' | 'reasons',
    syncStatusMessage: SyncStatusMessage | null,
    hydrationTotal: number,
): ProcessingStage {
    if (syncStatusMessage) {
        if (syncStatusMessage.state === 'failed') return 'error';
        if (syncStatusMessage.state === 'hydrating' && hydrationTotal > 0) return 'hydrating';
        if (syncStatusMessage.state === 'persisting') return 'noiseRemoval';
        return syncStateToLegacyStage(syncStatusMessage, isOnDeviceProcessing, asyncJobPhase);
    }
    if (asyncJobPhase === 'relevance') return 'cloudRelevance';
    if (asyncJobPhase === 'reasons') return 'cloudReasons';
    if (isOnDeviceProcessing) return 'onDevice';
    return 'idle';
}

const MeraProtocolProcessingStatus: React.FC<MeraProtocolProcessingStatusProps> = ({
    syncStatusMessage,
    stage: stageProp,
    processedCount = 0,
    totalCount = 0,
    asyncJobTotalCount = 0,
    hydrationCompleted = 0,
    hydrationTotal = 0,
    errorMessage = null,
}) => {
    const { t } = useTranslation();

    // Resolve the effective stage — prefer syncStatusMessage, fall back to stageProp
    const stage: ProcessingStage = useMemo(() => {
        if (stageProp !== undefined) return stageProp;
        if (!syncStatusMessage || syncStatusMessage.state === 'idle') return 'idle';
        if (syncStatusMessage.state === 'done') return 'done';
        if (syncStatusMessage.state === 'failed' || syncStatusMessage.state === 'paused-offline') return 'error';
        if (syncStatusMessage.state === 'hydrating') return 'hydrating';
        if (syncStatusMessage.state === 'persisting') return 'noiseRemoval';
        if (syncStatusMessage.state === 'fetching-topic-ids') return 'sending';
        if (syncStatusMessage.state === 'diffing') return 'noiseRemoval';
        if (syncStatusMessage.state === 'scoring') return 'sending';
        return 'idle';
    }, [stageProp, syncStatusMessage]);

    // Resolve error message — prefer syncStatusMessage.headlineKey for offline/auth
    const resolvedErrorMessage = useMemo(() => {
        if (errorMessage) return errorMessage;
        if (syncStatusMessage?.state === 'paused-offline') return t('sync.waitingForConnection');
        if (syncStatusMessage?.state === 'failed') {
            return t(syncStatusMessage.headlineKey, {
                defaultValue: t('feed.processing.errorFlash'),
            });
        }
        return null;
    }, [errorMessage, syncStatusMessage, t]);

    const stageCopy = useMemo(() => {
        if (stage === 'idle' || stage === 'done' || stage === 'error') return null;
        // The key is dynamic over every ProcessingStage, but only some stages
        // have headline copy in the locale files; the rest fall back to the
        // empty `defaultValue` at runtime. Cast the key to a known headlines
        // key so the typed-i18n `returnObjects` overload resolves to string[].
        const headlinesKey =
            `feed.processing.stages.${stage}.headlines` as 'feed.processing.stages.fetching.headlines';
        const headlines = t(headlinesKey, {
            returnObjects: true,
            defaultValue: [] as string[],
        });
        const amberKey = `feed.processing.stages.${stage}.amberSubline`;
        const amber = t(amberKey, { defaultValue: '' });
        return { headlines, amberSubline: amber || undefined };
    }, [stage, t]);

    const [headlineIndex, setHeadlineIndex] = useState(0);
    useEffect(() => {
        setHeadlineIndex(0);
        if (!stageCopy || stageCopy.headlines.length <= 1) return;
        const total = stageCopy.headlines.length;
        const interval = setInterval(() => {
            setHeadlineIndex((i) => (i + 1) % total);
        }, HEADLINE_CYCLE_MS);
        return () => clearInterval(interval);
    }, [stage, stageCopy]);

    const progressLabel = useMemo(() => {
        if (stage === 'hydrating' && hydrationTotal > 0) {
            return `${hydrationCompleted}/${hydrationTotal}`;
        }
        if (syncStatusMessage?.progress) {
            return `${syncStatusMessage.progress.current}/${syncStatusMessage.progress.total}`;
        }
        if (stage === 'cloudRelevance' && asyncJobTotalCount > 0) {
            return `${asyncJobTotalCount}`;
        }
        if (stage === 'onDevice' && totalCount > 0) {
            return `${processedCount}/${totalCount}`;
        }
        return '';
    }, [stage, hydrationCompleted, hydrationTotal, asyncJobTotalCount, processedCount, totalCount, syncStatusMessage]);

    if (stage === 'done') {
        return (
            <HStack className="items-center" space="xs">
                <MaterialIcons name="check-circle" size={16} color="#10B981" />
                <Text size="sm" className="text-typography-300">
                    {t('feed.processing.doneFlash')}
                </Text>
            </HStack>
        );
    }

    if (stage === 'error') {
        const message =
            resolvedErrorMessage ||
            t('feed.processing.errorFlash', {
                defaultValue: "We couldn't load the latest content. Please try again.",
            });
        return (
            <HStack className="items-center" space="xs">
                <MaterialIcons name="error" size={16} color="#EF4444" />
                <Text size="sm" className="text-red-400 flex-1">
                    {message}
                </Text>
            </HStack>
        );
    }

    if (stage === 'idle') return null;

    const headline =
        stageCopy && stageCopy.headlines.length > 0
            ? stageCopy.headlines[headlineIndex] ?? stageCopy.headlines[0]
            : '';

    return (
        <VStack space="xs">
            <HStack className="items-start" space="sm">
                <Animated.View
                    key={`${stage}-${headlineIndex}`}
                    entering={FadeIn.duration(300)}
                    exiting={FadeOut.duration(300)}
                    style={{ flex: 1 }}
                >
                    <Text size="sm" className="text-typography-300 leading-5">
                        {headline}
                    </Text>
                </Animated.View>
                {progressLabel ? (
                    <Text size="xs" className="text-typography-500 leading-5">
                        {progressLabel}
                    </Text>
                ) : null}
            </HStack>
            {stageCopy?.amberSubline && (
                <Text size="xs" className="text-amber-400 leading-4">
                    {stageCopy.amberSubline}
                </Text>
            )}
        </VStack>
    );
};

export default MeraProtocolProcessingStatus;
