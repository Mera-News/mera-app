// The Feed's Mera mark wired to the status dropdown: tap to drop the status
// panel under the title row, tap again (the backdrop) to close it.
//
// A dropdown, not an inline panel under the row: the inline panel grew the
// header, which re-padded the list, and after it closed the list sat ~99pt
// down (captured). See for-you/status-dropdown.tsx.

import FeedStatusIndicator from '@/components/custom/for-you/FeedStatusIndicator';
import { measureAnchor } from '@/components/custom/for-you/stats-card-dropdown';
import { useStatusDropdown } from '@/components/custom/for-you/status-dropdown';
import type { FeedStatusMode } from '@/lib/feed-status-mode';
import React, { useCallback } from 'react';
import type { View } from 'react-native';

export interface FeedStatusMarkProps {
    /** `feedMarkMode(narrating, statusMode)`. */
    readonly mode: FeedStatusMode;
    /** The title row: the panel drops down under it, at its width. */
    readonly anchorRef: React.RefObject<View | null>;
    /** `feed-status-indicator` on the Feed, `dashboard-status-indicator` on the Dashboard. */
    readonly testID?: string;
}

const FeedStatusMark: React.FC<FeedStatusMarkProps> = ({ mode, anchorRef, testID = 'feed-status-indicator' }) => {
    const { expanded, open, collapse } = useStatusDropdown();
    const onPress = useCallback(() => {
        if (expanded) collapse();
        else measureAnchor(anchorRef.current, open);
    }, [expanded, collapse, open, anchorRef]);
    return (
        <FeedStatusIndicator
            mode={mode}
            expanded={expanded}
            onPress={onPress}
            testID={testID}
        />
    );
};

export default FeedStatusMark;
