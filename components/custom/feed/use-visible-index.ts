// use-visible-index — the Feed tab's viewability → freeze-boundary bridge. The
// static insert-only feed (r6 P2) never marks a card viewed/consumed from
// scrolling; scrolling ONLY advances the max visible index, which the ingest
// step reads as `maxVisibleIndex + 2` to freeze everything at or above the
// user's current viewport before insertion-sorting new completes into the tail.
//
// The callback writes only into a ref — no store writes, no DB writes, no state
// updates mid-scroll (the scroll-lag fix).

import { useRef } from 'react';
import type { ViewToken } from 'react-native';

export function useVisibleIndex() {
  const maxVisibleIndexRef = useRef(0);

  // Built ONCE via a ref (FlatList forbids mutating this prop after mount).
  const pairs = useRef([
    {
      viewabilityConfig: {
        itemVisiblePercentThreshold: 10,
        minimumViewTime: 0,
      },
      onViewableItemsChanged: ({ viewableItems }: { viewableItems: ViewToken[] }) => {
        for (const v of viewableItems) {
          const idx = v.index ?? 0;
          if (idx > maxVisibleIndexRef.current) maxVisibleIndexRef.current = idx;
        }
      },
    },
  ]);

  return { viewabilityConfigCallbackPairs: pairs.current, maxVisibleIndexRef };
}
