import React, { useEffect, useState } from 'react';
import { View } from 'react-native';
import { useTranslation } from 'react-i18next';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';

import MultiStepProgressBar from '@/components/custom/MultiStepProgressBar';
import { Text } from '@/components/ui/text';

import ChunkStrip from './ChunkStrip';
import ProcessingStageAnimation from './ProcessingStageAnimation';
import { FETCHING_SUBLINE_KEY, ON_DEVICE_HEADLINES_KEY, stageDef } from './processing-stages';
import {
    PROCESSING_HEADLINE_CYCLE_MS,
    PROCESSING_STRIP_HEIGHT,
    PROCESSING_TOTAL_STAGES,
    type ProcessingSnapshot,
} from './types';

/** Half of the headline crossfade. */
const FADE_MS = 220;
/** The headline box is exactly two lines at this leading, whatever the locale
 *  puts in it. Fixed so the card's own height cannot move. */
const HEADLINE_LINE_HEIGHT = 20;

interface ProcessingAreaProps {
    readonly snapshot: ProcessingSnapshot;
    /** True when on-device scoring is driving the analysing stage, which gets
     *  its own honest copy about nothing leaving the phone. */
    readonly onDevice?: boolean;
}

/**
 * The processing area: scene, stage label, rotating headline, six-stage bar,
 * chunk strip, progress line.
 *
 * Presentational. Every value arrives in `snapshot`, produced by
 * `use-processing-snapshot.ts` and by nothing else, so this component holds no
 * store subscription and no decision.
 *
 * ## The headline crossfade uses ONE shared opacity
 *
 * Not a keyed `Animated.View` with `entering`/`exiting`.
 * `chat/StreamingIndicator.tsx` records why from experience: Reanimated keeps
 * the exiting copy on screen, outside the layout flow, while the new one
 * mounts, which drew two captions on top of each other inside a fixed-height
 * row. Fade out, swap the text at the trough, fade back in. Exactly one
 * headline is mounted at any instant.
 *
 * ## The bar gets no stage NAMES
 *
 * `MultiStepProgressBar` can render a label under each segment, and at this
 * card's width six of them are about 70pt each. "Grouping duplicate stories" is
 * not a 70pt string in English and is worse in German, so the active stage's
 * label is its own full-width line above the bar instead and the bar stays a
 * bar. The step position is still announced, through `stageA11y`.
 */
const ProcessingArea: React.FC<ProcessingAreaProps> = ({ snapshot, onDevice = false }) => {
    const { t } = useTranslation();
    const tAny = t as unknown as (key: string, opts?: object) => string | string[];

    const stage = snapshot.stage;
    const def = stage ? stageDef(stage) : null;
    const headlinesKey =
        stage === 'analysing' && onDevice ? ON_DEVICE_HEADLINES_KEY : def?.headlinesKey;

    const raw = headlinesKey
        ? tAny(headlinesKey, { returnObjects: true })
        : undefined;
    const headlines = Array.isArray(raw) ? raw : raw ? [raw] : [];

    const [index, setIndex] = useState(0);
    const opacity = useSharedValue(1);
    const playing = snapshot.animationsActive && !snapshot.isStatic;

    // Reset on a stage change so a new pool never starts mid-rotation on an
    // index that belongs to the pool before it.
    useEffect(() => {
        setIndex(0);
    }, [headlinesKey]);

    useEffect(() => {
        if (!playing || headlines.length < 2) return;
        let swap: ReturnType<typeof setTimeout> | undefined;
        const timer = setInterval(() => {
            opacity.value = withTiming(0, { duration: FADE_MS });
            swap = setTimeout(() => {
                setIndex((i) => (i + 1) % headlines.length);
                opacity.value = withTiming(1, { duration: FADE_MS });
            }, FADE_MS);
        }, PROCESSING_HEADLINE_CYCLE_MS);
        return () => {
            clearInterval(timer);
            if (swap) clearTimeout(swap);
        };
    }, [playing, headlines.length, opacity]);

    const headlineStyle = useAnimatedStyle(() => ({ opacity: opacity.value }));

    if (!stage || !def) return null;

    // One honest line, chosen by what the CURRENT stage actually knows.
    //
    // Article counts and batch counts are never mixed:
    // `derivePipelineBatchProgress` is a set UNION over articles and
    // `derivePipelineChunkStates` counts batches, so "40 of 220 articles" and
    // "1 of 8 batches" are both true at the same instant and neither is the
    // other's percentage. Whichever the stage is really measuring wins, and
    // when it measures nothing the line is EMPTY rather than a fabricated
    // number. Written inline rather than as a helper taking `t`: i18next's
    // TFunction does not survive being passed through a narrower signature
    // without losing the key checking this file exists to keep.
    let progressLine = '';
    if (stage === 'downloading' && snapshot.hydrationTotal > 0) {
        progressLine = t('feed.processing.downloadProgress', {
            done: snapshot.hydrationCompleted,
            total: snapshot.hydrationTotal,
        });
    } else if (
        (stage === 'analysing' || stage === 'summarising') &&
        snapshot.analysedTotal > 0
    ) {
        progressLine = t('feed.analysingProgress', {
            done: snapshot.analysedDone,
            total: snapshot.analysedTotal,
        });
    } else if (snapshot.chunksTotal > 0) {
        progressLine = t('feed.processing.chunks.ready', {
            ready: snapshot.chunksReady,
            total: snapshot.chunksTotal,
        });
    } else if (stage === 'fetching') {
        progressLine = t(FETCHING_SUBLINE_KEY);
    }

    return (
        <View testID="processing-area" style={{ width: '100%', alignItems: 'center' }}>
            <ProcessingStageAnimation
                stage={stage}
                isStatic={snapshot.isStatic}
                animationsActive={snapshot.animationsActive}
            />

            <Text
                testID="processing-stage-label"
                size="md"
                numberOfLines={1}
                className="text-white text-center mt-4"
                style={{ fontSize: 16, lineHeight: 22 }}
            >
                {t(def.labelKey)}
            </Text>

            {/* Fixed two-line box. A one-line locale must not shrink the card
                and a three-line one must not grow it. */}
            <View style={{ height: HEADLINE_LINE_HEIGHT * 2, marginTop: 6, justifyContent: 'center' }}>
                <Animated.View style={headlineStyle}>
                    <Text
                        testID="processing-headline"
                        size="sm"
                        numberOfLines={2}
                        className="text-gray-400 text-center"
                        style={{ fontSize: 13, lineHeight: HEADLINE_LINE_HEIGHT }}
                    >
                        {headlines[index] ?? ''}
                    </Text>
                </Animated.View>
            </View>

            <View
                accessibilityRole="progressbar"
                accessibilityLabel={t('feed.processing.stageA11y', {
                    index: snapshot.stageIndex + 1,
                    total: PROCESSING_TOTAL_STAGES,
                    name: t(def.labelKey),
                })}
                style={{ width: '100%', marginTop: 14 }}
            >
                <MultiStepProgressBar
                    totalStages={PROCESSING_TOTAL_STAGES}
                    currentStage={snapshot.stageIndex}
                    stageValue={snapshot.stageValue}
                    progressFilledClassName="bg-primary-400"
                />
            </View>

            {/* Reserved whether or not a run exists yet, so the first batch
                appearing cannot change the card's height. */}
            <View style={{ width: '100%', height: PROCESSING_STRIP_HEIGHT }}>
                {snapshot.chunksTotal > 0 ? (
                    <ChunkStrip
                        chunks={snapshot.chunks}
                        ready={snapshot.chunksReady}
                        total={snapshot.chunksTotal}
                        active={playing}
                    />
                ) : null}
            </View>

            <Text
                testID="processing-progress-line"
                size="xs"
                numberOfLines={1}
                className="text-gray-500 text-center"
                style={{ fontSize: 12, lineHeight: 17 }}
            >
                {progressLine}
            </Text>
        </View>
    );
};

export default ProcessingArea;
