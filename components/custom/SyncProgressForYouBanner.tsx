import { Toast, ToastTitle, useToast } from '@/components/ui/toast';
import { HStack } from '@/components/ui/hstack';
import { VStack } from '@/components/ui/vstack';
import { Text } from '@/components/ui/text';
import {
    useForYouAsyncJobPhase,
    useForYouAsyncJobProcessedCount,
    useForYouAsyncJobTotalCount,
    useForYouDeviceProcessing,
    useForYouSyncStatusMessage,
} from '@/lib/stores/selectors';
import { MaterialIcons } from '@expo/vector-icons';
import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Animated as RNAnimated, View } from 'react-native';
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated';

const HEADLINE_CYCLE_MS = 5000;

function IndeterminateBar() {
    const translateX = useRef(new RNAnimated.Value(-1)).current;
    useEffect(() => {
        const anim = RNAnimated.loop(
            RNAnimated.sequence([
                RNAnimated.timing(translateX, { toValue: 1, duration: 1200, useNativeDriver: true }),
                RNAnimated.timing(translateX, { toValue: -1, duration: 0, useNativeDriver: true }),
            ]),
        );
        anim.start();
        return () => anim.stop();
    }, [translateX]);

    return (
        <View style={{ flex: 1, overflow: 'hidden' }}>
            <RNAnimated.View
                style={{
                    position: 'absolute',
                    left: 0,
                    right: 0,
                    top: 0,
                    bottom: 0,
                    backgroundColor: '#f97316',
                    opacity: 0.7,
                    transform: [
                        {
                            translateX: translateX.interpolate({
                                inputRange: [-1, 1],
                                outputRange: ['-100%', '100%'],
                            }) as any,
                        },
                    ],
                }}
            />
        </View>
    );
}

function CompletionToast({ nativeID }: { nativeID?: string }) {
    const { t } = useTranslation();
    return (
        <Toast
            nativeID={nativeID}
            action="success"
            variant="solid"
            style={{ width: '100%', marginHorizontal: 0, borderRadius: 0 }}
        >
            <HStack className="items-center" space="sm">
                <MaterialIcons name="check-circle" size={16} color="#fff" />
                <ToastTitle size="sm" className="font-semibold text-white">
                    {(t as any)('feed.syncToast.completedTitle') as string}
                </ToastTitle>
                <Text size="xs" className="text-green-200">
                    {(t as any)('feed.syncToast.completedMessage') as string}
                </Text>
            </HStack>
        </Toast>
    );
}

export default function SyncProgressForYouBanner() {
    const toast = useToast();
    const asyncJobPhase = useForYouAsyncJobPhase();
    const asyncJobProcessedCount = useForYouAsyncJobProcessedCount();
    const asyncJobTotalCount = useForYouAsyncJobTotalCount();
    const { isDeviceProcessing, deviceProcessedCount, deviceTotalCount } = useForYouDeviceProcessing();
    const syncStatusMessage = useForYouSyncStatusMessage();

    const isStage1Active =
        syncStatusMessage?.state === 'hydrating' ||
        syncStatusMessage?.state === 'persisting';

    const isStage23Active = asyncJobPhase !== 'idle' || isDeviceProcessing;

    // Completion toast: fires when stages 2-3 finish.
    const wasStage23ActiveRef = useRef(false);
    useEffect(() => {
        if (isStage23Active) {
            wasStage23ActiveRef.current = true;
            return;
        }
        if (!wasStage23ActiveRef.current) return;
        wasStage23ActiveRef.current = false;
        toast.show({
            placement: 'top',
            duration: 2500,
            render: ({ id }: { id: string }): React.ReactNode => <CompletionToast nativeID={id} />,
        });
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isStage23Active]);

    if (isStage23Active) {
        return <Stage23Content
            asyncJobPhase={asyncJobPhase}
            asyncJobProcessedCount={asyncJobProcessedCount}
            asyncJobTotalCount={asyncJobTotalCount}
            isDeviceProcessing={isDeviceProcessing}
            deviceProcessedCount={deviceProcessedCount}
            deviceTotalCount={deviceTotalCount}
        />;
    }

    if (isStage1Active) {
        return <Stage1Content />;
    }

    return null;
}

// ---------- Stage 2-3: cloud relevance / reasons / on-device ----------

interface Stage23ContentProps {
    asyncJobPhase: string;
    asyncJobProcessedCount: number;
    asyncJobTotalCount: number;
    isDeviceProcessing: boolean;
    deviceProcessedCount: number;
    deviceTotalCount: number;
}

function Stage23Content({
    asyncJobPhase,
    asyncJobProcessedCount,
    asyncJobTotalCount,
    isDeviceProcessing,
    deviceProcessedCount,
    deviceTotalCount,
}: Stage23ContentProps) {
    const { t } = useTranslation();

    const stage =
        asyncJobPhase === 'reasons' ? 'reasons'
        : asyncJobPhase === 'relevance' ? 'relevance'
        : 'onDevice';

    const stageKey =
        stage === 'relevance' ? 'cloudRelevance'
        : stage === 'reasons' ? 'cloudReasons'
        : 'onDevice';

    const titleKey =
        stage === 'relevance' ? 'feed.syncToast.relevanceTitle'
        : stage === 'reasons' ? 'feed.syncToast.reasonsTitle'
        : 'feed.syncToast.onDeviceTitle';

    const tAny = t as any;
    const title = tAny(titleKey) as string;
    const headlines = tAny(`feed.processing.stages.${stageKey}.headlines`, {
        returnObjects: true,
        defaultValue: [],
    }) as string[];

    const [headlineIndex, setHeadlineIndex] = useState(0);
    useEffect(() => {
        setHeadlineIndex(0);
        if (headlines.length <= 1) return;
        const interval = setInterval(
            () => setHeadlineIndex((i) => (i + 1) % headlines.length),
            HEADLINE_CYCLE_MS,
        );
        return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [stage]);

    const processedCount = asyncJobPhase !== 'idle' ? asyncJobProcessedCount : deviceProcessedCount;
    const totalCount = asyncJobPhase !== 'idle' ? asyncJobTotalCount : deviceTotalCount;
    const progressRatio = totalCount > 0 ? Math.min(processedCount / totalCount, 1) : 0;

    const progressAnim = useRef(new RNAnimated.Value(0)).current;
    useEffect(() => {
        RNAnimated.timing(progressAnim, {
            toValue: progressRatio,
            duration: 400,
            useNativeDriver: false,
        }).start();
    }, [progressRatio, progressAnim]);

    const headline = headlines[headlineIndex] ?? headlines[0] ?? '';

    return (
        <VStack space="xs">
            <HStack className="items-center justify-between">
                <Text size="sm" className="font-semibold text-white">
                    {title}
                </Text>
                {totalCount > 0 && (
                    <Text size="xs" className="text-typography-400">
                        {processedCount} / {totalCount}
                    </Text>
                )}
            </HStack>

            <View style={{ height: 3, backgroundColor: '#1f2937', borderRadius: 2, overflow: 'hidden' }}>
                {totalCount > 0 ? (
                    <RNAnimated.View
                        style={{
                            height: '100%',
                            backgroundColor: '#f97316',
                            borderRadius: 2,
                            width: progressAnim.interpolate({
                                inputRange: [0, 1],
                                outputRange: ['0%', '100%'],
                            }),
                        }}
                    />
                ) : (
                    <IndeterminateBar />
                )}
            </View>

            <Animated.View
                key={`${stage}-${headlineIndex}`}
                entering={FadeIn.duration(300)}
                exiting={FadeOut.duration(300)}
            >
                <Text size="xs" className="text-typography-400 leading-4">
                    {headline}
                </Text>
            </Animated.View>
        </VStack>
    );
}

// ---------- Stage 1: hydrating / persisting ----------

function Stage1Content() {
    const { t } = useTranslation();
    const tAny = t as any;
    const headlines = tAny('feed.processing.stages.fetching.headlines', {
        returnObjects: true,
        defaultValue: [],
    }) as string[];

    const [headlineIndex, setHeadlineIndex] = useState(0);
    useEffect(() => {
        if (headlines.length <= 1) return;
        const interval = setInterval(
            () => setHeadlineIndex((i) => (i + 1) % headlines.length),
            HEADLINE_CYCLE_MS,
        );
        return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const headline = headlines[headlineIndex] ?? headlines[0] ?? '';

    return (
        <VStack space="xs">
            <View style={{ height: 3, backgroundColor: '#1f2937', borderRadius: 2, overflow: 'hidden' }}>
                <IndeterminateBar />
            </View>
            {headline ? (
                <Animated.View
                    key={headlineIndex}
                    entering={FadeIn.duration(300)}
                    exiting={FadeOut.duration(300)}
                >
                    <Text size="xs" className="text-typography-400 leading-4">
                        {headline}
                    </Text>
                </Animated.View>
            ) : null}
        </VStack>
    );
}
