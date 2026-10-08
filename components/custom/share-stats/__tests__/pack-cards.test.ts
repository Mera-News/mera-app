import { packStatCards } from '../pack-cards';

describe('packStatCards', () => {
    it('puts everything on one image when it fits', () => {
        expect(packStatCards([100, 120, 90], 400, 18)).toEqual([[0, 1, 2]]);
    });

    it('uses a second image only when one is too tall, and splits it evenly', () => {
        // 6 x 100 + 5 gaps = 650 > 400; 3 + 3 (336 each) beats 4 + 2 (454, too tall) and 2 + 4.
        expect(packStatCards([100, 100, 100, 100, 100, 100], 400, 12)).toEqual([
            [0, 1, 2],
            [3, 4, 5],
        ]);
    });

    it('never leaves a full image beside a lonely one', () => {
        // Greedy would pack 0-2 (300) and leave 3 alone; even is 0-1 + 2-3.
        expect(packStatCards([100, 100, 100, 100], 320, 0)).toEqual([
            [0, 1],
            [2, 3],
        ]);
    });

    it('keeps order and never splits a figure', () => {
        expect(packStatCards([300, 50, 250], 360, 10)).toEqual([[0], [1, 2]]);
    });

    it('gives a block taller than an image its own image', () => {
        expect(packStatCards([500, 100, 100], 400, 0)).toEqual([[0], [1, 2]]);
    });

    it('returns nothing for nothing picked', () => {
        expect(packStatCards([], 400, 0)).toEqual([]);
    });
});
