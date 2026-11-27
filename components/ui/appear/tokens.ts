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

/** cubic-bezier(0.16, 1, 0.3, 1): the arrive curve of lib/motion.ts, as plain numbers. */
export const ARRIVE_BEZIER = [0.16, 1, 0.3, 1] as const;
