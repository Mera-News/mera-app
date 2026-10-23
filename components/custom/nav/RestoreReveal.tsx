// The top list after an update reload: drawn at opacity 0 while its restored
// scroll lands (at most SCROLL_LAND_MAX_MS), then faded in, so the reader never
// sees it run from the top to their place. No fade in Lite or Reduce Motion.

import React, { useEffect } from 'react';
import type { StyleProp, ViewStyle } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';

import { useMotionAllowed } from '@/lib/motion-gate';

const FADE_MS = 180;

export default function RestoreReveal({
  hidden,
  style,
  children,
}: {
  readonly hidden: boolean;
  readonly style?: StyleProp<ViewStyle>;
  readonly children: React.ReactNode;
}) {
  const motion = useMotionAllowed();
  const opacity = useSharedValue(hidden ? 0 : 1);
  useEffect(() => {
    if (hidden) opacity.value = 0;
    else opacity.value = motion ? withTiming(1, { duration: FADE_MS }) : 1;
  }, [hidden, motion, opacity]);
  const animated = useAnimatedStyle(() => ({ opacity: opacity.value }));
  return <Animated.View style={[{ flex: 1 }, style, animated]}>{children}</Animated.View>;
}
