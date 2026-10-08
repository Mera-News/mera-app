// The header track's ONE selected fill: where it sits for a fractional page
// index. Tap and swipe share it: the pager's progress (0 = first page, 1.5 =
// halfway between the second and third) drives x and width between the two
// options it falls between, measured, never hard-coded. RN-free and a worklet,
// so it runs per frame on the UI thread.

export interface OptionBox {
    readonly x: number;
    readonly width: number;
}

/** The fill's box at `progress`, or null until every option is measured. */
export function fillAt(progress: number, boxes: readonly (OptionBox | null)[]): OptionBox | null {
    'worklet';
    const n = boxes.length;
    if (n === 0) return null;
    for (let i = 0; i < n; i++) if (!boxes[i]) return null;
    const p = Math.min(Math.max(progress, 0), n - 1);
    const i = Math.floor(p);
    const t = p - i;
    const a = boxes[i] as OptionBox;
    if (t === 0 || i + 1 >= n) return { x: a.x, width: a.width };
    const b = boxes[i + 1] as OptionBox;
    return { x: a.x + (b.x - a.x) * t, width: a.width + (b.width - a.width) * t };
}

/** The fill between two layouts of the same options: `from` (before a label
 *  went in or out) eased onto `to` by `t` (0..1). Either missing: the other. */
export function settleFill(from: OptionBox | null, to: OptionBox | null, t: number): OptionBox | null {
    'worklet';
    if (!to || !from || t >= 1) return to;
    return { x: from.x + (to.x - from.x) * t, width: from.width + (to.width - from.width) * t };
}
