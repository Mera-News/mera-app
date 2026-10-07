import { tint } from '../tint';

describe('tint', () => {
    it('turns hex into rgba at the alpha', () => {
        expect(tint('#E78A53', 0.14)).toBe('rgba(231,138,83,0.14)');
        expect(tint('#fff', 0.5)).toBe('rgba(255,255,255,0.5)');
    });
    it('replaces an rgb/rgba alpha rather than multiplying it', () => {
        expect(tint('rgb(233,179,83)', 0.2)).toBe('rgba(233,179,83,0.2)');
        expect(tint('rgba(255, 255, 255, 0.7)', 0.3)).toBe('rgba(255,255,255,0.3)');
    });
    it('clamps the alpha and leaves anything else alone', () => {
        expect(tint('#000000', 2)).toBe('rgba(0,0,0,1)');
        expect(tint('transparent', 0.5)).toBe('transparent');
    });
});
