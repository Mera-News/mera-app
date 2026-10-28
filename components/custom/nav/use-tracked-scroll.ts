// A list's offset for the tab re-tap, for a list whose onScroll is the tab
// header's worklet handler. The offset is a UI-thread shared value: nothing
// crosses to JS while the reader scrolls, and the one read at a re-tap is a
// synchronous read of the UI copy (fresh, since only the UI thread writes it).

import { useAnimatedScrollHandler, useComposedEventHandler, useSharedValue } from 'react-native-reanimated';

type ScrollHandler = ReturnType<typeof useAnimatedScrollHandler>;

/** `base` plus offset tracking: pass `onScroll` to the list and `getOffset` to
 *  `usePageScrollTarget`. */
export function useTrackedScroll(base: ScrollHandler | null | undefined) {
  const y = useSharedValue(0);
  const track = useAnimatedScrollHandler({
    onScroll: (e) => {
      y.value = e.contentOffset.y;
    },
  });
  const onScroll = useComposedEventHandler([base ?? null, track]);
  return { onScroll, getOffset: () => y.value };
}
