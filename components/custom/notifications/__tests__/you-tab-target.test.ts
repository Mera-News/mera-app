import { youTabTarget } from '../you-tab-target';

describe('youTabTarget', () => {
    it('is the centre of the last tab, above the inset', () => {
        expect(youTabTarget(400, 800, 34, 49, false)).toEqual({ x: 350, y: 800 - 34 - 24.5 });
    });

    it('mirrors to the first tab in RTL', () => {
        expect(youTabTarget(400, 800, 34, 49, true).x).toBe(50);
    });
});
