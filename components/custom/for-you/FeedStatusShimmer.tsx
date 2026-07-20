import { Box } from '@/components/ui/box';
import { HStack } from '@/components/ui/hstack';
import { Pressable } from '@/components/ui/pressable';
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
