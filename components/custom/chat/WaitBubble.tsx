// The wait bubble: outlined, unfilled, and breathing.
//
// ## Why the animation lives here and not in `components/ui/chat-ai`
//
// A glowing outline needs a Reanimated `Animated.View`. Putting that import in
// the shared chat primitives forces EVERY present and future test that renders
// any chat primitive to mock a native module; it broke
// `components/ui/chat-ai/__tests__/prompt-input-a11y.test.tsx` the moment it
// was tried, with "Native part of Worklets doesn't seem to be initialized".
// `chat-ai` keeps the static look as `variant="transient"` and exposes an
// `as` / `style` seam, and the one feature that wants motion pays for it.
//
// ## Why it is its own component rather than a hook in ChatThread
//
// The loop runs only while this is mounted, which is only while a turn is
// waiting. A hook at the thread's top level would breathe forever behind a
// settled conversation.

import { GLOW_BRIGHT, GLOW_DIM, MessageContent } from '@/components/ui/chat-ai';
import React, { useEffect } from 'react';
import Animated, {
  cancelAnimation,
  Easing,
  interpolateColor,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';

/** One direction of the pulse. Reversed, so a full breath is twice this. */
export const GLOW_MS = 1400;

export interface WaitBubbleProps {
  testID?: string;
  children: React.ReactNode;
}

export const WaitBubble: React.FC<WaitBubbleProps> = ({
  testID = 'chat-wait-bubble',
  children,
}) => {
  const reduceMotion = useReducedMotion();
  const glow = useSharedValue(0);

  useEffect(() => {
    if (reduceMotion) {
      // Parked at the BRIGHT end, not the dim one. Someone who asked for less
      // motion still has to be able to see the outline, and resting it at the
      // dim end would leave the wait bubble faintest for exactly the people
      // least likely to catch a subtle one.
      cancelAnimation(glow);
      glow.value = 1;
      return;
    }
    glow.value = withRepeat(
      withTiming(1, { duration: GLOW_MS, easing: Easing.inOut(Easing.quad) }),
      -1,
      // Reversed, so the outline fades back down instead of snapping dark and
      // restarting, which reads as a blink rather than a breath.
      true,
    );
    return () => cancelAnimation(glow);
  }, [reduceMotion, glow]);

  // Two layers, and the halo is a progressive enhancement rather than a
  // platform fork: `borderColor` breathes on BOTH platforms and is the whole
  // effect on Android, while the bloom underneath is iOS-only because Android
  // tints nothing from `shadowColor` and takes its depth from `elevation`,
  // which `bubbleTransient` pins at 0 on purpose. Android gets a quieter
  // version of the same idea, not a different one.
  const glowStyle = useAnimatedStyle(() => ({
    borderColor: interpolateColor(glow.value, [0, 1], [GLOW_DIM, GLOW_BRIGHT]),
    shadowOpacity: 0.1 + glow.value * 0.35,
  }));

  return (
    <MessageContent
      role="assistant"
      variant="transient"
      as={Animated.View}
      style={glowStyle}
      testID={testID}
    >
      {children}
    </MessageContent>
  );
};

export default WaitBubble;
