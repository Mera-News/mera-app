// Browse tab — routing only. The orchestrator flips initialRouteName to
// `browse` and removes the `href: null` hiding in app_container/_layout.tsx.
import BrowseFeedScreen from '@/components/custom/swipe-feed/BrowseFeedScreen';

export default function BrowseTab() {
    return <BrowseFeedScreen />;
}
