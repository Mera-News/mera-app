import { originTransform } from '../origin';

const card = { cx: 200, cy: 400, width: 360, height: 300 };
const help = { x: 300, y: 80, width: 44, height: 44 }; // centre (322, 102)

describe('originTransform', () => {
    it('at 0 sits on the "?": centred on it, at its size, invisible', () => {
        const f = originTransform(help, card, 0);
        expect(f.translateX).toBe(122);
        expect(f.translateY).toBe(-298);
        expect(f.scale).toBeCloseTo(44 / 300);
        expect(f.opacity).toBe(0);
    });

    it('at 1 is the centred card, full size and opaque', () => {
        const f = originTransform(help, card, 1);
        expect(f.translateX).toBeCloseTo(0);
        expect(f.translateY).toBeCloseTo(0);
        expect(f).toMatchObject({ scale: 1, opacity: 1 });
    });

    it('travels linearly and is opaque from 35%', () => {
        const f = originTransform(help, card, 0.5);
        expect(f.translateX).toBe(61);
        expect(f.translateY).toBe(-149);
        expect(f.opacity).toBe(1);
        expect(originTransform(help, card, 0.175).opacity).toBeCloseTo(0.5);
    });

    it('without an origin only fades and scales from 0.96', () => {
        expect(originTransform(null, card, 0)).toEqual({ translateX: 0, translateY: 0, scale: 0.96, opacity: 0 });
        expect(originTransform(null, card, 1)).toEqual({ translateX: 0, translateY: 0, scale: 1, opacity: 1 });
    });

    it('treats an unmeasured card as no origin, and clamps progress', () => {
        expect(originTransform(help, { ...card, width: 0 }, 0.5).translateX).toBe(0);
        expect(originTransform(help, card, 2)).toMatchObject({ scale: 1, opacity: 1 });
        expect(originTransform(help, card, -1).opacity).toBe(0);
    });
});
