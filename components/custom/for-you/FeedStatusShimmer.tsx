import { Box } from '@/components/ui/box';
import { HStack } from '@/components/ui/hstack';
import { Pressable } from '@/components/ui/pressable';
import { Text } from '@/components/ui/text';
import type { PipelineFactStage } from '@/lib/stores/for-you-store';
import { useForYouAsyncJobPhase, useForYouFactStages } from '@/lib/stores/selectors';
import { MaterialIcons } from '@expo/vector-icons';
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { LayoutChangeEvent } from 'react-native';
import Animated, {
    Easing,
    FadeIn,
    FadeOut,
    LinearTransition,
    useAnimatedStyle,
    useSharedValue,
    withRepeat,
    withTiming,
} from 'react-native-reanimated';
import FeedStatusDetails, { type FeedStatusDetailsProps } from './FeedStatusDetails';

const BAR_HEIGHT = 3;

/** Fraction of the track width the moving segment occupies. */
const SEGMENT_FRACTION = 0.4;

/** Ported from the (now-deleted) SyncProgressForYouBanner — the collapsed row's
 *  cycling status line rotates through its text pool at this cadence. */
const HEADLINE_CYCLE_MS = 5000;

/**
 * The collapsed row's cycling status line while `mode === 'processing'`. Pool =
 * the active fact-stage lines (from the per-fact pipelined run, if any) followed
 * by the generic stage headlines for the current phase — same rotation pattern
 * the old SyncProgressForYouBanner used (index + setInterval, faded in/out per
 * index), just re-homed here since that banner is no longer mounted.
 */
function ProcessingHeadline() {
    const { t } = useTranslation();
    const tAny = t as any;
    const asyncJobPhase = useForYouAsyncJobPhase();
    const factStages = useForYouFactStages();

    const otherStoriesLabel = t('feed.factStages.otherStories');

    const factLines = factStages
        .filter((stage: PipelineFactStage) => stage.phase === 'working')
        .map((stage) => {
            const fact = stage.statement ?? otherStoriesLabel;
            return asyncJobPhase === 'reasons'
                ? (tAny('feed.factStages.writing', { fact }) as string)
                : (tAny('feed.factStages.reading', { fact }) as string);
        });

    const stageKey =
        asyncJobPhase === 'reasons' ? 'cloudReasons'
            : asyncJobPhase === 'relevance' ? 'cloudRelevance'
                : 'onDevice';
    const rawGenericLines = tAny(`feed.processing.stages.${stageKey}.headlines`, {
        returnObjects: true,
        defaultValue: [],
    });
    const genericLines = Array.isArray(rawGenericLines) ? (rawGenericLines as string[]) : [];

    const pool = [...factLines, ...genericLines];

    const [index, setIndex] = useState(0);
    useEffect(() => {
        setIndex(0);
        if (pool.length <= 1) return;
        const interval = setInterval(
            () => setIndex((i) => (i + 1) % pool.length),
            HEADLINE_CYCLE_MS,
        );
        return () => clearInterval(interval);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [pool.length, stageKey]);

    const line = pool[index] ?? pool[0] ?? '';
    if (!line) return null;

    return (
        <Animated.View key={index} entering={FadeIn.duration(300)} exiting={FadeOut.duration(300)}>
            <Text size="xs" className="text-typography-400 leading-4 mt-1">
                {line}
            </Text>
        </Animated.View>
    );
}

type ShimmerMode = 'processing' | 'error' | 'limited' | 'idle';

interface FeedStatusShimmerProps extends FeedStatusDetailsProps {
    /** Feed work in flight — animated indeterminate bar. Highest priority. */
    readonly processing: boolean;
    /** Scoring pipeline failed — static red-ish tint (only when not processing). */
    readonly error: boolean;
    /** Over the daily delivery cap — static amber tint (only when not processing). */
    readonly dailyLimited: boolean;
}

function IndeterminateSegment() {
    const [trackWidth, setTrackWidth] = useState(0);
    const progress = useSharedValue(0);

    useEffect(() => {
        progress.value = withRepeat(
            withTiming(1, { duration: 1200, easing: Easing.inOut(Easing.ease) }),
            -1,
            false,
        );
    }, [progress]);

    const segmentWidth = Math.max(trackWidth * SEGMENT_FRACTION, 1);

    const animatedStyle = useAnimatedStyle(() => {
        // Travel the segment from just off the left edge to just off the right.
        const from = -segmentWidth;
        const to = trackWidth;
        return { transform: [{ translateX: from + (to - from) * progress.value }] };
    });

    const onLayout = (e: LayoutChangeEvent) => setTrackWidth(e.nativeEvent.layout.width);

    return (
        <Animated.View style={{ flex: 1, overflow: 'hidden' }} onLayout={onLayout}>
            <Animated.View
                style={[
                    {
                        position: 'absolute',
                        top: 0,
                        bottom: 0,
                        width: segmentWidth,
                        backgroundColor: '#f97316',
                        opacity: 0.85,
                        borderRadius: 2,
                    },
                    animatedStyle,
                ]}
            />
        </Animated.View>
    );
}

/**
 * The feed-status row under the sub-tab pills: a ~3px full-width status bar
 * (animated indeterminate segment while processing, static red-ish tint on a
 * scoring error, static amber tint over the daily cap, nothing when idle) plus a
 * chevron expand button. Tapping the bar OR the chevron toggles an inline
 * accordion panel that reveals the same detail the FeedStatusSheet shows — the
 * data the old sync banners used to display, via the shared {@link FeedStatusDetails}
 * body. Collapsed by default; the expand state is local and resets on unmount.
 * The full sheet stays reachable from the header "updated X ago" line.
 */
const FeedStatusShimmer: React.FC<FeedStatusShimmerProps> = ({
    processing,
    error,
    dailyLimited,
    ...detailProps
}) => {
    const { t } = useTranslation();
    const [expanded, setExpanded] = useState(false);

    const rotation = useSharedValue(0);
    useEffect(() => {
        rotation.value = withTiming(expanded ? 1 : 0, { duration: 180 });
    }, [expanded, rotation]);
    const chevronStyle = useAnimatedStyle(() => ({
        transform: [{ rotate: `${rotation.value * 180}deg` }],
    }));

    const mode: ShimmerMode = processing
        ? 'processing'
        : error
            ? 'error'
            : dailyLimited
                ? 'limited'
                : 'idle';

    if (mode === 'idle') return null;

    const trackColor =
        mode === 'processing'
            ? '#1f2937'
            : mode === 'error'
                ? 'rgba(248,113,113,0.45)'
                : 'rgba(251,191,36,0.45)';

    const toggle = () => setExpanded((v) => !v);

    return (
        <Animated.View layout={LinearTransition} style={{ marginTop: 8 }}>
            <HStack className="items-center" space="sm">
                <Pressable
                    onPress={toggle}
                    accessibilityRole="button"
                    accessibilityLabel={t('feedStatus.openA11y')}
                    style={{
                        flex: 1,
                        height: BAR_HEIGHT,
                        overflow: 'hidden',
                        borderRadius: 2,
                        backgroundColor: trackColor,
                    }}
                >
                    {mode === 'processing' && <IndeterminateSegment />}
                </Pressable>
                <Pressable
                    onPress={toggle}
                    hitSlop={10}
                    accessibilityRole="button"
                    accessibilityState={{ expanded }}
                    accessibilityLabel={t(
                        expanded ? 'feedStatus.collapseA11y' : 'feedStatus.expandA11y',
                    )}
                    style={{ padding: 2 }}
                >
                    <Animated.View style={chevronStyle}>
                        <MaterialIcons name="expand-more" size={18} color="#9ca3af" />
                    </Animated.View>
                </Pressable>
            </HStack>

            {mode === 'processing' && <ProcessingHeadline />}

            {expanded && (
                <Animated.View entering={FadeIn.duration(160)} exiting={FadeOut.duration(120)}>
                    <Box className="mt-2 rounded-lg border border-gray-800 bg-gray-950 px-3 py-2">
                        <FeedStatusDetails {...detailProps} />
                    </Box>
                </Animated.View>
            )}
        </Animated.View>
    );
};

export default FeedStatusShimmer;
