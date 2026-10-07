// FinalFeed #10: while any new card is out of view below, a soft orange glow
// rises behind the tab bar. No count, no pill. Fades in and out on the UI
// thread (MOTION.glow); Reduce Motion swaps. Decoration only: hidden from
// screen readers (FeedScreen announces "New stories below" once instead) and
// never takes a touch.

import { MOTION } from '@/lib/motion';
import { useColors } from '@/lib/theme/tokens';
import React, { useEffect } from 'react';
import { StyleSheet } from 'react-native';
import Animated, { useAnimatedStyle, useReducedMotion, useSharedValue, withTiming } from 'react-native-reanimated';
import Svg, { Defs, RadialGradient, Rect, Stop } from 'react-native-svg';

const GLOW_HEIGHT = 230;
const GLOW_PEAK_OPACITY = 0.34;

const NewCardsGlow: React.FC<{ readonly visible: boolean }> = ({ visible }) => {
  const c = useColors();
  const reduceMotion = useReducedMotion();
  const opacity = useSharedValue(visible ? 1 : 0);
  useEffect(() => {
    opacity.value = reduceMotion ? (visible ? 1 : 0) : withTiming(visible ? 1 : 0, { duration: MOTION.glow.fade });
  }, [visible, reduceMotion, opacity]);
  const style = useAnimatedStyle(() => ({ opacity: opacity.value }));
  return (
    <Animated.View
      pointerEvents="none"
      accessible={false}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[styles.glow, style]}
      testID="feed-new-below-glow"
    >
      <Svg width="100%" height={GLOW_HEIGHT}>
        <Defs>
          <RadialGradient id="feedNewGlow" cx="50%" cy="100%" rx="70%" ry="100%">
            <Stop offset="0" stopColor={c.accent} stopOpacity={GLOW_PEAK_OPACITY} />
            <Stop offset="1" stopColor={c.accent} stopOpacity={0} />
          </RadialGradient>
        </Defs>
        <Rect x="0" y="0" width="100%" height={GLOW_HEIGHT} fill="url(#feedNewGlow)" />
      </Svg>
    </Animated.View>
  );
};

const styles = StyleSheet.create({
  glow: { position: 'absolute', left: 0, right: 0, bottom: 0, height: GLOW_HEIGHT },
});

export default NewCardsGlow;
