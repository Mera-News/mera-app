// A film's clock, in ms. Pure: the app player, the video export and the
// soundtrack all read the same numbers, so a cut never drifts off the music.
//
// Every scene lasts a whole number of beats at BPM, so every cut lands on a
// beat. A scene is long enough for its copy at 0.3 s a word after it settles
// (the scene files say how many beats; `minBeatsFor` is the check).

export const BPM = 100;
export const BEAT_MS = 60000 / BPM;
/** Content fades in over the first FADE_MS of a scene and out over its last. */
export const FADE_MS = 250;
/** When a scene's caption is fully on screen. */
export const SETTLE_MS = 600;

export interface SceneSpan {
    readonly id: string;
    readonly start: number;
    readonly end: number;
}

export function layout(scenes: readonly { readonly id: string; readonly beats: number }[]): SceneSpan[] {
    let at = 0;
    return scenes.map(({ id, beats }) => {
        const span = { id, start: at, end: at + beats * BEAT_MS };
        at = span.end;
        return span;
    });
}

export const totalMs = (spans: readonly SceneSpan[]): number => spans[spans.length - 1]?.end ?? 0;

/** The fewest beats that hold `words` words readable after the caption settles. */
export function minBeatsFor(words: number): number {
    return Math.ceil((SETTLE_MS + words * 300 + FADE_MS) / BEAT_MS);
}

export const wordCount = (...lines: string[]): number =>
    lines.join(' ').split(/\s+/).filter(Boolean).length;

/**
 * An eased 0 -> 1 ramp from `at` over `dur`, as an Animated interpolation
 * config. The native driver takes no `easing`, so the ease-out curve is sampled
 * into the ranges instead.
 */
export function ramp(at: number, dur = 300): { inputRange: number[]; outputRange: number[] } {
    const steps = [0, 0.25, 0.5, 0.75, 1];
    return {
        inputRange: steps.map((s) => at + s * dur),
        outputRange: steps.map((s) => 1 - (1 - s) ** 3),
    };
}
