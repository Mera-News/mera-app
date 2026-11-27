// A tab's content glides in from the side its tab sits on when the tab is picked. The native tab
// bar swaps tabs with a cut and offers no transition of its own.
//
// Movement only, never opacity: the content is fully drawn from the first frame, because a
// whole-screen fade read as a flicker (owner). So Lite and Reduce Motion keep the plain cut.
//
// `useIsFocused` here is the TAB's focus: a screen pushed over the tabs does not blur it, so
// coming back from an article never replays the glide.
import { useIsFocused } from 'expo-router';
import React, { useEffect, useState } from 'react';
import { Animated, Easing, I18nManager, StyleSheet } from 'react-native';
import { useMotionAllowed } from '@/lib/motion-gate';
import { APPEAR, ARRIVE_BEZIER } from './tokens';

const ARRIVE = Easing.bezier(...ARRIVE_BEZIER);
/** How far to the side the arriving tab starts, in points. */
const NUDGE = 12;

// The tab shown before this one; null until the launch's first tab, which is drawn at rest.
let lastIndex: number | null = null;

export function TabArrive({ index, children }: { index: number; children: React.ReactNode }): React.ReactElement {
  const focused = useIsFocused();
  const moves = useMotionAllowed();
  const [x] = useState(() => new Animated.Value(0));

  useEffect(() => {
    if (!focused) return;
    const from = lastIndex;
    lastIndex = index;
    if (from === null || from === index || !moves) return;
    const side = (index > from ? 1 : -1) * (I18nManager.isRTL ? -1 : 1);
    x.setValue(side * NUDGE);
    const run = Animated.timing(x, { toValue: 0, duration: APPEAR.in, easing: ARRIVE, useNativeDriver: true });
    run.start();
    return () => {
      run.stop();
      // A tab left mid-glide must not come back off its place.
      x.setValue(0);
    };
    // `moves` is read at the switch; a Lite flip must not replay the glide.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focused, index, x]);

  return (
    <Animated.View testID="tab-arrive" style={[styles.fill, { transform: [{ translateX: x }] }]}>
      {children}
    </Animated.View>
  );
}

/** Tests only. */
export function resetTabArriveForTests(): void {
  lastIndex = null;
}

const styles = StyleSheet.create({ fill: { flex: 1 } });
