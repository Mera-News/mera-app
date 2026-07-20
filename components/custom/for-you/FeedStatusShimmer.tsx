import { Pressable } from '@/components/ui/pressable';
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { LayoutChangeEvent } from 'react-native';
import Animated, {
    Easing,
    useAnimatedStyle,
    useSharedValue,
    withRepeat,
    withTiming,
} from 'react-native-reanimated';

const BAR_HEIGHT = 3;

/** Fraction of the track width the moving segment occupies. */
const SEGMENT_FRACTION = 0.4;

type ShimmerMode = 'processing' | 'error' | 'limited' | 'idle';

interface FeedStatusShimmerProps {
    /** Feed work in flight — animated indeterminate bar. Highest priority. */
    readonly processing: boolean;
    /** Scoring pipeline failed — static red-ish tint (only when not processing). */
    readonly error: boolean;
    /** Over the daily delivery cap — static amber tint (only when not processing). */
    readonly dailyLimited: boolean;
    /** Opens the feed-status sheet. */
    readonly onPress: () => void;
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
 * A ~3px full-width status strip directly under the sub-tab pill row. It replaces
 * the old header banner block: an animated indeterminate bar while the feed is
 * processing, a static red-ish tint on a scoring error, a static amber tint when
 * over the daily cap, and zero-height (nothing) when idle. Tapping opens the
 * feed-status sheet.
 */
const FeedStatusShimmer: React.FC<FeedStatusShimmerProps> = ({
    processing,
    error,
    dailyLimited,
    onPress,
}) => {
    const { t } = useTranslation();

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

    return (
        <Pressable
            onPress={onPress}
            accessibilityRole="button"
            accessibilityLabel={t('feedStatus.openA11y')}
            style={{
                height: BAR_HEIGHT,
                width: '100%',
                overflow: 'hidden',
                borderRadius: 2,
                backgroundColor: trackColor,
            }}
        >
            {mode === 'processing' && <IndeterminateSegment />}
        </Pressable>
    );
};

export default FeedStatusShimmer;
