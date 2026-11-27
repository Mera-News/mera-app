// The enter and exit timings every appearing object shares. Numbers only, so both this kit
// (React Native's Animated) and the Reanimated presets beside it read one table, and a file that
// imports it pulls in no animation library.
export const APPEAR = {
  /** Arriving: fade in, with a small rise where movement is allowed. */
  in: 220,
  /** Leaving: about 30% faster than arriving, fade only. */
  out: 150,
  /** How far an arriving object rises, in points. */
  rise: 8,
} as const;

/**
 * cubic-bezier(0.33, 1, 0.68, 1), an ease-out cubic. Gentler than lib/motion.ts's arrive curve on
 * purpose: that one is nine tenths done in a third of its time, which suits movement but makes an
 * opacity fade read as a cut.
 */
export const ARRIVE_BEZIER = [0.33, 1, 0.68, 1] as const;
