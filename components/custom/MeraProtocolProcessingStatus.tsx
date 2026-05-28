import { HStack } from '@/components/ui/hstack';
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import { MaterialIcons } from '@expo/vector-icons';
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
    stage: ProcessingStage;
    processedCount: number;
    totalCount: number;
    asyncJobTotalCount?: number;
    hydrationCompleted?: number;
    hydrationTotal?: number;
    errorMessage?: string | null;
}

const HEADLINE_CYCLE_MS = 5000;

export function deriveProcessingStage(
    isOnDeviceProcessing: boolean,
    asyncJobPhase: 'idle' | 'relevance' | 'reasons',
    syncStatus: 'idle' | 'syncing' | 'filtering-noise' | 'scoring' | 'error',
    hydrationTotal: number,
): ProcessingStage {
    if (syncStatus === 'error') return 'error';
    // `hydrating` only when we actually have a download in flight.
    if ((syncStatus === 'syncing' || syncStatus === 'scoring') && hydrationTotal > 0) {
        return 'hydrating';
    }
    // Explicit noise-removal substate set by SuggestionSyncService around the
    // persistAndLinkNewSuggestions call.
    if (syncStatus === 'filtering-noise') return 'noiseRemoval';
    // Later stages win over the `sending` fallback. During the handoff out of
    // hydration, syncStatus can briefly stay 'syncing' with hydrationTotal=0
    // while asyncJobPhase already advanced — without this ordering we'd flap
    // back to 'sending' and the progress bar would reset.
    if (asyncJobPhase === 'relevance') return 'cloudRelevance';
    if (asyncJobPhase === 'reasons') return 'cloudReasons';
    if (isOnDeviceProcessing) return 'onDevice';
    if (syncStatus === 'syncing' || syncStatus === 'scoring') return 'sending';
    return 'idle';
}

const MeraProtocolProcessingStatus: React.FC<MeraProtocolProcessingStatusProps> = ({
    stage,
    processedCount,
    totalCount,
    asyncJobTotalCount = 0,
    hydrationCompleted = 0,
    hydrationTotal = 0,
    errorMessage = null,
}) => {
    const { t } = useTranslation();

    // Pull stage copy from i18n. `returnObjects` gives us the headlines array
    // and (optionally) the amber sub-line. Falls back to [] if a translator
    // forgot a key, so the UI never crashes.
    const stageCopy = useMemo(() => {
        if (stage === 'idle' || stage === 'done' || stage === 'error') return null;
        const headlines = t(`feed.processing.stages.${stage}.headlines`, {
            returnObjects: true,
            defaultValue: [],
        }) as string[];
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
        if (stage === 'cloudRelevance' && asyncJobTotalCount > 0) {
            return `${asyncJobTotalCount}`;
        }
        if (stage === 'onDevice' && totalCount > 0) {
            return `${processedCount}/${totalCount}`;
        }
        return '';
    }, [stage, hydrationCompleted, hydrationTotal, asyncJobTotalCount, processedCount, totalCount]);

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
            errorMessage ||
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
