// SwipeDeck — the Tinder-style card stack for the Feed tab. Renders the top 3
// entries of the deck-store window: the top card is drag-swipeable (a swipe is a
// QUICK verdict — record + advance, NO tree), the two behind it are scaled/offset
// and promote as the top card is dragged. A sentinel entry renders the
// AllCaughtUpCard sized like a card; swiping/Next-ing past it triggers segment
// finalization (no verdict bar for a sentinel).
//
// The labeled VerdictBar (rendered by the screen, not here) remains the PRIMARY
// interaction; the swipe is the secondary quick path.

import AllCaughtUpCard from '@/components/custom/AllCaughtUpCard';
import { Box } from '@/components/ui/box';
import type { SwipeDeckCandidate } from '@/lib/stores/swipe-stack-selector';
import type { Verdict } from '@/lib/stores/swipe-deck-store';
import React from 'react';
import { StyleSheet, useWindowDimensions } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  interpolate,
  runOnJS,
  useAnimatedStyle,
  useDerivedValue,
  useSharedValue,
  withSpring,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';
import SwipeArticleCard from './SwipeArticleCard';
import { useReduceMotion } from './useReduceMotion';

export interface DeckWindowEntry {
  /** order[i] — a card id or the caught-up sentinel. */
  key: string;
  /** Resolved candidate, or null for a sentinel. */
  candidate: SwipeDeckCandidate | null;
  isSentinel: boolean;
}

interface SwipeDeckProps {
  /** Up to 3 entries (index 0 = top), resolved from the deck store. */
  window: DeckWindowEntry[];
  /** Quick-swipe committed a verdict on a real top card. */
  onSwipeVerdict: (verdict: Verdict) => void;
  /** Swiped past a sentinel top card (finalize the next segment / end). */
  onAdvanceSentinel: () => void;
  /** Deck-area horizontal margin (card width = screen − 2 × margin). */
  hMargin?: number;
}

const BEHIND_SCALE = [1, 0.94, 0.9];
const BEHIND_TY = [0, 12, 22];
const SWIPE_OFF_MS = 220;
const SPRING = { damping: 18, stiffness: 180 };
const VELOCITY_THRESHOLD = 800;
const DISTANCE_FRACTION = 0.35;
const STAMP_FRACTION = 0.25;

/** A behind-the-top card: statically scaled/offset, promoted toward the top
 *  slot as the top card is dragged away. */
const BehindCard: React.FC<{
  entry: DeckWindowEntry;
  depth: number; // 1 or 2
  dragProgress: SharedValue<number>;
  zero: SharedValue<number>;
}> = ({ entry, depth, dragProgress, zero }) => {
  const style = useAnimatedStyle(() => {
    const from = BEHIND_SCALE[depth];
    const to = BEHIND_SCALE[depth - 1];
    const scale = from + (to - from) * dragProgress.value;
    const tyFrom = BEHIND_TY[depth];
    const tyTo = BEHIND_TY[depth - 1];
    const translateY = tyFrom + (tyTo - tyFrom) * dragProgress.value;
    return { transform: [{ translateY }, { scale }] };
  });
  return (
    <Animated.View style={[StyleSheet.absoluteFill, style]} pointerEvents="none">
      {entry.isSentinel || !entry.candidate ? (
        <SentinelCard />
      ) : (
        <SwipeArticleCard
          suggestion={entry.candidate.suggestion}
          memberCount={entry.candidate.memberCount}
          likeOpacity={zero}
          nopeOpacity={zero}
          interactive={false}
        />
      )}
    </Animated.View>
  );
};

const SentinelCard: React.FC = () => (
  <Box className="flex-1 items-center justify-center rounded-2xl bg-background-50 border border-outline-100 overflow-hidden">
    <AllCaughtUpCard />
  </Box>
);

const SwipeDeck: React.FC<SwipeDeckProps> = ({
  window: deckWindow,
  onSwipeVerdict,
  onAdvanceSentinel,
  hMargin = 16,
}) => {
  const { width } = useWindowDimensions();
  const cardWidth = Math.max(0, width - 2 * hMargin);
  const reduceMotion = useReduceMotion();

  const translateX = useSharedValue(0);
  const translateY = useSharedValue(0);
  const opacity = useSharedValue(1);
  const zero = useSharedValue(0);

  const top = deckWindow[0];
  const topKey = top?.key;
  const topIsSentinel = !!top?.isSentinel;

  // Reset the animated transform whenever the top card changes (post-commit the
  // new top must start centered + opaque).
  React.useEffect(() => {
    translateX.value = 0;
    translateY.value = 0;
    opacity.value = 1;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [topKey]);

  const commitVerdict = React.useCallback(
    (verdict: Verdict) => {
      translateX.value = 0;
      translateY.value = 0;
      opacity.value = 1;
      onSwipeVerdict(verdict);
    },
    [onSwipeVerdict, translateX, translateY, opacity],
  );

  const commitSentinel = React.useCallback(() => {
    translateX.value = 0;
    translateY.value = 0;
    opacity.value = 1;
    onAdvanceSentinel();
  }, [onAdvanceSentinel, translateX, translateY, opacity]);

  const dragProgress = useSharedValue(0);

  const panGesture = React.useMemo(
    () =>
      Gesture.Pan()
        .activeOffsetX([-12, 12])
        .onUpdate((e) => {
          translateX.value = e.translationX;
          translateY.value = e.translationY;
          const threshold = cardWidth * DISTANCE_FRACTION || 1;
          dragProgress.value = Math.min(1, Math.abs(e.translationX) / threshold);
        })
        .onEnd((e) => {
          const past =
            Math.abs(e.translationX) > cardWidth * DISTANCE_FRACTION ||
            Math.abs(e.velocityX) > VELOCITY_THRESHOLD;
          if (past) {
            const goRight = e.translationX > 0;
            const offX = (goRight ? 1 : -1) * (cardWidth * 1.5);
            dragProgress.value = withTiming(1, { duration: SWIPE_OFF_MS });
            if (reduceMotion) {
              opacity.value = withTiming(0, { duration: SWIPE_OFF_MS }, (done) => {
                if (done) {
                  if (topIsSentinel) runOnJS(commitSentinel)();
                  else runOnJS(commitVerdict)(goRight ? 'like' : 'dislike');
                }
              });
            } else {
              translateX.value = withTiming(offX, { duration: SWIPE_OFF_MS }, (done) => {
                if (done) {
                  if (topIsSentinel) runOnJS(commitSentinel)();
                  else runOnJS(commitVerdict)(goRight ? 'like' : 'dislike');
                }
              });
            }
          } else {
            dragProgress.value = reduceMotion
              ? withTiming(0, { duration: 120 })
              : withSpring(0, SPRING);
            if (reduceMotion) {
              translateX.value = withTiming(0, { duration: 120 });
              translateY.value = withTiming(0, { duration: 120 });
            } else {
              translateX.value = withSpring(0, SPRING);
              translateY.value = withSpring(0, SPRING);
            }
          }
        }),
    [cardWidth, reduceMotion, topIsSentinel, commitVerdict, commitSentinel, translateX, translateY, opacity, dragProgress],
  );

  const topStyle = useAnimatedStyle(() => {
    const rotate = reduceMotion
      ? '0deg'
      : `${interpolate(translateX.value, [-cardWidth, 0, cardWidth], [-12, 0, 12])}deg`;
    return {
      opacity: opacity.value,
      transform: [
        { translateX: translateX.value },
        { translateY: translateY.value },
        { rotate },
      ],
    };
  });

  // LIKE/NOPE stamp opacities derived from the top card's horizontal drag.
  const likeOpacity = useDerivedValue(() => {
    const t = cardWidth * STAMP_FRACTION || 1;
    return Math.max(0, Math.min(1, translateX.value / t));
  });
  const nopeOpacity = useDerivedValue(() => {
    const t = cardWidth * STAMP_FRACTION || 1;
    return Math.max(0, Math.min(1, -translateX.value / t));
  });

  if (!top) return null;

  return (
    <Box style={{ flex: 1, width: cardWidth, alignSelf: 'center' }}>
      {/* Behind cards (render first = lower z). */}
      {deckWindow[2] ? (
        <BehindCard entry={deckWindow[2]} depth={2} dragProgress={dragProgress} zero={zero} />
      ) : null}
      {deckWindow[1] ? (
        <BehindCard entry={deckWindow[1]} depth={1} dragProgress={dragProgress} zero={zero} />
      ) : null}

      {/* Top card (gesture + animated). */}
      <GestureDetector gesture={panGesture}>
        <Animated.View style={[StyleSheet.absoluteFill, topStyle]}>
          {topIsSentinel || !top.candidate ? (
            <SentinelCard />
          ) : (
            <SwipeArticleCard
              suggestion={top.candidate.suggestion}
              memberCount={top.candidate.memberCount}
              likeOpacity={likeOpacity}
              nopeOpacity={nopeOpacity}
              interactive
            />
          )}
        </Animated.View>
      </GestureDetector>
    </Box>
  );
};

export default SwipeDeck;
