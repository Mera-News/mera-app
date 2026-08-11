// use-pulse — a shared looping glow-opacity animation, gated on
// `useAnimationsActive()` (focus + foreground) so it never keeps animating on
// a blurred or backgrounded screen.
//
// Extracted from two byte-identical 17-line `Animated.loop` blocks
// (AdvancedHubScreen's refresh-suggestions glow and PersonaL1MeraProtocol's —
// both ring an affordance the user should notice) once a third call site
// needed the exact same loop (the priority-filter chip pulse in
// ImportanceFilterDropdown, r14). Three copies is the named friction; see
// CLAUDE.md's Design Pattern Guidelines.

import { useEffect, useRef } from 'react';
import { Animated } from 'react-native';
import { useAnimationsActive } from './use-is-focused-safe';

export interface UsePulseOptions {
  /**
   * Opacity to park at while `active` is true but the animation itself is
   * gated off (screen blurred/backgrounded). Both original call sites park at
   * 0.3 rather than 0 — 0 is fully transparent, so a blurred screen used to
   * come back with the affordance invisible until the next trigger restarted
   * the loop. A transient pulse (e.g. the priority-chip nudge, which turns
   * itself off after a few seconds) should pass 0 instead, since there is no
   * "still pending" state to keep visible. Default 0.3, matching the two
   * pre-existing call sites this was extracted from.
   */
  restWhenActive?: number;
  /** Loop leg duration in ms, each way. Default 800, matching every existing
   *  call site — change only with a reason, since a mismatched pulse next to
   *  an unmodified one would read as two different affordances. */
  durationMs?: number;
}

/**
 * `active` toggles the loop on/off. Returns an `Animated.Value` (0..1) meant
 * for `opacity` on an absolutely-positioned glow ring/overlay around the
 * target — see the three call sites for the exact style shape.
 */
export function usePulse(active: boolean, options: UsePulseOptions = {}): Animated.Value {
  const { restWhenActive = 0.3, durationMs = 800 } = options;
  const anim = useRef(new Animated.Value(restWhenActive)).current;
  const animationsActive = useAnimationsActive();

  useEffect(() => {
    if (active && animationsActive) {
      const animation = Animated.loop(
        Animated.sequence([
          Animated.timing(anim, { toValue: 1, duration: durationMs, useNativeDriver: true }),
          Animated.timing(anim, { toValue: restWhenActive, duration: durationMs, useNativeDriver: true }),
        ]),
      );
      animation.start();
      return () => animation.stop();
    }
    anim.stopAnimation();
    // Park at the resting value while still `active` (just off-focus/background)
    // so the affordance stays visible rather than going fully transparent until
    // something restarts the loop; fully transparent once truly inactive.
    anim.setValue(active ? restWhenActive : 0);
    return undefined;
  }, [active, animationsActive, anim, restWhenActive, durationMs]);

  return anim;
}
