'use client';
import { vars } from 'nativewind';

import { rawTokens } from './raw-tokens';

/** Re-exported so existing importers and tests keep one path to the tokens. */
export { rawTokens };

/**
 * The ONLY place raw RGB triples live.
 *
 * `rawTokens` holds the numbers; `config` holds the same numbers wrapped by
 * nativewind's `vars()`. `vars()` does not mutate its input, so both consumers
 * share one object and there is no second literal to drift from. The previous
 * attempt at light mode hand-mirrored the palette into a second file, and its
 * own comment admitted the copy would drift.
 *
 * DARK IS FROZEN. The dark block below is byte-identical to what shipped, and
 * `__tests__/raw-tokens.test.ts` pins it against a committed snapshot. Light
 * mode is additive: if a change to this file alters any dark value, that test
 * fails and the change is wrong. Only the light block may change.
 *
 * Every light value that carries text was audited against FOUR backdrops
 * (Parchment, raised, recessed, muted) rather than Parchment alone. The table
 * and the arithmetic live in `lib/theme/contrast-audit.ts`, which is executable
 * and asserted by `lib/theme/__tests__/contrast-audit.test.ts`.
 */

export const config = {
  light: vars(rawTokens.light),
  dark: vars(rawTokens.dark),
};
