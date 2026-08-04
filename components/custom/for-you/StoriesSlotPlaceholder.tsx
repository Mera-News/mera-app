import TrackedStoriesScreen from '@/components/custom/tracked-stories/TrackedStoriesScreen';
import React from 'react';
import type { useAnimatedScrollHandler } from 'react-native-reanimated';

interface StoriesSlotPlaceholderProps {
    /** Host's collapsing-header scroll handler — forwarded verbatim. */
    scrollHandler?: ReturnType<typeof useAnimatedScrollHandler>;
    /** Host's measured header height — forwarded verbatim. */
    headerHeight?: number;
}

/**
 * @deprecated Thin shim kept so existing imports resolve. The Stories sub-tab
 * now renders the real embedded {@link TrackedStoriesScreen}; new code should
 * import that directly.
 */
const StoriesSlotPlaceholder: React.FC<StoriesSlotPlaceholderProps> = ({
    scrollHandler,
    headerHeight,
}) => <TrackedStoriesScreen embedded scrollHandler={scrollHandler} headerHeight={headerHeight} />;

export default StoriesSlotPlaceholder;
