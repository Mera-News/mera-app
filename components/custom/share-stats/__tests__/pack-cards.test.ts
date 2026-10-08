import { packStatCards } from '../pack-cards';

describe('packStatCards', () => {
    it('puts everything on one image when it fits', () => {
        expect(packStatCards([100, 120, 90], 400, 18)).toEqual([[0, 1, 2]]);
    });

    it('packs all 7 Stats (5 rows) onto 2 images by choosing which rows share one', () => {
        // Publications 99, Languages 125, Days 189, Opened|How fresh 77,
        // Right now|Most opened 139, against ~356 under the reserves. Pick
        // order would need 3; best fit needs 2.
        const rows = [99, 125, 189, 77, 139];
        const images = packStatCards(rows, 356, 14);
        expect(images).toHaveLength(2);
        for (const img of images) {
            const h = img.reduce((s, r) => s + rows[r], 0) + 14 * (img.length - 1);
            expect(h).toBeLessThanOrEqual(356);
        }
        expect(images).toEqual([
            [0, 1, 3],
            [2, 4],
        ]);
    });

    it('prefers the most even split among the fewest images', () => {
        // [0,1] + [2,3] (200/200) beats [0,1,2] + [3] (300/100).
        expect(packStatCards([100, 100, 100, 100], 330, 0)).toEqual([
            [0, 1],
            [2, 3],
        ]);
    });

    it('keeps page order inside each image and never splits a row', () => {
        for (const img of packStatCards([300, 50, 250, 40], 360, 10)) {
            expect([...img].sort((a, b) => a - b)).toEqual(img);
        }
    });

    it('gives a row taller than an image its own image', () => {
        expect(packStatCards([500, 100, 100], 400, 0)).toEqual([[0], [1, 2]]);
    });

    it('returns nothing for nothing picked', () => {
        expect(packStatCards([], 400, 0)).toEqual([]);
    });
});
