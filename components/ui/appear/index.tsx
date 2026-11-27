// Appear: the one way an object fades in (and, when asked, out) across the app.
//
//   {loaded && <Appear>...</Appear>}          arrives with a fade and a small rise
//   <Appear show={open}>...</Appear>          also fades out before it unmounts
//
// Built on React Native's Animated with the native driver, opacity and transform only, so it
// costs no layout and no JS per frame, and a screen that uses it needs no Reanimated in its tests.
//
// Lite mode and the system's Reduce Motion keep the fade and drop the rise (owner: Lite phones get
// fades, never movement). Nothing here loops.
//
// NOT for rows of a virtualized list: a row that mounts while the reader scrolls must not fade in.
// Wrap the list's first content once instead.
import React, { useEffect, useRef, useState } from 'react';
import { Animated, Easing, type StyleProp, type ViewProps, type ViewStyle } from 'react-native';
import { useMotionAllowed } from '@/lib/motion-gate';
import { APPEAR, ARRIVE_BEZIER } from './tokens';

const ARRIVE = Easing.bezier(...ARRIVE_BEZIER);
const LEAVE = Easing.in(Easing.cubic);

export interface AppearProps extends Omit<ViewProps, 'style'> {
  /** Given: the children stay mounted until the fade out ends. Omitted: enter only. */
  show?: boolean;
  /** Points to rise from. 0 fades in place. */
  rise?: number;
  /** Milliseconds before the enter starts (a short stagger between siblings). */
  delay?: number;
  /** False draws the first mount at rest: for content that was already on screen. */
  animateOnMount?: boolean;
  style?: StyleProp<ViewStyle>;
  children?: React.ReactNode;
}

export function Appear({
  show,
  rise = APPEAR.rise,
  delay = 0,
  animateOnMount = true,
  style,
  children,
  ...rest
}: AppearProps): React.ReactElement | null {
  const visible = show ?? true;
  const moves = useMotionAllowed();
  const [mounted, setMounted] = useState(visible);
  // Shown again: mount in this same render, so the enter starts from a mounted view.
  if (visible && !mounted) setMounted(true);
  const [progress] = useState(() => new Animated.Value(visible && !animateOnMount ? 1 : 0));
  const first = useRef(true);

  useEffect(() => {
    const isFirst = first.current;
    first.current = false;
    if (visible) {
      if (isFirst && !animateOnMount) return;
      const run = Animated.timing(progress, {
        toValue: 1,
        duration: APPEAR.in,
        delay,
        easing: ARRIVE,
        useNativeDriver: true,
      });
      run.start();
      return () => run.stop();
    }
    const run = Animated.timing(progress, {
      toValue: 0,
      duration: APPEAR.out,
      easing: LEAVE,
      useNativeDriver: true,
    });
    run.start(({ finished }) => {
      if (finished) setMounted(false);
    });
    return () => run.stop();
    // `delay` and `animateOnMount` are read once, at the change of `visible`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, progress]);

  if (!mounted && !visible) return null;

  const motion: Animated.WithAnimatedValue<ViewStyle> = {
    opacity: progress,
    ...(moves && rise !== 0
      ? { transform: [{ translateY: progress.interpolate({ inputRange: [0, 1], outputRange: [rise, 0] }) }] }
      : null),
  };
  return (
    <Animated.View
      {...rest}
      // While leaving, the object no longer takes touches.
      pointerEvents={visible ? rest.pointerEvents : 'none'}
      style={[style, motion]}
    >
      {children}
    </Animated.View>
  );
}

export { APPEAR } from './tokens';
