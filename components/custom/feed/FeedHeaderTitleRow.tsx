import HeaderNarrationLine from '@/components/custom/for-you/HeaderNarrationLine';
import { HStack } from '@/components/ui/hstack';
import type { FeedStatusMode } from '@/lib/feed-status-mode';
import type { ProcessingStageId } from '@/lib/services/processing-stage';
import React from 'react';
import { View } from 'react-native';

/**
 * Whether the Feed shows its Mera mark (owner: only while Mera is working).
 *
 * While a sync narrates, and ALSO in the capped and error states, where the
 * mark is still and coloured: its ink is the Feed's only signal for those two,
 * and the panel behind it is the only path to "Manage plan" or the error. At
 * idle, deferred, or a bare scheduler poll (`statusMode === 'processing'`
 * without `narrating`) there is no mark. Gated on `narrating`, never on the
 * mode's 'processing', for the same reason the narration is.
 */
export function feedMarkVisible(narrating: boolean, mode: FeedStatusMode): boolean {
    return narrating || mode === 'error' || mode === 'limited';
}

export interface FeedHeaderTitleRowProps {
    /** Pinned row height (`headerTitleLineHeight`), the same in every state. */
    height: number;
    title: React.ReactNode;
    /** The "?" explainer, right after the title. */
    explainer: React.ReactNode;
    /**
     * The Mera status mark at the row's right end, or null when the screen is
     * not showing it (at idle the Feed shows none).
     */
    mark: React.ReactNode;
    /** A sync is really running (`useIsFeedProcessing`). */
    narrating: boolean;
    stage: ProcessingStageId | null;
    onDevice: boolean;
}

/**
 * The Feed's title row: `|Feed (?)      Reading your stories  ◈|`.
 *
 * Owner layout: the "?" sits next to the title and the Mera mark takes the
 * right-most spot. The "what Mera is doing" narration lives ONLY here, inline,
 * one line, CENTRED in the space between the "?" and the mark (owner). The row holds the same four things it
 * always did, so the narration keeps its measured ~170pt budget
 * (`NARRATION_INLINE_WIDTH_PT`); a longer line is trimmed with "…". The row's
 * height is pinned in every state, so a sync starting or ending, or the mark
 * appearing, never moves the header, the list padding or the refresh spinner.
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
}) => (
    <HStack
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
