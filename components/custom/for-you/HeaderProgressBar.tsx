import { ProcessingStage } from '@/components/custom/MeraProtocolProcessingStatus';
import MultiStepProgressBar from '@/components/custom/MultiStepProgressBar';
import { Text } from '@/components/ui/text';
import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated';

interface HeaderProgressBarProps {
    stage: ProcessingStage;
    hydrationCompleted: number;
    hydrationTotal: number;
    deviceProcessedCount: number;
    deviceTotalCount: number;
    meraProtocolEnabled: boolean;
    injectNoiseEnabled?: boolean;
}

const STAGE_ORDER_FULL: ProcessingStage[] = [
    'sending',
    'hydrating',
    'noiseRemoval',
    'cloudRelevance',
    'cloudReasons',
    'onDevice',
];

const HeaderProgressBar: React.FC<HeaderProgressBarProps> = ({
    stage,
    hydrationCompleted,
    hydrationTotal,
    deviceProcessedCount,
    deviceTotalCount,
    meraProtocolEnabled,
    injectNoiseEnabled = false,
}) => {
    const { t } = useTranslation();

    const order = useMemo(() => {
        let stages = STAGE_ORDER_FULL;
        if (!meraProtocolEnabled) {
            stages = stages.filter((s) => s !== 'onDevice');
        }
        if (!injectNoiseEnabled) {
            stages = stages.filter((s) => s !== 'noiseRemoval');
        }
        return stages;
    }, [meraProtocolEnabled, injectNoiseEnabled]);

    if (stage === 'idle') return null;

    const isError = stage === 'error';
    const currentStage =
        stage === 'done' || isError ? order.length : order.indexOf(stage);

    let stageValue = 0;
    const currentStageId = order[currentStage];
    if (currentStageId === 'hydrating' && hydrationTotal > 0) {
        stageValue = (hydrationCompleted / hydrationTotal) * 100;
    } else if (currentStageId === 'onDevice' && deviceTotalCount > 0) {
        stageValue = (deviceProcessedCount / deviceTotalCount) * 100;
    }

    const stageTooltips = order.map((s) => {
        const text = t(`feed.processing.stages.${s}.tooltip` as never, { defaultValue: '' });
        return text || undefined;
    });

    const labelKey = isError
        ? 'feed.processing.errorFlash'
        : stage === 'done'
            ? 'feed.processing.doneFlash'
            : `feed.processing.stages.${stage}.shortName`;

    return (
        <View
            pointerEvents="box-none"
            style={{
                position: 'absolute',
                left: 0,
                right: 0,
                bottom: 0,
                paddingHorizontal: 0,
            }}
        >
            <MultiStepProgressBar
                totalStages={order.length}
                currentStage={currentStage}
                stageValue={stageValue}
                stageTooltips={stageTooltips}
                progressClassName={isError ? 'bg-red-900/20 h-[2px]' : 'bg-lime-100/20 h-[2px]'}
                progressFilledClassName={isError ? 'bg-red-500 h-[2px]' : 'bg-green-800 h-[2px]'}
            />
            <Animated.View
                key={`label-${stage}`}
                entering={FadeIn.duration(250)}
                exiting={FadeOut.duration(250)}
                style={{ paddingTop: 4 }}
            >
                <Text size="xs" className="text-typography-500 leading-4">
                    {t(labelKey as never, { defaultValue: '' })}
                </Text>
            </Animated.View>
        </View>
    );
};

export default HeaderProgressBar;
