import { timesLayout } from '../notification-times-layout';

describe('timesLayout', () => {
    // 375pt row: (375 - 28 - 64) / 2 - 8 = 133.5pt per side column.
    it('stays side by side while the label and the toggle fit their columns', () => {
        expect(timesLayout(375, 60, 110)).toBe('side');
        expect(timesLayout(375, 133, 133)).toBe('side');
    });

    it('stacks when either one outgrows its column (large text)', () => {
        expect(timesLayout(375, 140, 110)).toBe('stacked');
        expect(timesLayout(375, 60, 180)).toBe('stacked');
        expect(timesLayout(320, 60, 120)).toBe('stacked');
    });

    it('stays side by side until measured', () => {
        expect(timesLayout(0, 200, 200)).toBe('side');
        expect(timesLayout(375, 0, 0)).toBe('side');
    });
});
