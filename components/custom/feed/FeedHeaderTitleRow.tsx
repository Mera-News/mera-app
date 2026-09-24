import HeaderNarrationLine from '@/components/custom/for-you/HeaderNarrationLine';
import { HEADER_ACTIONS_GAP } from '@/components/custom/for-you/HeaderIconButton';
import { HStack } from '@/components/ui/hstack';
import type { FeedStatusMode } from '@/lib/feed-status-mode';
import type { ProcessingStageId } from '@/lib/services/processing-stage';
import React from 'react';
import { View } from 'react-native';

/**
 * The mode the Feed's Mera mark draws (owner: always there, small and still at
 * rest, bigger and drawing only while Mera is working).
 *
 * 'processing' only while `useIsFeedMarkActive` holds: the phone works, or the
 * server is scoring the reader's articles and progressing (a batch with no
 * progress for 15 min goes still). `statusMode` alone is `schedulerRunning ||
 * isFeedProcessing`: true on every five-minute poll that finds nothing. Every
 * other state passes through, so error (red) and limited (amber) show on a
 * still mark.
 */
export function feedMarkMode(markActive: boolean, mode: FeedStatusMode): FeedStatusMode {
    return mode === 'processing' && !markActive ? 'idle' : mode;
}

export interface FeedHeaderTitleRowProps {
    /** Pinned row height (`headerTitleLineHeight`), the same in every state. */
    height: number;
    title: React.ReactNode;
    /** The "?" explainer, right after the title. */
    explainer: React.ReactNode;
    /** The Mera status mark, left of the bell, in every state. */
    mark: React.ReactNode;
    /** The shared notification bell, the row's right end (owner). */
    bell: React.ReactNode;
    /** A sync is really running (`useIsFeedProcessing`). */
    narrating: boolean;
    stage: ProcessingStageId | null;
    onDevice: boolean;
    /** The row itself, measured as the status dropdown's anchor. */
    rowRef?: React.Ref<View>;
}

/**
 * The Feed's title row: `|Feed (?)   Reading your stories   ◈  🔔|`.
 *
 * Owner layout: the "?" sits next to the title, then the narration, then the
 * `[mark] [bell]` cluster (the same as the Dashboard's). The "what Mera is
 * doing" narration lives ONLY here, one line, CENTRED in the space between the
 * "?" and the mark. Its budget is `NARRATION_INLINE_WIDTH_PT_WIDE` /
 * `_COMPACT` (header-narration.ts): every line fits at 400pt+, and on a compact
 * phone a bounded few lines are trimmed with "…" by decision. The row's
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
    bell,
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
        {/* `[mark] [bell]`, the same right cluster as the Dashboard. The mark
            grows by transform, so neither the bell nor the narration reflows. */}
        <View
            pointerEvents="box-none"
            style={{ flexDirection: 'row', alignItems: 'center', gap: HEADER_ACTIONS_GAP }}
            testID="feed-header-actions"
        >
            {mark}
            {bell}
        </View>
    </HStack>
);

export default FeedHeaderTitleRow;
