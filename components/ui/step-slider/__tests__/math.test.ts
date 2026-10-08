import { ratioToValue, valueToRatio, xToRatio } from '../math';

describe('step-slider math', () => {
    it('places a value along the track, off-step values included', () => {
        expect(valueToRatio(0.1, 0.1, 1)).toBe(0);
        expect(valueToRatio(1, 0.1, 1)).toBe(1);
        expect(valueToRatio(0.35, 0.1, 1)).toBeCloseTo(0.25 / 0.9);
        expect(valueToRatio(5, 0.1, 1)).toBe(1);
    });

    it('snaps a ratio to the nearest step, without float noise', () => {
        expect(ratioToValue(0, 0.1, 1, 0.1)).toBe(0.1);
        expect(ratioToValue(1, 0.1, 1, 0.1)).toBe(1);
        expect(ratioToValue(0.5, 0.1, 1, 0.1)).toBe(0.6); // 0.55 rounds up
        expect(ratioToValue(2 / 9, 0.1, 1, 0.1)).toBe(0.3);
        expect(ratioToValue(-1, 0.1, 1, 0.1)).toBe(0.1);
    });

    it('reads a touch from the start edge, mirrored in RTL', () => {
        expect(xToRatio(75, 300, false)).toBe(0.25);
        expect(xToRatio(75, 300, true)).toBe(0.75);
        expect(xToRatio(-20, 300, false)).toBe(0);
        expect(xToRatio(10, 0, false)).toBe(0);
    });
});
