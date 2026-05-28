import { Pressable } from '@/components/ui/pressable';
import { Progress, ProgressFilledTrack } from '@/components/ui/progress';
import { Text } from '@/components/ui/text';
import { Tooltip, TooltipContent, TooltipText } from '@/components/ui/tooltip';
import React from 'react';
import { View } from 'react-native';

type ProgressSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl' | '2xl';
type Orientation = 'horizontal' | 'vertical';

export interface MultiStepProgressBarProps {
    totalStages: number;
    currentStage: number;
    stageValue: number;
    progressClassName?: string;
    progressFilledClassName?: string;
    stageNames?: string[];
    stageTooltips?: (string | undefined)[];
    size?: ProgressSize;
    orientation?: Orientation;
    gap?: number;
    className?: string;
    stageNameClassName?: string;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

const resolveValue = (index: number, currentStage: number, stageValue: number): number => {
    if (currentStage >= 0 && index < currentStage) return 100;
    if (index === currentStage) return clamp(stageValue, 0, 100);
    if (currentStage < 0) return 0;
    return 0;
};

const MultiStepProgressBar: React.FC<MultiStepProgressBarProps> = ({
    totalStages,
    currentStage,
    stageValue,
    progressClassName,
    progressFilledClassName,
    stageNames,
    stageTooltips,
    size = 'xs',
    orientation = 'horizontal',
    gap = 3,
    className,
    stageNameClassName,
}) => {
    if (__DEV__) {
        if (stageNames && stageNames.length !== totalStages) {
            console.warn(
                `[MultiStepProgressBar] stageNames length (${stageNames.length}) must equal totalStages (${totalStages})`,
            );
        }
        if (stageTooltips && stageTooltips.length !== totalStages) {
            console.warn(
                `[MultiStepProgressBar] stageTooltips length (${stageTooltips.length}) must equal totalStages (${totalStages})`,
            );
        }
    }

    const indices = Array.from({ length: totalStages }, (_, i) => i);

    return (
        <View className={className}>
            <View
                style={{ flexDirection: 'row', gap }}
                testID="multi-step-progress-bars"
            >
                {indices.map((i) => {
                    const value = resolveValue(i, currentStage, stageValue);
                    const tooltipText = stageTooltips?.[i];
                    const bar = (
                        <Progress
                            testID={`multi-step-progress-segment-${i}`}
                            value={value}
                            size={size}
                            orientation={orientation}
                            className={progressClassName}
                        >
                            <ProgressFilledTrack
                                testID={`multi-step-progress-fill-${i}`}
                                className={progressFilledClassName}
                            />
                        </Progress>
                    );
                    if (tooltipText) {
                        return (
                            <View key={i} style={{ flex: 1 }}>
                                <Tooltip
                                    placement="top"
                                    trigger={(triggerProps) => (
                                        <Pressable
                                            {...triggerProps}
                                            testID={`multi-step-progress-tooltip-trigger-${i}`}
                                            hitSlop={6}
                                        >
                                            {bar}
                                        </Pressable>
                                    )}
                                >
                                    <TooltipContent>
                                        <TooltipText>{tooltipText}</TooltipText>
                                    </TooltipContent>
                                </Tooltip>
                            </View>
                        );
                    }
                    return (
                        <View key={i} style={{ flex: 1 }}>
                            {bar}
                        </View>
                    );
                })}
            </View>
            {stageNames && (
                <View
                    style={{ flexDirection: 'row', gap, paddingTop: 4 }}
                    testID="multi-step-progress-labels"
                >
                    {stageNames.map((name, i) => (
                        <Text
                            key={i}
                            size="xs"
                            className={stageNameClassName}
                            style={{ flex: 1, textAlign: 'center' }}
                        >
                            {name}
                        </Text>
                    ))}
                </View>
            )}
        </View>
    );
};

export default MultiStepProgressBar;
