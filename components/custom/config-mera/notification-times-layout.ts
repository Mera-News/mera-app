// Side by side (Selected | wheel | 24h-AM/PM) or stacked (Selected and the
// toggle in one row above a full-width wheel). Pure, so the decision is tested.

/** The wheel column: a 44pt cell plus its margin. */
export const WHEEL_WIDTH = 64;
/** The row's own side padding (each side). */
export const TIMES_SIDE_PAD = 14;
/** Air kept between a side column's content and its edges. */
const COLUMN_AIR = 8;

export type TimesLayout = 'side' | 'stacked';

/**
 * Side by side only while the wider of the label and the toggle fits its
 * column: each side column gets half of what the wheel leaves. Unmeasured
 * (a zero width) stays side by side, the default-size layout.
 */
export function timesLayout(available: number, labelWidth: number, toggleWidth: number): TimesLayout {
    if (available <= 0 || (labelWidth <= 0 && toggleWidth <= 0)) return 'side';
    const column = (available - 2 * TIMES_SIDE_PAD - WHEEL_WIDTH) / 2 - COLUMN_AIR;
    return Math.max(labelWidth, toggleWidth) <= column ? 'side' : 'stacked';
}
