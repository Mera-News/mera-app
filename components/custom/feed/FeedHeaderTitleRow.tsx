import HeaderNarrationLine from '@/components/custom/for-you/HeaderNarrationLine';
import { HStack } from '@/components/ui/hstack';
import type { ProcessingStageId } from '@/lib/services/processing-stage';
import React from 'react';
import { View } from 'react-native';

export interface FeedHeaderTitleRowProps {
    /** Pinned row height (`headerTitleLineHeight`), the same in every state. */
    height: number;
    title: React.ReactNode;
    /** The status mark beside the title. */
    mark: React.ReactNode;
    /** The "?" explainer at the row's end. */
    explainer: React.ReactNode;
    /** A sync is really running (`useIsFeedProcessing`). */
    narrating: boolean;
    stage: ProcessingStageId | null;
    onDevice: boolean;
}

/**
 * The Feed's title row: `|Feed ◈ Reading 12 of 40 articles…   (?)|`.
 *
 * The "what Mera is doing" narration lives ONLY here, inline, one line in the
 * space between the status mark and the "?" (owner). It used to have its own
 * row under the title. The narration copy is written to fit about 170pt; a
 * longer line is trimmed with "…". The row's height is pinned in every state,
 * so a sync starting or ending never moves the header, the list padding or the
 * refresh spinner.
 *
 * Pull-to-refresh passthrough: the row only CONTAINS controls (`box-none`),
 * and the narration slot is `none`, so a pan starting on it reaches the list.
 */
const FeedHeaderTitleRow: React.FC<FeedHeaderTitleRowProps> = ({
    height,
    title,
    mark,
    explainer,
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
        {mark}
        <View pointerEvents="none" style={{ flex: 1, minWidth: 0 }} testID="feed-header-narration">
            {narrating ? (
                <HeaderNarrationLine
                    stage={stage}
                    onDevice={onDevice}
                    layout="row"
                    maxLines={1}
                    testID="feed-narration-line"
                />
            ) : null}
        </View>
        {explainer}
    </HStack>
);

export default FeedHeaderTitleRow;
