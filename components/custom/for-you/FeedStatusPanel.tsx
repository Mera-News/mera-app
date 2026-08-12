// The detail panel FeedStatusIndicator opens — everything the old status bar
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

import { GlassPanel } from '@/components/custom/GlassSurface';
import { Text } from '@/components/ui/text';
import { useFeedCounts } from '@/lib/hooks/use-feed-counts';
import { type FeedStatusMode } from '@/lib/feed-status-mode';
import {
    useForYouAsyncJobPhase,
    useForYouBatchProgress,
    useForYouDeviceProcessing,
} from '@/lib/stores/selectors';
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Animated, { FadeIn, FadeOut, LinearTransition } from 'react-native-reanimated';
import FeedStatusDetails from './FeedStatusDetails';

/** The stage headline rotates through its text pool at this cadence. */
const HEADLINE_CYCLE_MS = 5000;

/**
 * The cycling status line for the current phase — same rotation pattern the old
 * SyncProgressForYouBanner used (index + setInterval, faded in/out per index).
 */
function ProcessingHeadline() {
    const { t } = useTranslation();
    const tAny = t as any;
    const asyncJobPhase = useForYouAsyncJobPhase();
    const { isDeviceProcessing } = useForYouDeviceProcessing();

    const stageKey =
        asyncJobPhase === 'reasons' ? 'cloudReasons'
            : asyncJobPhase === 'relevance' ? 'cloudRelevance'
                : isDeviceProcessing ? 'onDevice'
                    : 'cloudRelevance';
    const rawGenericLines = tAny(`feed.processing.stages.${stageKey}.headlines`, {
        returnObjects: true,
        defaultValue: [],
    });
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
    }, [pool.length, stageKey]);

    const line = pool[index] ?? pool[0] ?? '';
    if (!line) return null;

    return (
        <Animated.View key={index} entering={FadeIn.duration(300)} exiting={FadeOut.duration(300)}>
            <Text size="xs" className="text-typography-400 mt-1">
                {line}
            </Text>
        </Animated.View>
    );
}

/** Honest per-run progress line while processing — "Analysing X of Y articles",
 *  read from the live batch progress. Renders nothing until a total is known. */
function AnalysingProgress() {
    const { t } = useTranslation();
    const batchProgress = useForYouBatchProgress();
    if (!batchProgress || batchProgress.total <= 0) return null;
    return (
        <Text size="xs" className="text-typography-500 mt-1">
            {t('feed.analysingProgress', {
                done: batchProgress.done,
                total: batchProgress.total,
            })}
        </Text>
    );
}

export interface FeedStatusPanelProps {
    readonly expanded: boolean;
    readonly mode: FeedStatusMode;
    /** Human relative label for the last finished run ("4 minutes ago"). The
     *  Dashboard already computes this for its header line against a 30s tick;
     *  the Feed tab omits it. */
    readonly lastProcessedLabel?: string | null;
    /** Passed straight through to FeedStatusDetails — see its own doc. */
    readonly onBeforeNavigate?: () => void;
}

/**
 * Self-subscribes to the counts so mounting it is a one-liner on either screen
 * and the two can't drift. `expanded` and `mode` come from the screen, which is
 * what keeps this and the indicator describing the same state.
 */
export const FeedStatusPanel: React.FC<FeedStatusPanelProps> = ({
    expanded,
    mode,
    lastProcessedLabel = null,
    onBeforeNavigate,
}) => {
    const { articleCount, analysedCount, relevantCount } = useFeedCounts();

    if (!expanded) return null;

    return (
        <Animated.View
            layout={LinearTransition}
            entering={FadeIn.duration(160)}
            exiting={FadeOut.duration(120)}
            style={{ marginTop: 8 }}
        >
            {/* Glass rather than a flat `bg-gray-950` slab, which read as a black
                block over the page's gradient backdrop. Padding moves to
                `contentClassName` because GlassPanel's outer box must stay
                unpadded for the plate to fill it; off iOS 26 the original border
                + fill are kept verbatim via `fallbackClassName`. */}
            <GlassPanel
                radius={8}
                contentClassName="px-3 py-2"
                fallbackClassName="border border-gray-800 bg-gray-950"
                testID="dashboard-status-details-panel"
            >
                <FeedStatusDetails
                    processedCount={articleCount}
                    analysedCount={analysedCount}
                    relevantCount={relevantCount}
                    lastProcessedLabel={lastProcessedLabel}
                    onBeforeNavigate={onBeforeNavigate}
                />
                {mode === 'processing' && <AnalysingProgress />}
                {mode === 'processing' && <ProcessingHeadline />}
            </GlassPanel>
        </Animated.View>
    );
};

export default FeedStatusPanel;
