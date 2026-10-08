// The help card's geometry against the "?" it grows out of. Pure and
// import-free so it runs as a worklet and in jest alike.

export interface Rect {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
}

export interface CardBox {
    /** The card's centre when fully open (the window's centre). */
    readonly cx: number;
    readonly cy: number;
    readonly width: number;
    readonly height: number;
}

export interface CardFrame {
    readonly translateX: number;
    readonly translateY: number;
    readonly scale: number;
    readonly opacity: number;
}

/** No origin to grow from: the small-modal fade (FinalMotion). */
const FADE_FROM_SCALE = 0.96;
/** The card is fully opaque a third of the way out, as the chat panel. */
const OPAQUE_AT = 0.35;

/**
 * The card at progress `p` (0 = sitting on the "?", 1 = centred). It starts
 * centred on the origin at the origin's size and travels and scales to its
 * place: the Mera button → chat morph (ChatPopover), with the "?" as origin.
 * Without an origin (the "?" never measured, or gone) it only fades and
 * scales from 0.96.
 */
export function originTransform(origin: Rect | null, card: CardBox, p: number): CardFrame {
    'worklet';
    const t = Math.min(1, Math.max(0, p));
    if (!origin || card.width <= 0 || card.height <= 0) {
        return { translateX: 0, translateY: 0, scale: FADE_FROM_SCALE + (1 - FADE_FROM_SCALE) * t, opacity: t };
    }
    const ox = origin.x + origin.width / 2;
    const oy = origin.y + origin.height / 2;
    const from = Math.min(1, Math.max(origin.width / card.width, origin.height / card.height));
    return {
        translateX: (1 - t) * (ox - card.cx),
        translateY: (1 - t) * (oy - card.cy),
        scale: from + (1 - from) * t,
        opacity: Math.min(1, t / OPAQUE_AT),
    };
}
