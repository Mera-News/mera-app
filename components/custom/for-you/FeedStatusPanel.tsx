// The status body, and the Feed header panel FeedStatusIndicator opens — everything the old status bar
// used to say, moved from "always on screen" to "there when you ask".
//
// Three things live here now that used to render ambiently in the header
// whenever the pipeline was busy: the counts/last-run detail (which was behind a
// chevron), the honest "Analysing X of Y" line, and the cycling stage headline.
// None of them are deleted — the reader who wants to know what the pipeline is
// doing gets more than before, in one place, phrased in words. They just no
// longer narrate at someone who is trying to read the news.
//
// A side benefit of the move: HEADLINE_CYCLE_MS's setInterval now only runs
// while the panel is actually open, instead of for the whole duration of every
// sync on both tabs.

import { GLASS_OVER_CONTENT_FILL, GlassPanel } from '@/components/custom/GlassSurface';
import { Text } from '@/components/ui/text';
import { type FeedStatusMode } from '@/lib/feed-status-mode';
import {
    useForYouAsyncJobProcessedCount,
    useForYouAsyncJobTotalCount,
    useForYouBatchProgress,
    useForYouDeviceProcessing,
} from '@/lib/stores/selectors';
import React, { useEffect, useState } from 'react';
import { View } from 'react-native';
import { useTranslation } from 'react-i18next';
import Animated, { FadeIn, FadeOut, LinearTransition } from 'react-native-reanimated';
import ChunkStrip from '@/components/custom/processing/ChunkStrip';
import { ON_DEVICE_HEADLINES_KEY, stageDef } from '@/components/custom/processing/processing-stages';
import { PROCESSING_STRIP_HEIGHT } from '@/components/custom/processing/types';
import { useProcessingSnapshot } from '@/components/custom/processing/use-processing-snapshot';
import FeedStatusDetails from './FeedStatusDetails';
import { pickScoringProgress, STATUS_INK, STATUS_PANEL_OPAQUE_BASE } from './status-ink';

/** The stage headline rotates through its text pool at this cadence. */
const HEADLINE_CYCLE_MS = 5000;

/**
 * The cycling status line for the current phase — same rotation pattern the old
 * SyncProgressForYouBanner used (index + setInterval, faded in/out per index).
 */
function ProcessingHeadline() {
    const { t } = useTranslation();
    const tAny = t as any;
    const snapshot = useProcessingSnapshot();
    const { isDeviceProcessing } = useForYouDeviceProcessing();

    // The stage comes from the same resolver the processing card uses AND the
    // same shared high-water mark, which is what actually makes the panel and
    // the card agree. The resolver alone is not enough: the mark used to be a
    // per-mount ref, so a panel opened mid-run started from null and could name
    // a LOWER step than the card was showing at that instant.
    //
    // It also makes `stages.fetching.headlines` reachable for the first time.
    // Those two lines and their amberSubline have been translated in all twenty
    // dictionaries and shown to NOBODY: the old selection here was a three-way
    // ternary over the async phase that could only ever return cloudReasons,
    // cloudRelevance or onDevice, and the other live reader of the key was a
    // component with no importers.
    const stage = snapshot.stage;
    const headlinesKey =
        stage === null
            ? null
            : stage === 'analysing' && isDeviceProcessing
              ? ON_DEVICE_HEADLINES_KEY
              : stageDef(stage).headlinesKey;

    const rawGenericLines = headlinesKey
        ? tAny(headlinesKey, { returnObjects: true, defaultValue: [] })
        : [];
    const pool = Array.isArray(rawGenericLines) ? (rawGenericLines as string[]) : [];

    const [index, setIndex] = useState(0);
    useEffect(() => {
        setIndex(0);
        if (pool.length <= 1) return;
        const interval = setInterval(
            () => setIndex((i) => (i + 1) % pool.length),
            HEADLINE_CYCLE_MS,
        );
        return () => clearInterval(interval);
    }, [pool.length, headlinesKey]);

    const line = pool[index] ?? pool[0] ?? '';
    if (!line) return null;

    return (
        <Animated.View key={index} entering={FadeIn.duration(300)} exiting={FadeOut.duration(300)}>
            <Text size="xs" className="mt-1" style={{ color: STATUS_INK.secondary }}>
                {line}
            </Text>
        </Animated.View>
    );
}

/**
 * Per-batch state, the same strip the processing card draws.
 *
 * Gated on the snapshot's own `animationsActive && !isStatic` rather than left
 * running: this sits inside a `GlassPanel`, which off the fallback path is a
 * real `UIVisualEffectView`, and a blur re-samples its backdrop every frame
 * that backdrop changes. The panel already only mounts while a reader has it
 * open, and this keeps the pulse off even then when the screen is blurred or
 * the app is backgrounded.
 *
 * Renders nothing, and reserves nothing, when there is no run: this row is
 * inside collapsing chrome OUTSIDE the list, so nothing here is subject to the
 * fixed-height rule the card lives under.
 */
function ChunkStripRow() {
    const snapshot = useProcessingSnapshot();
    if (snapshot.chunksTotal <= 0) return null;
    return (
        <View style={{ height: PROCESSING_STRIP_HEIGHT }}>
            <ChunkStrip
                chunks={snapshot.chunks}
                ready={snapshot.chunksReady}
                total={snapshot.chunksTotal}
                active={snapshot.animationsActive && !snapshot.isStatic}
            />
        </View>
    );
}

/** Honest per-run progress line while processing — "Analysing X of Y articles",
 *  read from the live batch progress. Renders nothing until a total is known. */
function AnalysingProgress() {
    const { t } = useTranslation();
    const batchProgress = useForYouBatchProgress();
    const asyncDone = useForYouAsyncJobProcessedCount();
    const asyncTotal = useForYouAsyncJobTotalCount();
    // The same figure FeedStatusDetails' scoring row shows, from the same
    // helper, so the two lines can never name two different totals.
    const progress = pickScoringProgress(batchProgress, asyncDone, asyncTotal);
    if (!batchProgress || batchProgress.total <= 0 || !progress) return null;
    return (
        <Text size="xs" className="mt-1" style={{ color: STATUS_INK.secondary }}>
            {t('feed.analysingProgress', {
                done: progress.done,
                total: progress.total,
            })}
        </Text>
    );
}

/**
 * How long an opened status panel stays open before it closes itself. ONE
 * value for both tabs: the Feed's header panel and the Dashboard's Overview
 * stats card open the same body and close it the same way (owner: "make them
 * similar"). A second tap on the trigger still closes it early.
 */
export const STATUS_PANEL_AUTO_COLLAPSE_MS = 3000;

export interface FeedStatusBodyProps {
    readonly mode: FeedStatusMode;
    /** Passed straight through to FeedStatusDetails — see its own doc. */
    readonly onBeforeNavigate?: () => void;
}

/**
 * The status panel's CONTENT, with no chrome: the detail rows plus the
 * processing-only lines. The single renderer of "what is the pipeline doing"
 * on both tabs, so every field (Last processed included, which the details
 * read themselves) is identical wherever it opens.
 */
export const FeedStatusBody: React.FC<FeedStatusBodyProps> = ({ mode, onBeforeNavigate }) => (
    <>
        <FeedStatusDetails onBeforeNavigate={onBeforeNavigate} />
        {mode === 'processing' && <AnalysingProgress />}
        {mode === 'processing' && <ProcessingHeadline />}
        {mode === 'processing' && <ChunkStripRow />}
    </>
);

export interface FeedStatusPanelProps {
    readonly expanded: boolean;
    readonly mode: FeedStatusMode;
    /** Passed straight through to FeedStatusDetails — see its own doc. */
    readonly onBeforeNavigate?: () => void;
    /**
     * An opaque base instead of the 0.90 one. For the Dashboard's dropdown,
     * which floats over list content with nothing else behind it: section
     * text read straight through the 0.90 base there. The Feed's panel sits
     * on the header's own scrim and glass plate, so it keeps the 0.90.
     */
    readonly opaque?: boolean;
}

/**
 * The Feed header's panel: `FeedStatusBody` on the dark over-content base,
 * because the header is absolute and cards scroll under it. The counts are
 * read by FeedStatusDetails itself, from the shared minute-clock
 * `useFeedCounts`, so this panel and the Dashboard's stats card show the same
 * numbers.
 */
export const FeedStatusPanel: React.FC<FeedStatusPanelProps> = ({
    expanded,
    mode,
    onBeforeNavigate,
    opaque = false,
}) => {
    if (!expanded) return null;

    return (
        <Animated.View
            layout={LinearTransition}
            entering={FadeIn.duration(160)}
            exiting={FadeOut.duration(120)}
            style={{ marginTop: 8 }}
        >
            {/* A surface over CONTENT: the header is absolute and cards scroll
                under it, so the panel takes GLASS_OVER_CONTENT_FILL as its base
                and the translucent lift sits on top. Passed as a STYLE because
                GlassPanel ignores `fallbackClassName`; the old
                `bg-gray-950` never applied, which left a 7% white tint with
                page text reading straight through it. */}
            <GlassPanel
                radius={8}
                contentClassName="px-3 py-2"
                style={{ backgroundColor: opaque ? STATUS_PANEL_OPAQUE_BASE : GLASS_OVER_CONTENT_FILL }}
                testID="dashboard-status-details-panel"
            >
                <FeedStatusBody mode={mode} onBeforeNavigate={onBeforeNavigate} />
            </GlassPanel>
        </Animated.View>
    );
};

export default FeedStatusPanel;
