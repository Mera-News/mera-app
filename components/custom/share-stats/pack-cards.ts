// Packs the picked Stats onto as few share images as their MEASURED heights
// allow (owner): order kept, a figure never split across images, and when it
// takes more than one image the split is the most even one, so there is never
// a full image beside a lonely one. RN-free.

/** The height a run of blocks takes: their heights plus a gap between each. */
function runHeight(heights: readonly number[], from: number, to: number, gap: number): number {
    let h = 0;
    for (let i = from; i < to; i++) h += heights[i];
    return h + gap * Math.max(0, to - from - 1);
}

/**
 * Group indices 0..n-1 into contiguous runs. The fewest runs where every run
 * fits `capacity`; among those, the split whose tallest run is smallest. A
 * block taller than `capacity` on its own still gets its own run.
 */
export function packStatCards(heights: readonly number[], capacity: number, gap: number): number[][] {
    const n = heights.length;
    if (n === 0) return [];
    // best[i][k]: the smallest possible tallest run when blocks i..n-1 are cut
    // into k runs (Infinity when impossible), and cut[i][k] the first run's end.
    const best: number[][] = Array.from({ length: n + 1 }, () => Array(n + 1).fill(Infinity));
    const cut: number[][] = Array.from({ length: n + 1 }, () => Array(n + 1).fill(-1));
    best[n][0] = 0;
    for (let i = n - 1; i >= 0; i--) {
        for (let k = 1; k <= n - i; k++) {
            for (let j = i + 1; j <= n; j++) {
                const h = runHeight(heights, i, j, gap);
                // A run longer than one block must fit; a lone block always may.
                if (h > capacity && j - i > 1) break;
                const tallest = Math.max(h, best[j][k - 1]);
                if (tallest < best[i][k]) {
                    best[i][k] = tallest;
                    cut[i][k] = j;
                }
            }
        }
    }
    for (let k = 1; k <= n; k++) {
        if (best[0][k] === Infinity) continue;
        const groups: number[][] = [];
        let i = 0;
        for (let left = k; left > 0; left--) {
            const j = cut[i][left];
            groups.push(Array.from({ length: j - i }, (_, x) => i + x));
            i = j;
        }
        return groups;
    }
    return heights.map((_, i) => [i]);
}
