// THE motion gate. Owner rule: Lite = no motion at all (no animations, no
// transitions, no loops), and Reduce Motion keeps its own fades-not-moves rule
// on top. Everything that moves asks here.
//
// Kept out of lib/motion.ts on purpose: that file is imported by ~30
// components; this one pulls the display-prefs store (AsyncStorage,
// expo-device), which would drag into every one of their suites. And it
// imports NO Reanimated (its native half does not load in jest), so a screen
// that only gates a Modal or a stack transition stays testable.
//
// Three layers, each closing the gap the one before leaves:
//  1. <LiteMotionConfig /> (app/_layout.tsx) at the root: Reanimated's own reduce-motion switch,
//     forced on in Lite, so every withTiming / withSpring / withRepeat and
//     every entering / exiting / layout animation that keeps the default
//     ReduceMotion.System lands at once. Live: animations STARTED after the
//     toggle obey it; one already running keeps the setting it started with.
//  2. useMotionAllowed() for everything that config does not reach: running
//     loops (put it in the loop effect's deps, cancel and park on a still
//     frame when false), RN Animated, LayoutAnimation, Lottie, Legend Motion,
//     RN Modal animationType and stack transitions.
//  3. motionAllowed(), the same rule outside React. A worklet cannot read it;
//     capture the hook's boolean in the worklet's closure instead.

import { useDisplayPrefsStore } from '@/lib/stores/display-prefs-store';

/** Pure rule, for tests and callers that already hold both inputs. */
export function isMotionAllowed(lite: boolean, systemReduceMotion: boolean): boolean {
    return !lite && !systemReduceMotion;
}

/**
 * The system Reduce Motion setting as Reanimated sees it: the flag its native
 * side installs at launch, which is all its `useReducedMotion` returns
 * (src/ReducedMotion.ts). Read directly so this file needs no Reanimated
 * import. A change needs a relaunch to reach this gate, as it does for
 * Reanimated itself.
 */
function systemReduceMotion(): boolean {
    return (globalThis as { _REANIMATED_IS_REDUCED_MOTION?: boolean })._REANIMATED_IS_REDUCED_MOTION === true;
}

/** The gate outside React (an imperative call, a module-level helper). */
export function motionAllowed(): boolean {
    return isMotionAllowed(useDisplayPrefsStore.getState().liteMode, systemReduceMotion());
}

/** The gate in a component. Re-renders when Lite is switched. */
export function useMotionAllowed(): boolean {
    const lite = useDisplayPrefsStore((s) => s.liteMode);
    return isMotionAllowed(lite, systemReduceMotion());
}
