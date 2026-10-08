// Packs the picked Stats onto as few share images as their MEASURED heights
// allow (owner). The packer chooses which rows share an image (best fit, not
// pick order): the fewest images, then the most even split (the smallest
// tallest image), a row never split. Inside each image rows keep page order.
// A handful of rows (7 figures make at most 7), so an exhaustive search over
// the ways to group them is instant. RN-free.

/** An image's height: its rows plus a gap between each. */
function imageHeight(heights: readonly number[], rows: readonly number[], gap: number): number {
    let h = 0;
    for (const r of rows) h += heights[r];
    return h + gap * Math.max(0, rows.length - 1);
}

/**
 * Group row indices 0..n-1 into images that each fit `capacity`. A row taller
 * than `capacity` on its own still gets its own image. Images come out in the
 * order of their first row, rows ascending inside each.
 */
export function packStatCards(heights: readonly number[], capacity: number, gap: number): number[][] {
    const n = heights.length;
    if (n === 0) return [];
    let best: number[][] | null = null;
    let bestTallest = Infinity;
    const bins: number[][] = [];
    const fits = (rows: number[]) => rows.length === 1 || imageHeight(heights, rows, gap) <= capacity;

    // Each row joins an existing image or opens the next one (canonical order,
    // so no grouping is visited twice).
    const place = (i: number) => {
        if (best && bins.length > best.length) return;
        if (i === n) {
            const tallest = Math.max(...bins.map((b) => imageHeight(heights, b, gap)));
            if (!best || bins.length < best.length || tallest < bestTallest) {
                best = bins.map((b) => [...b]);
                bestTallest = tallest;
            }
            return;
        }
        for (const bin of bins) {
            bin.push(i);
            if (fits(bin)) place(i + 1);
            bin.pop();
        }
        bins.push([i]);
        place(i + 1);
        bins.pop();
    };
    place(0);
    return best ?? heights.map((_, i) => [i]);
}
