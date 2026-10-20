// One step's 20pt glyph: pending loops its Lottie, landing shows it briefly and
// then draws the tick, done is the still tick. Decorative: the row's words are
// the accessible element, so everything here is hidden from the tree.

import { useMotionAllowed } from '@/lib/motion-gate';
import type { StepKind } from '@/lib/services/chat-phase';
import { useColors } from '@/lib/theme/tokens';
import LottieView from 'lottie-react-native';
import React, { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, { Easing, useAnimatedProps, useSharedValue, withTiming } from 'react-native-reanimated';
import Svg, { Circle, Path } from 'react-native-svg';
import { chatStepAnimationFor } from './animation-registry';
import { stripColorFilters } from './strip-display';

export type StepGlyphState = 'pending' | 'landing' | 'done';

export interface StepGlyphProps {
  kind: StepKind;
  state: StepGlyphState;
  /** Lands this long after the glyph's own 0.3 s (stagger for several rows). */
  delayMs?: number;
}

const SIZE = 20;
const TICK = 'M5 10.5l3 3 7-7';
const TICK_LENGTH = 16;
const GLYPH_HOLD_MS = 300;
const DRAW_MS = 500;

const AnimatedPath = Animated.createAnimatedComponent(Path);

const HIDDEN = {
  accessible: false,
  importantForAccessibility: 'no-hide-descendants',
  accessibilityElementsHidden: true,
} as const;

const Tick: React.FC<{ draw: boolean; color: string }> = ({ draw, color }) => {
  const offset = useSharedValue(draw ? TICK_LENGTH : 0);
  useEffect(() => {
    if (draw) {
      offset.value = TICK_LENGTH;
      offset.value = withTiming(0, { duration: DRAW_MS, easing: Easing.out(Easing.cubic) });
    }
  }, [draw, offset]);
  const props = useAnimatedProps(() => ({ strokeDashoffset: offset.value }));
  return (
    <Svg width={SIZE} height={SIZE} viewBox="0 0 20 20">
      <AnimatedPath
        d={TICK}
        fill="none"
        stroke={color}
        strokeWidth={1.8}
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeDasharray={TICK_LENGTH}
        animatedProps={props}
      />
    </Svg>
  );
};

export const StepGlyph: React.FC<StepGlyphProps> = ({ kind, state, delayMs = 0 }) => {
  const colors = useColors();
  const motion = useMotionAllowed();
  const [showTick, setShowTick] = useState(state === 'done' || (state === 'landing' && !motion));

  useEffect(() => {
    if (state === 'done' || (state === 'landing' && !motion)) {
      setShowTick(true);
      return;
    }
    if (state === 'pending') {
      setShowTick(false);
      return;
    }
    const timer = setTimeout(() => setShowTick(true), GLYPH_HOLD_MS + delayMs);
    return () => clearTimeout(timer);
  }, [state, motion, delayMs]);

  let body: React.ReactNode;
  if (showTick) {
    body = <Tick draw={state === 'landing' && motion} color={colors.accentMark} />;
  } else {
    const source = kind === 'working' ? null : chatStepAnimationFor(kind);
    body =
      source === null ? (
        <Svg width={SIZE} height={SIZE} viewBox="0 0 20 20">
          <Circle cx={10} cy={10} r={3} fill={colors.ink3} />
        </Svg>
      ) : (
        <LottieView
          source={source as never}
          style={styles.fill}
          loop
          autoPlay={motion}
          progress={motion ? undefined : 0}
          colorFilters={stripColorFilters(colors, 'box')}
        />
      );
  }
  return (
    <View style={styles.box} {...HIDDEN}>
      {body}
    </View>
  );
};

const styles = StyleSheet.create({
  box: { width: SIZE, height: SIZE, alignItems: 'center', justifyContent: 'center' },
  fill: { width: SIZE, height: SIZE },
});

export default StepGlyph;
