import TrackedStoriesScreen from '@/components/custom/tracked-stories/TrackedStoriesScreen';
import React from 'react';

/**
 * @deprecated Thin shim kept so existing imports resolve. The Stories sub-tab
 * now renders the real embedded {@link TrackedStoriesScreen}; new code should
 * import that directly.
 */
const StoriesSlotPlaceholder: React.FC = () => <TrackedStoriesScreen embedded />;

export default StoriesSlotPlaceholder;
