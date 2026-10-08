/**
 * How far to lift a bottom-anchored view above the keyboard. Same rule as the
 * floating chat panel (ChatPopover): `useReanimatedKeyboardAnimation().height`
 * is NEGATIVE while the keyboard shows, and the safe-area inset the screen
 * already pads is subtracted so it is not counted twice.
 */
export function keyboardLift(keyboardHeightValue: number, bottomInset: number): number {
  'worklet';
  return Math.max(0, -keyboardHeightValue - bottomInset);
}
