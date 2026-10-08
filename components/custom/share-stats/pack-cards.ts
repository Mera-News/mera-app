// Packs the picked Stats onto as few share images as their MEASURED heights
// allow (owner): order kept and a unit never split across images. Each image
// is filled greedily, so an image with room for the next unit takes it; then,
// if the last image would be under half full, the last two are balanced, so
// there is never a full image beside a lonely one. RN-free.

/** The height a run of units takes: their heights plus a gap between each. */
function runHeight(heights: readonly number[], from: number, to: number, gap: number): number {
    let h = 0;
    for (let i = from; i < to; i++) h += heights[i];
    return h + gap * Math.max(0, to - from - 1);
}

/**
 * Group unit indices 0..n-1 into contiguous runs that fit `capacity`. A unit
 * taller than `capacity` on its own still gets its own run.
 */
export function packStatCards(heights: readonly number[], capacity: number, gap: number): number[][] {
    const n = heights.length;
    if (n === 0) return [];
    // Greedy: each run takes units while the next one still fits.
    const cuts: number[] = [0];
    let start = 0;
    for (let i = 1; i <= n; i++) {
        if (i === n || runHeight(heights, start, i + 1, gap) > capacity) {
            cuts.push(i);
            start = i;
        }
    }
    // Balance the last two when the last is under half full: the split of
    // their units whose taller side is smallest, both sides fitting.
    const runs = cuts.length - 1;
    if (runs >= 2) {
        const a = cuts[runs - 2];
        const end = cuts[runs];
        if (runHeight(heights, cuts[runs - 1], end, gap) < capacity / 2) {
            let bestCut = cuts[runs - 1];
            let bestTallest = Infinity;
            for (let c = a + 1; c < end; c++) {
                const left = runHeight(heights, a, c, gap);
                const right = runHeight(heights, c, end, gap);
                if ((left > capacity && c - a > 1) || (right > capacity && end - c > 1)) continue;
                const tallest = Math.max(left, right);
                if (tallest < bestTallest) {
                    bestTallest = tallest;
                    bestCut = c;
                }
            }
            cuts[runs - 1] = bestCut;
        }
    }
    const groups: number[][] = [];
    for (let r = 0; r < cuts.length - 1; r++) {
        groups.push(Array.from({ length: cuts[r + 1] - cuts[r] }, (_, x) => cuts[r] + x));
    }
    return groups;
}
