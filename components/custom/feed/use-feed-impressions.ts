// use-feed-impressions — the Feed tab's viewability → impression bridge. As a
// card crosses the visibility threshold for long enough it is marked VIEWED:
// optimistically in the viewed-stories store (so buildFeedList drops it next
// rebuild) and durably via `recordImpression` (opened=false, surface 'feed').
// Mirrors exactly how the retired SwipeFeedScreen.recordSeen built its fields —
// the only difference is `recordImpression` (viewed) vs `recordOpen` (opened).

import { useRef } from 'react';
import type { ViewToken } from 'react-native';
import { recordImpression } from '@/lib/database/services/story-impression-service';
import { useViewedStoriesStore } from '@/lib/stores/viewed-stories-store';
import type { FeedListItem } from '@/lib/stores/feed-list-selector';
import type { ForYouSuggestion } from '@/lib/stores/for-you-store';

/** A card must be at least this visible to start counting as viewed. */
export const FEED_VIEW_PERCENT = 60;
/** …and stay that visible for at least this long (ms). */
export const FEED_VIEW_MS = 1000;

/**
 * Pure filter: the newly-viewable feed items not already in `seen`. Extracted so
 * the viewability gate is unit-testable without a FlatList / device.
 */
export function collectNewlyViewed(
  changed: ViewToken[],
  seen: Set<string>,
): FeedListItem[] {
  const out: FeedListItem[] = [];
  for (const token of changed) {
    if (!token.isViewable) continue;
    const item = token.item as FeedListItem | null | undefined;
    if (!item) continue;
    if (seen.has(item.id)) continue;
    out.push(item);
  }
  return out;
}

/** Marks a suggestion viewed: optimistic store add + durable feed impression.
 *  Builds the same fields SwipeFeedScreen.recordSeen used (stable-cluster id +
 *  normalized title), only tagged surface 'feed' and opened=false. */
export function markViewedImpression(s: ForYouSuggestion): void {
  const stableClusterId =
    s.clusters?.find((c) => c.stableClusterId)?.stableClusterId ?? null;
  useViewedStoriesStore.getState().markViewed(s.articleId, stableClusterId);
  void recordImpression({
    articleId: s.articleId,
    suggestionId: s._id,
    stableClusterId,
    titleNorm: (s.title_en ?? '').toLowerCase().trim().replace(/\s+/g, ' ') || null,
    surface: 'feed',
  });
}

/**
 * Returns the `viewabilityConfigCallbackPairs` for the Feed FlatList — built
 * ONCE via a ref (FlatList forbids mutating this prop after mount). The callback
 * gates on tab focus (NativeTabs keeps every tab mounted, so an off-screen tab
 * would otherwise "view" everything) and a session-dedup set, then marks each
 * newly-viewed item.
 *
 * @param isFocused a boolean or a ref-to-boolean the callback reads at fire time.
 */
export function useFeedImpressions(isFocused: boolean | { current: boolean }) {
  const focusRef = useRef(isFocused);
  focusRef.current = isFocused;
  const dedup = useRef<Set<string>>(new Set());

  const pairs = useRef([
    {
      viewabilityConfig: {
        itemVisiblePercentThreshold: FEED_VIEW_PERCENT,
        minimumViewTime: FEED_VIEW_MS,
        waitForInteraction: false,
      },
      onViewableItemsChanged: ({ changed }: { changed: ViewToken[] }) => {
        const focused =
          typeof focusRef.current === 'boolean'
            ? focusRef.current
            : focusRef.current.current;
        if (!focused) return;
        const seen = dedup.current;
        for (const item of collectNewlyViewed(changed, seen)) {
          seen.add(item.id);
          markViewedImpression(item.suggestion);
        }
      },
    },
  ]);

  return { viewabilityConfigCallbackPairs: pairs.current };
}
