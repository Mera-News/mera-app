// Dim: a card that stops being live fades to its dimmed opacity instead of cutting to it.
// A wrapper of its own, because the card's root already carries the entering fade on opacity.
// React Native's Animated, so the fade also runs in Lite mode.
import { APPEAR } from '@/components/ui/appear';
import React, { useEffect, useRef, useState } from 'react';
import { Animated } from 'react-native';

export function Dim({ on, to, children }: { on: boolean; to: number; children: React.ReactNode }) {
  const [opacity] = useState(() => new Animated.Value(on ? to : 1));
  const first = useRef(true);
  useEffect(() => {
    // A card that mounts dimmed (a reopened thread) is drawn dimmed, with no fade.
    if (first.current) {
      first.current = false;
      return;
    }
    const run = Animated.timing(opacity, { toValue: on ? to : 1, duration: APPEAR.out, useNativeDriver: true });
    run.start();
    return () => run.stop();
  }, [on, to, opacity]);
  return <Animated.View style={{ opacity }}>{children}</Animated.View>;
}
