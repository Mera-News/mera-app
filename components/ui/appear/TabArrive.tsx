// A tab's content fades in when its tab is picked. The native tab bar swaps tabs with a cut and
// offers no transition of its own, so the arriving tab fades in place: opacity only, native
// driver, the same in Lite and under Reduce Motion (nothing moves).
//
// `useIsFocused` here is the TAB's focus: a screen pushed over the tabs does not blur it, so
// coming back from an article never replays the fade.
import { useIsFocused } from 'expo-router';
import React, { useEffect, useState } from 'react';
import { Animated, Easing, StyleSheet } from 'react-native';
import { APPEAR, ARRIVE_BEZIER } from './tokens';

const ARRIVE = Easing.bezier(...ARRIVE_BEZIER);

// The first tab shown at launch is drawn at rest: the launch has its own handoff.
let shownOnce = false;

export function TabArrive({ children }: { children: React.ReactNode }): React.ReactElement {
  const focused = useIsFocused();
  const [progress] = useState(() => new Animated.Value(1));

  useEffect(() => {
    if (!focused) return;
    if (!shownOnce) {
      shownOnce = true;
      return;
    }
    progress.setValue(0);
    const run = Animated.timing(progress, { toValue: 1, duration: APPEAR.in, easing: ARRIVE, useNativeDriver: true });
    run.start();
    return () => {
      run.stop();
      // A tab left mid-fade must not come back half transparent.
      progress.setValue(1);
    };
  }, [focused, progress]);

  return <Animated.View testID="tab-arrive" style={[styles.fill, { opacity: progress }]}>{children}</Animated.View>;
}

/** Tests only. */
export function resetTabArriveForTests(): void {
  shownOnce = false;
}

const styles = StyleSheet.create({ fill: { flex: 1 } });
