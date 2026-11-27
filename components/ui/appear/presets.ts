// The same enter and exit as <Appear>, for views already driven by Reanimated (`entering` and
// `exiting` props).
//
// `ReduceMotion.Never` is deliberate and belongs only here: Lite mounts Reanimated's reduced-motion
// switch at the root, which would otherwise land these fades at once (owner: Lite keeps fades).
// Every library call sits inside the worklet, so a test's cut-down Reanimated mock still loads this.
// The curve is tokens.ts's ARRIVE_BEZIER, written out because a worklet cannot spread a tuple.
import { useMemo } from 'react';
import { Easing, ReduceMotion, withDelay, withTiming } from 'react-native-reanimated';
import { useMotionAllowed } from '@/lib/motion-gate';
import { APPEAR } from './tokens';

interface EnterOpts {
  rise?: number;
  delay?: number;
}

/** `entering`: fade in, rising `rise` points when `moves`. */
export function appearEntering(moves: boolean, opts: EnterOpts = {}) {
  const rise = moves ? opts.rise ?? APPEAR.rise : 0;
  const delay = opts.delay ?? 0;
  const duration = APPEAR.in;
  return () => {
    'worklet';
    const config = { duration, easing: Easing.bezier(0.33, 1, 0.68, 1), reduceMotion: ReduceMotion.Never };
    return {
      initialValues: { opacity: 0, transform: [{ translateY: rise }] },
      animations: {
        opacity: withDelay(delay, withTiming(1, config)),
        transform: [{ translateY: withDelay(delay, withTiming(0, config)) }],
      },
    };
  };
}

const OUT = APPEAR.out;

/** `exiting`: fade out in place. */
export function appearExiting() {
  'worklet';
  return {
    initialValues: { opacity: 1 },
    animations: {
      opacity: withTiming(0, { duration: OUT, easing: Easing.in(Easing.cubic), reduceMotion: ReduceMotion.Never }),
    },
  };
}

/** The `entering` for this reader: a rise where movement is allowed, a fade in place otherwise. */
export function useAppearEntering(opts: EnterOpts = {}) {
  const moves = useMotionAllowed();
  const { rise, delay } = opts;
  return useMemo(() => appearEntering(moves, { rise, delay }), [moves, rise, delay]);
}
