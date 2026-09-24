import HeaderNarrationLine from '@/components/custom/for-you/HeaderNarrationLine';
import { HStack } from '@/components/ui/hstack';
import type { FeedStatusMode } from '@/lib/feed-status-mode';
import type { ProcessingStageId } from '@/lib/services/processing-stage';
import React from 'react';
import { View } from 'react-native';

/**
 * The mode the Feed's Mera mark draws (owner: always there, small and still at
 * rest, bigger and drawing only while Mera is working).
 *
 * 'processing' only while the PHONE is working (`useIsFeedWorkingLocally`:
 * the sync machine is active or on-device scoring runs). `statusMode` alone is
 * `schedulerRunning || isFeedProcessing`: true on every five-minute poll that
 * finds nothing, and during a cloud batch that only waits on the server (owner:
 * "still during wait"; the narration keeps showing then). Every other state
 * passes through, so error (red) and limited (amber) show on a still mark.
 */
export function feedMarkMode(workingLocally: boolean, mode: FeedStatusMode): FeedStatusMode {
    return mode === 'processing' && !workingLocally ? 'idle' : mode;
}

export interface FeedHeaderTitleRowProps {
    /** Pinned row height (`headerTitleLineHeight`), the same in every state. */
    height: number;
    title: React.ReactNode;
    /** The "?" explainer, right after the title. */
    explainer: React.ReactNode;
    /** The Mera status mark at the row's right end, in every state. */
    mark: React.ReactNode;
    /** A sync is really running (`useIsFeedProcessing`). */
    narrating: boolean;
    stage: ProcessingStageId | null;
    onDevice: boolean;
    /** The row itself, measured as the status dropdown's anchor. */
    rowRef?: React.Ref<View>;
}

/**
 * The Feed's title row: `|Feed (?)      Reading your stories  ◈|`.
 *
 * Owner layout: the "?" sits next to the title and the Mera mark takes the
 * right-most spot. The "what Mera is doing" narration lives ONLY here, inline,
 * one line, CENTRED in the space between the "?" and the mark (owner). The row holds the same four things it
 * always did, so the narration keeps its measured ~170pt budget
 * (`NARRATION_INLINE_WIDTH_PT`); a longer line is trimmed with "…". The row's
 * height is pinned in every state, and the mark grows by a transform, so a sync
 * starting or ending never moves the header, the list padding or the refresh
 * spinner.
 *
 * Pull-to-refresh passthrough: the row only CONTAINS controls (`box-none`),
 * and the narration slot is `none`, so a pan starting on it reaches the list.
 */
const FeedHeaderTitleRow: React.FC<FeedHeaderTitleRowProps> = ({
    height,
    title,
    explainer,
    mark,
    narrating,
    stage,
    onDevice,
    rowRef,
}) => (
    <HStack
        ref={rowRef}
        // Measured as the status dropdown's anchor; a flattened view has
        // nothing native to measure.
        collapsable={false}
        className="items-center"
        space="sm"
        pointerEvents="box-none"
        style={{ height }}
        testID="feed-header-title-row"
    >
        {title}
        {explainer}
        <View
            pointerEvents="none"
            style={{ flex: 1, minWidth: 0, alignItems: 'center' }}
            testID="feed-header-narration"
        >
            {narrating ? (
                <HeaderNarrationLine
                    stage={stage}
                    onDevice={onDevice}
                    layout="row"
                    maxLines={1}
                    align="center"
                    testID="feed-narration-line"
                />
            ) : null}
        </View>
        {mark}
    </HStack>
);

export default FeedHeaderTitleRow;
