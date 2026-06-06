import { Toast, ToastTitle, useToast } from '@/components/ui/toast';
import {
    useForYouAsyncJobPhase,
    useForYouAsyncJobProcessedCount,
    useForYouAsyncJobTotalCount,
    useForYouDeviceProcessing,
} from '@/lib/stores/selectors';
import { MaterialIcons } from '@expo/vector-icons';
import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Animated as RNAnimated, View } from 'react-native';
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated';
import { HStack } from '@/components/ui/hstack';
import { VStack } from '@/components/ui/vstack';
import { Text } from '@/components/ui/text';

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

function SyncToastContent({ nativeID }: { nativeID?: string }) {
    const { t } = useTranslation();
    const asyncJobPhase = useForYouAsyncJobPhase();
    const asyncJobProcessedCount = useForYouAsyncJobProcessedCount();
    const asyncJobTotalCount = useForYouAsyncJobTotalCount();
    const { deviceProcessedCount, deviceTotalCount } = useForYouDeviceProcessing();

    const stage =
        asyncJobPhase === 'reasons' ? 'reasons'
        : asyncJobPhase === 'relevance' ? 'relevance'
        : 'onDevice';

    const stageKey =
        stage === 'relevance' ? 'cloudRelevance'
        : stage === 'reasons' ? 'cloudReasons'
        : 'onDevice';

    const titleKey =
        stage === 'relevance' ? 'feed.processing.syncToast.relevanceTitle'
        : stage === 'reasons' ? 'feed.processing.syncToast.reasonsTitle'
        : 'feed.processing.syncToast.onDeviceTitle';

    const tAny = t as any; // new i18n keys not yet in generated types
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
    // reset when stage changes
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
        <Toast
            nativeID={nativeID}
            action="muted"
            variant="solid"
            style={{ width: '100%', margin: 0, borderRadius: 0, backgroundColor: '#2d2d2d', borderWidth: 0 }}
        >
            <VStack space="xs">
                <HStack className="items-center justify-between">
                    <ToastTitle size="sm" className="font-semibold text-white">
                        {title}
                    </ToastTitle>
                    {totalCount > 0 && (
                        <Text size="xs" className="text-typography-200">
                            {processedCount} / {totalCount}
                        </Text>
                    )}
                </HStack>

                {/* Progress bar */}
                <View
                    style={{ height: 3, backgroundColor: '#1f2937', borderRadius: 2, overflow: 'hidden' }}
                >
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

                {/* Cycling text */}
                <Animated.View
                    key={`${stage}-${headlineIndex}`}
                    entering={FadeIn.duration(300)}
                    exiting={FadeOut.duration(300)}
                >
                    <Text size="xs" className="text-white leading-4">
                        {headline}
                    </Text>
                </Animated.View>
            </VStack>
        </Toast>
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
                    {(t as any)('feed.processing.syncToast.completedTitle') as string}
                </ToastTitle>
                <Text size="xs" className="text-green-200">
                    {(t as any)('feed.processing.syncToast.completedMessage') as string}
                </Text>
            </HStack>
        </Toast>
    );
}

/** Root-level component that owns the persistent stage-2/3 toast lifecycle.
 *  Shows when scoring or reason-generation is in flight; self-closes and
 *  flashes a completion toast when the phase returns to idle. */
export default function SyncProgressToast() {
    const toast = useToast();
    const asyncJobPhase = useForYouAsyncJobPhase();
    const { isDeviceProcessing } = useForYouDeviceProcessing();

    const isActive = asyncJobPhase !== 'idle' || isDeviceProcessing;
    const wasActiveRef = useRef(false);
    const toastIdRef = useRef<string | null>(null);

    useEffect(() => {
        if (isActive) {
            wasActiveRef.current = true;
            if (!toastIdRef.current || !toast.isActive(toastIdRef.current)) {
                toastIdRef.current = toast.show({
                    placement: 'top',
                    duration: null,
                    render: ({ id }: { id: string }): React.ReactNode => <SyncToastContent nativeID={id} />,
                });
            }
            return;
        }

        if (!wasActiveRef.current) return;

        // Transitioned from active → idle: close the sync toast and show completion.
        wasActiveRef.current = false;
        if (toastIdRef.current && toast.isActive(toastIdRef.current)) {
            toast.close(toastIdRef.current);
        }
        toastIdRef.current = null;
        toast.show({
            placement: 'top',
            duration: 2500,
            render: ({ id }: { id: string }): React.ReactNode => <CompletionToast nativeID={id} />,
        });
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isActive]);

    return null;
}
