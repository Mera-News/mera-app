// FinalFeed #12, Settings > Display > Minimap: every card is a short line down
// the left, white once seen and longer orange while new. The frame is the rows
// on screen; the strip scrolls with the Feed so the frame stays in view, and a
// drag (or a tap) jumps the list there.
//
// No JS per scroll frame: the frame and the strip's offset are shared values,
// set when the on-screen rows change. The ticks re-derive only when the list,
// the seen set or the visit's `newSince` changes. Decoration for sight only:
// hidden from screen readers, which scroll the list itself.
//
// ponytail: ticks are spaced uniformly by index, not by card height; measure
// heights if the owner wants the map to match long and short cards.

import { useColors } from '@/lib/theme/tokens';
import { useFeedOrderStore } from '@/lib/stores/feed-order-store';
import { useOpenedStoriesStore } from '@/lib/stores/opened-stories-store';
import type { ForYouSuggestion } from '@/lib/stores/for-you-store';
import React, { useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { runOnJS, type SharedValue, useAnimatedStyle, useDerivedValue, useSharedValue } from 'react-native-reanimated';
import { arrivedAtOf, isNewCard } from './feed-entries';

/** The strip's width; the list pads its left edge to clear it. */
export const MINIMAP_LIST_INSET = 34;
const STRIP_LEFT = 9;
const STRIP_WIDTH = 18;
const ROW_SPACING = 8;
const TICK_HEIGHT = 3;
const TICK_SEEN = 11;
const TICK_NEW = 16;

export interface MinimapRow {
  readonly id: string;
  readonly suggestion: ForYouSuggestion;
}

export interface FeedMinimapProps {
  readonly rows: readonly MinimapRow[];
  readonly newSince: number | null;
  /** Index range of the rows on screen (shared values, set by the screen). */
  readonly first: SharedValue<number>;
  readonly last: SharedValue<number>;
  /** Strip top and bottom, in the screen's coordinates. */
  readonly top: number;
  readonly bottom: number;
  readonly onJump: (index: number) => void;
}

const FeedMinimap: React.FC<FeedMinimapProps> = ({ rows, newSince, first, last, top, bottom, onJump }) => {
  const c = useColors();
  const cardStates = useFeedOrderStore((s) => s.cardStates);
  const opened = useOpenedStoriesStore((s) => s.articleIds);

  const ticks = useMemo(
    () =>
      rows.map((r) => {
        const seen = !!cardStates[r.id] || (!!r.suggestion.articleId && opened.has(r.suggestion.articleId));
        const isNew = newSince !== null && isNewCard(arrivedAtOf(r.suggestion), seen, newSince);
        return { id: r.id, seen, isNew };
      }),
    [rows, cardStates, opened, newSince],
  );

  const height = Math.max(0, bottom - top);
  const total = rows.length * ROW_SPACING;
  // Keep the frame in view: the column slides up as the frame moves down.
  const offset = useDerivedValue(() => {
    if (total <= height) return 0;
    const center = ((first.value + last.value + 1) / 2) * ROW_SPACING;
    return Math.min(0, Math.max(height - total, height / 2 - center));
  });
  const columnStyle = useAnimatedStyle(() => ({ transform: [{ translateY: offset.value }] }));
  const frameStyle = useAnimatedStyle(() => ({
    top: Math.max(0, first.value) * ROW_SPACING - 2,
    height: Math.max(1, last.value - first.value + 1) * ROW_SPACING + 2,
  }));

  const count = rows.length;
  // Jump only when the row under the finger changes, never per move event.
  const lastJump = useSharedValue(-1);
  const pan = useMemo(() => {
    const jumpTo = (y: number) => {
      'worklet';
      const i = Math.min(count - 1, Math.max(0, Math.floor((y - offset.value) / ROW_SPACING)));
      if (i === lastJump.value) return;
      lastJump.value = i;
      runOnJS(onJump)(i);
    };
    return Gesture.Pan()
      .minDistance(0)
      .onBegin((e) => jumpTo(e.y))
      .onUpdate((e) => jumpTo(e.y))
      .onFinalize(() => {
        lastJump.value = -1;
      });
  }, [count, onJump, offset, lastJump]);

  if (count === 0) return null;
  return (
    <GestureDetector gesture={pan}>
      <View
        style={[styles.strip, { top, height }]}
        accessible={false}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        testID="feed-minimap"
      >
        <Animated.View style={columnStyle}>
          {ticks.map((tk, i) => (
            <View
              key={tk.id}
              style={{
                position: 'absolute',
                top: i * ROW_SPACING + (ROW_SPACING - TICK_HEIGHT) / 2,
                left: 2,
                height: TICK_HEIGHT,
                borderRadius: TICK_HEIGHT / 2,
                width: tk.isNew ? TICK_NEW : TICK_SEEN,
                backgroundColor: tk.isNew ? c.accent : c.ink,
                opacity: tk.isNew ? 1 : tk.seen ? 0.55 : 0.25,
              }}
            />
          ))}
          <Animated.View style={[styles.frame, { borderColor: c.ink2 }, frameStyle]} />
        </Animated.View>
      </View>
    </GestureDetector>
  );
};

const styles = StyleSheet.create({
  strip: { position: 'absolute', left: STRIP_LEFT, width: STRIP_WIDTH, overflow: 'hidden' },
  frame: { position: 'absolute', left: 0, right: 0, borderWidth: 1, borderRadius: 3 },
});

export default FeedMinimap;
