import { fillAt, settleFill } from '../fill';

const boxes = [
    { x: 4, width: 40 },
    { x: 44, width: 100 },
    { x: 144, width: 40 },
];

describe('fillAt', () => {
    it('sits exactly on the option at a whole index', () => {
        expect(fillAt(0, boxes)).toEqual({ x: 4, width: 40 });
        expect(fillAt(2, boxes)).toEqual({ x: 144, width: 40 });
    });

    it('interpolates x and width between the two options it falls between', () => {
        expect(fillAt(0.5, boxes)).toEqual({ x: 24, width: 70 });
        expect(fillAt(1.25, boxes)).toEqual({ x: 69, width: 85 });
    });

    it('clamps past the ends (the edge spring overshoots)', () => {
        expect(fillAt(-0.3, boxes)).toEqual({ x: 4, width: 40 });
        expect(fillAt(2.4, boxes)).toEqual({ x: 144, width: 40 });
    });

    it('waits until every option is measured', () => {
        expect(fillAt(1, [boxes[0], null, boxes[2]])).toBeNull();
        expect(fillAt(0, [])).toBeNull();
    });
});

describe('settleFill', () => {
    const from = { x: 4, width: 40 };
    const to = { x: 20, width: 80 };
    it('eases from the old layout onto the new one', () => {
        expect(settleFill(from, to, 0)).toEqual(from);
        expect(settleFill(from, to, 0.5)).toEqual({ x: 12, width: 60 });
        expect(settleFill(from, to, 1)).toBe(to);
    });
    it('falls back to the new layout when the old one is unknown', () => {
        expect(settleFill(null, to, 0.3)).toBe(to);
        expect(settleFill(from, null, 0.3)).toBeNull();
    });
});
