import React from 'react';
import { MIN_FONT_SIZE_PX, TYPE_SCALE, type TypeToken } from './scale';

/**
 * The user's in-app text scale, delivered by context rather than by a store
 * subscription.
 *
 * WHY CONTEXT: `components/ui/text` renders on the order of a hundred nodes per
 * screen and every one of them needs this value. A Zustand selector per `<Text>`
 * means a subscription per `<Text>`; `useContext` is a single read with no
 * bookkeeping, and React already propagates it efficiently.
 *
 * WHY THIS FILE HOLDS NO STORE IMPORT: the store reads the settings table, which
 * imports the WatermelonDB singleton, which instantiates a `SQLiteAdapter` at
 * module scope. Importing it here would put the whole database on the import
 * graph of every `<Text>` in the app — and it did, breaking four unrelated test
 * suites with `Cannot read properties of undefined (reading 'initializeJSI')`
 * the moment they rendered any text. The provider lives in
 * `./TextScaleProvider.tsx` and is imported ONLY by the app root.
 *
 * The default is `1`, so a `<Text>` rendered with no provider above it — every
 * unit test, and any tree mounted outside the app root — behaves exactly as it
 * did before this control existed.
 */
export const TextScaleContext = React.createContext<number>(1);

export function useTextScale(): number {
  return React.useContext(TextScaleContext);
}

/**
 * The inline style that applies `scale` to a type token, or `undefined` when
 * there is nothing to do.
 *
 * Returning `undefined` at scale 1 is load-bearing, not an optimisation: it
 * means an explicit choice of 1x — or never having opened the text-size
 * control on a device wide enough to default to 1x — adds NO inline style to
 * any text node, so class-driven styling stays byte-identical to what shipped
 * before this feature existed.
 *
 * That is no longer true unconditionally, though. `text-scale-store` derives
 * the UNSET default from screen width (`defaultTextScaleForWidth`), so a
 * narrow-screen reader who has never touched the control gets `0.9` and DOES
 * receive an inline style here — never having opted in. This is intentional
 * (1x is genuinely harder to read on a small screen) but it means "no
 * provider opinion" and "byte-identical to pre-feature" are no longer the
 * same claim. Don't reintroduce a comment that says they are.
 *
 * `fontSize` is floored at `MIN_FONT_SIZE_PX` so the smallest step can never
 * push the smallest token below the platform's own minimum readable size;
 * `lineHeight` is scaled by the factor the font size ACTUALLY received, so a
 * floored size keeps its leading ratio instead of being crushed.
 */
export function scaledTypeStyle(
  token: TypeToken,
  scale: number,
): { fontSize: number; lineHeight: number } | undefined {
  if (scale === 1) return undefined;
  const step = TYPE_SCALE[token];
  if (!step) return undefined;
  const fontSize = Math.max(MIN_FONT_SIZE_PX, Math.round(step.fontSize * scale));
  const applied = fontSize / step.fontSize;
  return { fontSize, lineHeight: Math.round(step.lineHeight * applied) };
}
