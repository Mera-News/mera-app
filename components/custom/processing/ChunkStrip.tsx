import React, { useEffect } from 'react';
import { View } from 'react-native';
import Animated, {
    Easing,
    cancelAnimation,
    useAnimatedStyle,
    useSharedValue,
    withRepeat,
    withTiming,
} from 'react-native-reanimated';
import { useTranslation } from 'react-i18next';

import {
    PROCESSING_MAX_CHUNK_SEGMENTS,
    PROCESSING_STRIP_HEIGHT,
    type ChunkState,
} from './types';

const ACCENT = 'rgb(231, 138, 83)';
const SEGMENT_HEIGHT = 6;

/**
 * Per-batch state, one segment each.
 *
 * NOT `MultiStepProgressBar`. Chunk state is genuinely non-linear: a `failed`
 * chunk can sit behind `ready` ones, which that component's `resolveValue`
 * (everything before the current stage is 100) cannot express. It borrows the
 * same visual language deliberately and shares no code with it.
 *
 * Two constraints, both from the strip living inside a fixed-height card in an
 * MVCP list:
 *
 *  - `PROCESSING_STRIP_HEIGHT` is RESERVED whether or not there are chunks yet,
 *    so the card does not change height when the first batch appears.
 *  - Chunk COUNT grows mid-run, because the scoring gate re-elects held-back
 *    duplicate siblings into new batches. The strip absorbs that by letting its
 *    segments get narrower. It must never get taller, and it must never wrap.
 *
 * Past `PROCESSING_MAX_CHUNK_SEGMENTS` it buckets: at the card's width a
 * 40-segment strip is a grey smear, and the reader is being told roughly how
 * much is left, not counting.
 *
 * One component per state, and a dispatcher that calls no hook, for the same
 * `reactCompiler` reason as `StageFallback`.
 */

const RestSegment: React.FC<{ state: Exclude<ChunkState, 'in-flight'> }> = ({ state }) => (
    <View
        testID={`processing-chunk-${state}`}
        style={{
            flex: 1,
            height: SEGMENT_HEIGHT,
            borderRadius: SEGMENT_HEIGHT / 2,
            backgroundColor:
                state === 'ready'
                    ? ACCENT
                    : state === 'failed'
                      ? 'rgba(255, 255, 255, 0.14)'
                      : 'rgba(255, 255, 255, 0.24)',
        }}
    />
);

const InFlightSegment: React.FC<{ active: boolean }> = ({ active }) => {
    const pulse = useSharedValue(0);
    useEffect(() => {
        if (!active) {
            cancelAnimation(pulse);
            pulse.value = 0;
            return;
        }
        pulse.value = withRepeat(
            withTiming(1, { duration: 900, easing: Easing.inOut(Easing.ease) }),
            -1,
            true,
        );
        return () => cancelAnimation(pulse);
    }, [active, pulse]);
    const style = useAnimatedStyle(() => ({ opacity: 0.42 + pulse.value * 0.5 }));
    return (
        <Animated.View
            testID="processing-chunk-in-flight"
            style={[
                {
                    flex: 1,
                    height: SEGMENT_HEIGHT,
                    borderRadius: SEGMENT_HEIGHT / 2,
                    backgroundColor: ACCENT,
                },
                style,
            ]}
        />
    );
};

/**
 * Collapse more segments than fit into exactly `PROCESSING_MAX_CHUNK_SEGMENTS`
 * buckets. A bucket takes the WORST state it contains, ordered
 * failed > queued > in-flight > ready, so a problem is never hidden by the
 * finished work around it.
 */
export function bucketChunks(
    chunks: readonly ChunkState[],
    max = PROCESSING_MAX_CHUNK_SEGMENTS,
): ChunkState[] {
    if (chunks.length <= max) return [...chunks];
    const rank: Record<ChunkState, number> = {
        failed: 3,
        queued: 2,
        'in-flight': 1,
        ready: 0,
    };
    const out: ChunkState[] = [];
    for (let i = 0; i < max; i += 1) {
        const from = Math.floor((i * chunks.length) / max);
        const to = Math.floor(((i + 1) * chunks.length) / max);
        let worst: ChunkState = chunks[from];
        for (let j = from; j < to; j += 1) {
            if (rank[chunks[j]] > rank[worst]) worst = chunks[j];
        }
        out.push(worst);
    }
    return out;
}

interface ChunkStripProps {
    readonly chunks: readonly ChunkState[];
    readonly ready: number;
    readonly total: number;
    /** `useAnimationsActive() && !isStatic`, resolved by the caller. */
    readonly active: boolean;
}

const ChunkStrip: React.FC<ChunkStripProps> = ({ chunks, ready, total, active }) => {
    const { t } = useTranslation();
    const segments = bucketChunks(chunks);
    return (
        <View
            testID="processing-chunk-strip"
            accessibilityRole="progressbar"
            accessibilityLabel={t('feed.processing.chunks.a11y', { ready, total })}
            style={{
                height: PROCESSING_STRIP_HEIGHT,
                justifyContent: 'center',
                flexDirection: 'row',
                alignItems: 'center',
                gap: 3,
            }}
        >
            {segments.map((state, i) =>
                state === 'in-flight' ? (
                    <InFlightSegment key={i} active={active} />
                ) : (
                    <RestSegment key={i} state={state} />
                ),
            )}
        </View>
    );
};

export default ChunkStrip;
