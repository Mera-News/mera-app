// The slider's position ↔ value math. Pure and import-free: worklets and jest.

const clamp01 = (n: number) => {
    'worklet';
    return Math.min(1, Math.max(0, n));
};

/** Where a value sits along the track, 0..1 (an off-step value stays put). */
export function valueToRatio(value: number, min: number, max: number): number {
    'worklet';
    return max > min ? clamp01((value - min) / (max - min)) : 0;
}

/** The step a ratio lands on, rounded to the step's own precision. */
export function ratioToValue(ratio: number, min: number, max: number, step: number): number {
    'worklet';
    const raw = min + clamp01(ratio) * (max - min);
    const snapped = Math.round((raw - min) / step) * step + min;
    const decimals = Math.max(0, -Math.floor(Math.log10(step)));
    const p = Math.pow(10, decimals);
    return Math.min(max, Math.max(min, Math.round(snapped * p) / p));
}

/** A touch's x on a track of `width`, as a ratio; mirrored in right-to-left. */
export function xToRatio(x: number, width: number, rtl: boolean): number {
    'worklet';
    const r = width > 0 ? clamp01(x / width) : 0;
    return rtl ? 1 - r : r;
}
