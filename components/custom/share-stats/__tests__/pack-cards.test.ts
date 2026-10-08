import { packStatCards } from '../pack-cards';

describe('packStatCards', () => {
    it('puts everything on one image when it fits', () => {
        expect(packStatCards([100, 120, 90], 400, 18)).toEqual([[0, 1, 2]]);
    });

    it('an image with room for the next unit takes it (greedy)', () => {
        // 100 + 10 + 100 + 10 + 100 = 320 fits 330, so the third joins the first image.
        expect(packStatCards([100, 100, 100, 300], 330, 10)).toEqual([[0, 1, 2], [3]]);
    });

    it('balances the last two when the last would be under half full', () => {
        // Greedy gives [0,1,2] (320) + [3] (100 < 165): rebalanced to 2 + 2.
        expect(packStatCards([100, 100, 100, 100], 330, 10)).toEqual([
            [0, 1],
            [2, 3],
        ]);
    });

    it('keeps the greedy split when the last image is at least half full', () => {
        expect(packStatCards([100, 100, 100, 200], 330, 10)).toEqual([[0, 1, 2], [3]]);
    });

    it('keeps order and never splits a unit', () => {
        expect(packStatCards([300, 50, 250], 360, 10)).toEqual([[0, 1], [2]]);
    });

    it('gives a unit taller than an image its own image', () => {
        expect(packStatCards([500, 100, 100], 400, 0)).toEqual([[0], [1, 2]]);
    });

    it('returns nothing for nothing picked', () => {
        expect(packStatCards([], 400, 0)).toEqual([]);
    });
});
