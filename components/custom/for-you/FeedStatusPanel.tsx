// The status body and panel both tabs drop down (status-dropdown.tsx) — everything the old status bar
// used to say, moved from "always on screen" to "there when you ask".
//
// What lives here: the counts/last-run detail, the stage line and the honest
// "Analysing X of Y" line, all fixed text. There is no rotating headline and no
// chunk strip (owner): the panel closes itself at 3s, before a 5s rotation ever
// fired, so readers only ever saw its first line.

import { GlassPanel } from '@/components/custom/GlassSurface';
import { Text } from '@/components/ui/text';
import { type FeedStatusMode } from '@/lib/feed-status-mode';
import {
    useForYouAsyncJobProcessedCount,
    useForYouAsyncJobTotalCount,
    useForYouBatchProgress,
} from '@/lib/stores/selectors';
import React from 'react';
import { useTranslation } from 'react-i18next';
import Animated, { FadeIn, FadeOut, LinearTransition } from 'react-native-reanimated';
import FeedStatusDetails from './FeedStatusDetails';
import { pickScoringProgress, STATUS_INK, STATUS_PANEL_OPAQUE_BASE } from './status-ink';

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
 * value for both tabs: the Feed's mark and the Dashboard's Overview stats card
 * drop the same panel and close it the same way (owner: "make them similar").
 * A tap outside, the trigger included, still closes it early.
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
    </>
);

export interface FeedStatusPanelProps {
    readonly expanded: boolean;
    /** Per surface (`feed-status-details-panel`, `dashboard-stats-details-panel`):
     *  one shared id made the Feed's panel answer to the Dashboard's name. */
    readonly testID?: string;
    readonly mode: FeedStatusMode;
    /** Passed straight through to FeedStatusDetails — see its own doc. */
    readonly onBeforeNavigate?: () => void;
}

/**
 * The status panel: `FeedStatusBody` on an OPAQUE dark base. Both tabs drop it
 * over list content with nothing behind it, and section text read straight
 * through `GLASS_OVER_CONTENT_FILL`, which is 0.90 alpha (captured). The counts
 * are read by FeedStatusDetails itself, from the shared minute-clock
 * `useFeedCounts`, so it matches the Dashboard's stats sentence.
 */
export const FeedStatusPanel: React.FC<FeedStatusPanelProps> = ({
    expanded,
    mode,
    onBeforeNavigate,
    testID = 'status-details-panel',
}) => {
    if (!expanded) return null;

    return (
        <Animated.View
            layout={LinearTransition}
            entering={FadeIn.duration(160)}
            exiting={FadeOut.duration(120)}
            style={{ marginTop: 8 }}
        >
            {/* A surface over CONTENT, so an opaque dark base with the
                translucent lift on top. Passed as a STYLE because GlassPanel
                ignores `fallbackClassName`. */}
            <GlassPanel
                radius={8}
                contentClassName="px-3 py-2"
                style={{ backgroundColor: STATUS_PANEL_OPAQUE_BASE }}
                testID={testID}
            >
                <FeedStatusBody mode={mode} onBeforeNavigate={onBeforeNavigate} />
            </GlassPanel>
        </Animated.View>
    );
};

export default FeedStatusPanel;
