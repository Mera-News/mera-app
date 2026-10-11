// maintainVisibleContentPosition only once the list header (the counts card)
// has scrolled fully above the viewport.
//
// VirtualizedList adds 1 to `minIndexForVisible` whenever a ListHeaderComponent
// is set, so iOS never anchors on the header: it holds the first ROW still and
// moves the offset by every change in the header's height. Opening the counts
// card grew it UPWARD under the tab header, and its settling at launch (counts
// land, the sentence rewraps, the mark resizes) shifted the offset, which the
// collapsing header read as a scroll down and hid. While any of the header is
// on screen no row sits above the viewport, so anchoring has nothing to protect.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { LayoutChangeEvent } from 'react-native';
import { runOnJS, useAnimatedScrollHandler, useSharedValue } from 'react-native-reanimated';

/** `topPadding` is the list content's paddingTop, where the header starts.
 *  Wire `onListHeaderLayout` to a View wrapping the header element and compose
 *  `anchorHandler` into the list's `onScroll`. */
export function useAnchorPastHeader(topPadding: number) {
  // Read on the UI thread only (a JS read of a shared value can come back
  // stale); the height's truth on JS is the ref.
  const headerBottom = useSharedValue(0);
  const past = useSharedValue(false);
  const heightRef = useRef(0);
  const [pastHeader, setPastHeader] = useState(false);

  useEffect(() => {
    headerBottom.value = topPadding + heightRef.current;
  }, [topPadding, headerBottom]);

  const onListHeaderLayout = useCallback(
    (e: LayoutChangeEvent) => {
      // Relative to VirtualizedList's own header cell, so y is 0: the cell
      // starts at the content's paddingTop.
      heightRef.current = e.nativeEvent.layout.height;
      headerBottom.value = topPadding + heightRef.current;
    },
    [topPadding, headerBottom],
  );

  const anchorHandler = useAnimatedScrollHandler({
    onScroll: (e) => {
      const isPast = e.contentOffset.y > headerBottom.value;
      if (isPast === past.value) return;
      past.value = isPast;
      runOnJS(setPastHeader)(isPast);
    },
  });

  return { pastHeader, onListHeaderLayout, anchorHandler };
}
